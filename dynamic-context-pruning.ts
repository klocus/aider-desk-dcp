import { z } from 'zod';
import type {
  AgentProfile,
  AgentStartedEvent,
  CommandDefinition,
  ContextAssistantMessage,
  ContextMessage,
  ContextToolMessage,
  Extension,
  ExtensionContext,
  OptimizeMessagesEvent,
  ToolDefinition,
  ToolResultOutput,
  ToolResultPart
} from './extension-types';

// --- Constants ---

const PRUNED_ERROR_INPUT = '[DCP: input removed — failed tool call]';

/**
 * Tools whose outputs should never be pruned (blacklist approach).
 * Deduplication & error purging run on ALL tools except these.
 * Matches against the full tool name using substring checks.
 */
const PROTECTED_TOOL_PATTERNS = [
  // DCP's own tools
  'dcp-prune',
  'dcp-distill',
  // AiderDesk native tool groups — these should never be pruned as they manage core task state
  'tasks---',
  'todo---',
  'skills---',
  'memory---',
  'subagents---',
  // Aider code generation — unique creative output, not idempotent
  'run_prompt',
  // Aider context file management — tracks which files are in context
  'get_context_files',
  'add_context_files',
  'drop_context_files'
];

function isProtectedTool(name: string): boolean {
  return PROTECTED_TOOL_PATTERNS.some(p => name === p || name.includes(p));
}

const DCP_SYSTEM_HINT = [
  '',
  '## Context Management (DCP)',
  'You have context management tools available:',
  '- **dcp-prune** — Mark specific tool messages for pruning to free context space.',
  '- **dcp-distill** — Summarize findings from a message range, then prune all tool outputs in that range.',
  'Use these proactively when context grows large or after completing a research/exploration phase.'
].join('\n');

// --- Helpers ---

interface DistilledRange {
  startId: string;
  endId: string;
  summary: string;
}

interface ToolCallRef {
  input: unknown;
  msgIndex: number;
  partIndex: number;
}

/** Normalize and sort object keys for stable deduplication signatures */
function normalizeForSignature(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(normalizeForSignature);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    const v = (val as Record<string, unknown>)[key];
    if (v !== undefined && v !== null) sorted[key] = normalizeForSignature(v);
  }
  return sorted;
}

function toolSignature(toolName: string, input: unknown): string {
  if (input === undefined) return toolName;
  return `${toolName}::${JSON.stringify(normalizeForSignature(input))}`;
}

/** Detects tools that modify file contents or produce non-idempotent output */
function isWriteTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    // AiderDesk power tools
    n.includes('file_write') || // power---file_write
    n.includes('file_edit') || // power---file_edit
    // AiderDesk Aider tools
    n.includes('run_prompt') || // run_prompt — Aider code generation, not idempotent
    // Shell execution — not idempotent and has side effects, must never be deduped
    n.includes('bash') || // power---bash
    // Generic write patterns (MCP servers, other tools)
    n.includes('write_file') ||
    n.includes('edit_file') ||
    n.includes('create_file') ||
    n.includes('file_create') ||
    n.includes('replace_in_file') ||
    n.includes('replace_string') ||
    n.includes('apply_patch') ||
    n.includes('apply_diff') ||
    n.includes('insert_code') ||
    n.includes('multi_edit') ||
    n.includes('multiedit') ||
    n === 'write' ||
    n === 'edit'
  );
}

/** Detects tools that read file contents or search the filesystem */
function isReadTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    // AiderDesk power tools
    n.includes('file_read') || // power---file_read
    n.includes('grep') || // power---grep
    n.includes('glob') || // power---glob
    n.includes('semantic_search') || // power---semantic_search
    n.includes('fetch') || // power---fetch — reads web content
    // AiderDesk Aider tools
    n.includes('get_context_files') || // get_context_files — lists files in Aider context
    // Generic read/search patterns (MCP servers, other tools)
    n.includes('read_file') ||
    n.includes('search') || // also covers semantic_search, search_task etc.
    n.includes('find') ||
    n.includes('list_dir') ||
    n.includes('list_file') ||
    n.includes('cat') ||
    n.includes('view') ||
    n === 'read'
  );
}

