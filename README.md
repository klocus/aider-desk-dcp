# Dynamic Context Pruning (DCP) Extension for AiderDesk

An extension that automatically manages conversation context to reduce token usage during long agent sessions. Inspired by OpenCode's DCP mechanism.

## Features

- **Deduplication** — removes earlier results of identical tool calls (same tool, same input), keeping only the latest.
- **Supersede Writes** — prunes earlier `file_write` / `file_edit` results when the same file is subsequently read, since the read already contains the latest content.
- **Purge Error Inputs** — strips large string inputs from assistant tool calls that errored, once they're 4+ user turns in the past.
- **Manual Prune Tool** (`dcp-prune`) — AI can mark specific tool messages for pruning on the next request.
- **Distill Tool** (`dcp-distill`) — AI can summarize findings from a range of messages and prune all tool outputs in that range, retaining the summary.
- **Protected Tools** — AiderDesk-native tools that manage state (tasks, todos, memory, skills, subagents, Aider context files, code generation) are never pruned.

## How It Works

Every time AiderDesk is about to send a request to the LLM, DCP runs a pruning pass over the conversation history in 5 sequential phases:

**Phase 0 — Build tool call index**
Scans all assistant messages and builds a lookup from `toolCallId` to the tool's name and input parameters. Used by subsequent phases to identify tools and their arguments.

**Phase 1 — Apply distillation ranges**
If `dcp-distill` was previously called, replaces all tool outputs within the specified message range with a single placeholder containing the AI-provided summary.

**Phase 2 — Apply manual prunes**
Replaces outputs of any tool messages explicitly marked via `dcp-prune` with a pruned placeholder.

**Phase 3 — Deduplication**
Scans tool results and builds a signature from `(toolName, inputParams)`. If the same tool was called with identical parameters more than once, all occurrences except the latest are pruned. Write tools and protected tools are excluded from this phase.

**Phase 4 — Supersede writes**
Tracks `file_write` / `file_edit` calls per file path. If a subsequent `file_read`, `grep`, `glob`, or similar read tool is called on the same path, the earlier write result is pruned — the read already contains the current state of the file.

**Phase 5 — Purge error inputs**
Finds tool calls that returned errors and are 4+ user turns old. Replaces large string inputs (`> 100 chars`) in the corresponding assistant messages with a placeholder, since the failed call's context is unlikely to be relevant.

Pruning is **non-destructive in the source store** — AiderDesk does not persist the modified messages back. DCP re-applies all rules on each request based on its in-memory set of seen `toolCallId`s.

## Commands

| Command              | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `/dcp stats`         | Show total pruning statistics (parts pruned, tokens saved, active ranges). |
| `/dcp context`       | Show a summary of current DCP state.                                       |
| `/dcp sweep [count]` | Mark all (or last N) tool messages for pruning on the next request.        |
| `/dcp reset`         | Clear all DCP state — stats, prune marks, and distillation ranges.         |

## Tools Available to the Agent

| Tool          | Description                                                             |
| ------------- | ----------------------------------------------------------------------- |
| `dcp-prune`   | Mark specific tool messages by ID for pruning.                          |
| `dcp-distill` | Summarize a range of messages and prune all tool outputs in that range. |

The agent is instructed to use these proactively when the context grows large or after completing a research/exploration phase.

## Installation

**Global (available in all projects)**

```sh
npx @aiderdesk/extensions install https://raw.githubusercontent.com/klocus/aider-desk-dcp/refs/heads/master/dynamic-context-pruning.ts --global
```

**Project-level**

```sh
npx @aiderdesk/extensions install https://raw.githubusercontent.com/klocus/aider-desk-dcp/refs/heads/master/dynamic-context-pruning.ts
```

## Usage

DCP works automatically in the background. No configuration is required.

The agent has access to `dcp-prune` and `dcp-distill` tools and is instructed to use them proactively. You can also trigger context cleanup manually using the `/dcp sweep` command.