function outputSize(output: ToolResultOutput): number {
  if (output.type === 'text' || output.type === 'error-text') return output.value.length;
  if (output.type === 'json' || output.type === 'error-json') return JSON.stringify(output.value).length;
  if (output.type === 'content') return JSON.stringify(output.value).length;
  return 0;
}

function extractPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const p = input.filePath ?? input.path ?? input.file ?? input.filePattern ?? input.pattern ?? input.filename;
  return typeof p === 'string' ? p : undefined;
}

// --- Extension ---

export default class DCPExtension implements Extension {
  static metadata = {
    name: 'Dynamic Context Pruning',
    version: '1.0.0',
    description: 'Automatically manages conversation context to optimize token usage',
    author: 'Paweł Klockiewicz',
    capabilities: ['tools', 'commands', 'events']
  };

  private stats = { prunedParts: 0, estimatedTokensSaved: 0 };
  private seenToolCallIds = new Set<string>();
  private manuallyPrunedIds = new Set<string>();
  private distilledRanges: DistilledRange[] = [];

  async onLoad(context: ExtensionContext): Promise<void> {
    context.log('DCP Extension loaded', 'info');
  }

  async onUnload(): Promise<void> {
    this.stats = { prunedParts: 0, estimatedTokensSaved: 0 };
    this.seenToolCallIds.clear();
    this.manuallyPrunedIds.clear();
    this.distilledRanges = [];
  }

  // --- Internal helpers ---

  /** Replace a single tool result part's output with a pruned placeholder. */
  private prunePart(part: ToolResultPart, reason: string): ToolResultPart {
    const alreadyPruned = part.output.type === 'text' && part.output.value.startsWith('[DCP:');
    if (alreadyPruned) return part;

    const placeholder = `[DCP: ${reason}]`;

    // Only count stats on first encounter
    if (!this.seenToolCallIds.has(part.toolCallId)) {
      this.seenToolCallIds.add(part.toolCallId);
      const saved = Math.max(0, Math.floor((outputSize(part.output) - placeholder.length) / 4));
      this.stats.estimatedTokensSaved += saved;
      this.stats.prunedParts++;
    }

    return { ...part, output: { type: 'text' as const, value: placeholder } };
  }

  /** Prune all parts in a tool message, respecting protected tools. */
  private pruneToolMessage(msg: ContextToolMessage, reason: string): { msg: ContextToolMessage; count: number } {
    let count = 0;
    const newContent = msg.content.map(part => {
      if (isProtectedTool(part.toolName)) return part;
      const pruned = this.prunePart(part, reason);
      if (pruned !== part) count++;
      return pruned;
    });
    return { msg: count > 0 ? { ...msg, content: newContent } : msg, count };
  }

  // --- Hooks ---

  /** Inject DCP system prompt hint when agent starts */
  async onAgentStarted(
    event: AgentStartedEvent,
    _context: ExtensionContext
  ): Promise<void | Partial<AgentStartedEvent>> {
    const current = event.systemPrompt ?? '';
    return { systemPrompt: current + DCP_SYSTEM_HINT };
  }

  /** Main pruning pass — runs before every LLM call */
  async onOptimizeMessages(
    event: OptimizeMessagesEvent,
    context: ExtensionContext
  ): Promise<void | Partial<OptimizeMessagesEvent>> {
    try {
      return this.runPruning(event, context);
    } catch (err) {
      context.log(`DCP: Error during pruning — ${err}`, 'error');
      return undefined;
    }
  }

  private runPruning(
    event: OptimizeMessagesEvent,
    context: ExtensionContext
  ): Partial<OptimizeMessagesEvent> | undefined {
    const messages: ContextMessage[] = [...event.optimizedMessages];
    let changed = false;
    const counts = { duplicate: 0, supersede: 0, error: 0, manual: 0, distill: 0 };
    const seenSizeBefore = this.seenToolCallIds.size;

    // --- Phase 0: Build tool call lookup from assistant messages ---
    const toolCalls = new Map<string, ToolCallRef>();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const parts = msg.content as { type: string; toolCallId?: string; input?: unknown }[];
        for (let j = 0; j < parts.length; j++) {
          const part = parts[j];
          if (part.type === 'tool-call' && part.toolCallId) {
            toolCalls.set(part.toolCallId, { input: part.input, msgIndex: i, partIndex: j });
          }
        }
      }
    }

    // --- Phase 1: Distillation ranges ---
    for (const range of this.distilledRanges) {
      let inRange = false;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.id === range.startId) inRange = true;
        if (inRange && msg.role === 'tool') {
          const { msg: pruned, count } = this.pruneToolMessage(
            msg as ContextToolMessage,
            `distilled — ${range.summary}`
          );
          if (count > 0) {
            messages[i] = pruned;
            counts.distill += count;
            changed = true;
          }
        }
        if (msg.id === range.endId) inRange = false;
      }
    }

    // --- Phase 2: Manual prunes ---
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'tool' && this.manuallyPrunedIds.has(msg.id)) {
        const { msg: pruned, count } = this.pruneToolMessage(msg as ContextToolMessage, 'manually pruned');
        if (count > 0) {
          messages[i] = pruned;
          counts.manual += count;
          changed = true;
        }
      }
    }

    // --- Phase 3: Deduplication — keep only the latest occurrence of identical tool calls ---
    const sigRegistry = new Map<string, { msgIndex: number; partIndex: number }>();
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== 'tool') continue;
      const toolMsg = messages[i] as ContextToolMessage;
      for (let j = 0; j < toolMsg.content.length; j++) {
        const part = toolMsg.content[j];
        if (part.output.type === 'text' && part.output.value.startsWith('[DCP:')) continue;
        if (isProtectedTool(part.toolName)) continue;
        // Don't dedup write/edit tools — same params doesn't mean same result (file may have changed)
        if (isWriteTool(part.toolName)) continue;

        const ref = toolCalls.get(part.toolCallId);
        const sig = toolSignature(part.toolName, ref?.input);
        const prev = sigRegistry.get(sig);

        if (prev) {
          const prevMsg = messages[prev.msgIndex] as ContextToolMessage;
          const prevPart = prevMsg.content[prev.partIndex];
          if (!(prevPart.output.type === 'text' && prevPart.output.value.startsWith('[DCP:'))) {
            const prunedPart = this.prunePart(prevPart, 'superseded by later identical call');
            if (prunedPart !== prevPart) {
              const newContent = [...prevMsg.content];
              newContent[prev.partIndex] = prunedPart;
              messages[prev.msgIndex] = { ...prevMsg, content: newContent };
              counts.duplicate++;
              changed = true;
            }
          }
        }
        sigRegistry.set(sig, { msgIndex: i, partIndex: j });
      }
    }

    // --- Phase 4: Supersede writes — prune earlier writes when file was later read ---
    const fileWrites = new Map<string, { msgIndex: number; partIndex: number }>();
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== 'tool') continue;
      const toolMsg = messages[i] as ContextToolMessage;
      for (let j = 0; j < toolMsg.content.length; j++) {
        const part = toolMsg.content[j];
        if (part.output.type === 'text' && part.output.value.startsWith('[DCP:')) continue;

        const ref = toolCalls.get(part.toolCallId);
        const filePath = extractPath(ref?.input as Record<string, unknown> | undefined);
        if (!filePath) continue;

        if (isWriteTool(part.toolName)) {
          fileWrites.set(filePath, { msgIndex: i, partIndex: j });
        } else if (isReadTool(part.toolName) && fileWrites.has(filePath)) {
          const prev = fileWrites.get(filePath)!;
          const prevMsg = messages[prev.msgIndex] as ContextToolMessage;
          const prevPart = prevMsg.content[prev.partIndex];
          if (!(prevPart.output.type === 'text' && prevPart.output.value.startsWith('[DCP:'))) {
            const prunedPart = this.prunePart(prevPart, 'write superseded by later read');
            if (prunedPart !== prevPart) {
              const newContent = [...prevMsg.content];
              newContent[prev.partIndex] = prunedPart;
              messages[prev.msgIndex] = { ...prevMsg, content: newContent };
              counts.supersede++;
              changed = true;
            }
          }
          fileWrites.delete(filePath);
        }
      }
    }

    // --- Phase 5: Purge error inputs — prune large string inputs from assistant messages for errored tool calls ---
    const userTurnsTotal = messages.filter(m => m.role === 'user').length;
    const erroredIds = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== 'tool') continue;
      const toolMsg = messages[i] as ContextToolMessage;
      for (const part of toolMsg.content) {
        if (isProtectedTool(part.toolName)) continue;
        const isError = part.output.type === 'error-text' || part.output.type === 'error-json';
        if (!isError) continue;
        const turnsAt = messages.slice(0, i).filter(m => m.role === 'user').length;
        if (userTurnsTotal - turnsAt >= 4) {
          erroredIds.add(part.toolCallId);
        }
      }
    }

    if (erroredIds.size > 0) {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

        const asstMsg = msg as ContextAssistantMessage;
        let msgModified = false;
        const contentArr = asstMsg.content as unknown as { type: string; toolCallId?: string; input?: unknown }[];
        const newContent = contentArr.map(part => {
          if (part.type !== 'tool-call' || !erroredIds.has(part.toolCallId as string)) return part;

          const input = part.input;
          if (!input || typeof input !== 'object') return part;

          let inputModified = false;
          const prunedInput: Record<string, unknown> = {};
          for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
            if (typeof val === 'string' && val.length > 100) {
              prunedInput[key] = PRUNED_ERROR_INPUT;
              inputModified = true;
            } else {
              prunedInput[key] = val;
            }
          }
          if (!inputModified) return part;

          // Count stats only once per tool call
          const countKey = `err:${part.toolCallId}`;
          if (!this.seenToolCallIds.has(countKey)) {
            this.seenToolCallIds.add(countKey);
            const inputSize = JSON.stringify(input).length;
            const prunedSize = JSON.stringify(prunedInput).length;
            this.stats.estimatedTokensSaved += Math.max(0, Math.floor((inputSize - prunedSize) / 4));
            this.stats.prunedParts++;
            counts.error++;
          }

          msgModified = true;
          return { ...part, input: prunedInput };
        });

        if (msgModified) {
          messages[i] = { ...asstMsg, content: newContent as unknown as ContextAssistantMessage['content'] };
          changed = true;
        }
      }
    }

    // --- Feedback ---
    if (changed) {
      const total = counts.duplicate + counts.supersede + counts.error + counts.manual + counts.distill;
      const newlyPruned = this.seenToolCallIds.size - seenSizeBefore;
      if (total > 0 && newlyPruned > 0) {
        const parts: string[] = [];
        if (counts.duplicate) parts.push(`${counts.duplicate} duplicate`);
        if (counts.supersede) parts.push(`${counts.supersede} supersede`);
        if (counts.error) parts.push(`${counts.error} error-input`);
        if (counts.manual) parts.push(`${counts.manual} manual`);
        if (counts.distill) parts.push(`${counts.distill} distill`);

        const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
        const summary = `DCP: pruned ${total} output(s)${detail} — ±${this.stats.estimatedTokensSaved} tokens saved total`;

        context.log(summary, 'info');
        const taskContext = context.getTaskContext();
        if (taskContext) taskContext.addLogMessage('info', summary);
      }

      return { optimizedMessages: messages };
    }

    return undefined;
  }

  // --- Tools ---

  getTools(_context: ExtensionContext, _mode: string, _agentProfile: AgentProfile): ToolDefinition[] {
    return [
      {
        name: 'dcp-prune',
        description:
          'Mark specific tool messages for pruning. Their outputs will be replaced with a placeholder before the next LLM request. Use this to remove obsolete or noisy tool outputs from conversation history.',
        inputSchema: z.object({
          messageIds: z.array(z.string()).describe('IDs of tool messages to prune'),
          reason: z.string().optional().describe('Reason for pruning (shown in placeholder)')
        }),
        execute: async (input, _signal, extContext) => {
          const ids = input.messageIds as string[];
          ids.forEach(id => this.manuallyPrunedIds.add(id));
          const msg = `DCP: Marked ${ids.length} message(s) for pruning — will take effect on next request`;
          extContext.log(msg, 'info');
          const taskContext = extContext.getTaskContext();
          if (taskContext) taskContext.addLogMessage('info', msg);
          return msg;
        }
      },
      {
        name: 'dcp-distill',
        description:
          'Preserve a concise summary of key findings from a range of messages, then prune all tool outputs in that range. Call this after completing a research phase to reduce context while retaining insights.',
        inputSchema: z.object({
          summary: z.string().describe('Concise summary of the findings to preserve'),
          range: z
            .object({
              startId: z.string(),
              endId: z.string()
            })
            .describe('Inclusive range of message IDs whose tool outputs should be pruned')
        }),
        execute: async (input, _signal, extContext) => {
          const range = input.range as { startId: string; endId: string };
          this.distilledRanges.push({
            startId: range.startId,
            endId: range.endId,
            summary: input.summary as string
          });
          const msg = `DCP: Range distilled — tool outputs will be pruned on next request. Summary: "${input.summary}"`;
          extContext.log(msg, 'info');
          const taskContext = extContext.getTaskContext();
          if (taskContext) taskContext.addLogMessage('info', msg);
          return msg;
        }
      }
    ];
  }

  // --- Commands ---

  getCommands(_context: ExtensionContext): CommandDefinition[] {
    return [
      {
        name: 'dcp',
        description: 'Manage Dynamic Context Pruning — subcommands: context, stats, sweep [count], reset',
        arguments: [{ description: 'Subcommand: context | stats | sweep [count] | reset', required: false }],
        execute: async (args, extContext) => {
          const sub = args[0];
          const taskContext = extContext.getTaskContext();

          if (sub === 'stats') {
            const msg =
              `DCP Stats — ${this.stats.prunedParts} part(s) pruned total, ` +
              `±${this.stats.estimatedTokensSaved} tokens saved, ` +
              `${this.distilledRanges.length} active distillation range(s), ` +
              `${this.manuallyPrunedIds.size} message(s) marked for manual pruning`;
            extContext.log(msg, 'info');
            if (taskContext) taskContext.addLogMessage('info', msg);
          } else if (sub === 'sweep') {
            if (taskContext) {
              const count = args[1] ? parseInt(args[1], 10) : undefined;
              const messages = await taskContext.getContextMessages();
              let toolMessages = messages.filter(m => m.role === 'tool' && !this.manuallyPrunedIds.has(m.id));
              if (count && count > 0) {
                toolMessages = toolMessages.slice(-count);
              }
              toolMessages.forEach(m => this.manuallyPrunedIds.add(m.id));
              const countLabel = count && count > 0 ? ` (last ${count})` : '';
              const msg = `DCP Sweep: Marked ${toolMessages.length} tool message(s)${countLabel} for pruning — will take effect on next request`;
              extContext.log(msg, 'info');
              taskContext.addLogMessage('info', msg);
            } else {
              extContext.log('DCP Sweep: No active task', 'warn');
            }
          } else if (sub === 'reset') {
            this.stats = { prunedParts: 0, estimatedTokensSaved: 0 };
            this.seenToolCallIds.clear();
            this.manuallyPrunedIds.clear();
            this.distilledRanges = [];
            const msg = 'DCP: State reset — all stats, prune marks, and distillation ranges cleared';
            extContext.log(msg, 'info');
            if (taskContext) taskContext.addLogMessage('info', msg);
          } else if (sub === 'context') {
            const msg =
              `DCP Context: ${this.stats.prunedParts} output(s) pruned, ` +
              `±${this.stats.estimatedTokensSaved} tokens saved, ` +
              `${this.distilledRanges.length} distillation range(s), ` +
              `${this.manuallyPrunedIds.size} pending manual prune(s)`;
            extContext.log(msg, 'info');
            if (taskContext) taskContext.addLogMessage('info', msg);
          } else if (!sub) {
            const msg = 'DCP commands: /dcp context | /dcp stats | /dcp sweep [count] | /dcp reset';
            extContext.log(msg, 'info');
            if (taskContext) taskContext.addLogMessage('info', msg);
          } else {
            const help = `DCP: Unknown subcommand "${sub}". Available: context, stats, sweep, reset`;
            extContext.log(help, 'warn');
            if (taskContext) taskContext.addLogMessage('warning', help);
          }
        }
      }
    ];
  }
}
