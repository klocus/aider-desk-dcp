# Dynamic Context Pruning (DCP) Extension for AiderDesk

This extension automatically manages conversation context to optimize token usage, similar to OpenCode's DCP.

## Features

- **Deduplication**: Automatically removes duplicate tool calls (same tool, same input).
- **Supersede Writes**: Automatically removes `write_file` or `edit_file` content if followed by a `read_file`, `grep`, or `ls` for the same path.
- **Purge Errors**: Automatically prunes tool inputs for tools that returned errors after 4 user turns.
- **Distill Tool**: AI can summarize context before removal.
- **Compress Tool**: AI can collapse conversation history into a summary.
- **Prune Tool**: AI can remove completed/noisy tool outputs.

## Commands

- `/dcp stats`: Show total pruning statistics.
- `/dcp sweep`: Prune all tool calls since the last user message.
- `/dcp context`: Show a breakdown of current context usage (simulated).

## Installation

**Download to global extensions**
```
curl -o ~/.aider-desk/extensions/dynamic-context-pruning.ts \
  https://raw.githubusercontent.com/klocus/aider-desk-dcp/refs/heads/master/dynamic-context-pruning.ts
```

**Download to project extensions**
```
curl -o ./.aider-desk/extensions/dynamic-context-pruning.ts \
  https://raw.githubusercontent.com/klocus/aider-desk-dcp/refs/heads/master/dynamic-context-pruning.ts
```

## Usage

DCP works automatically in the background on every request. You don't need to do anything! However, you can manually trigger pruning or distillation using the tools:
- `dcp-prune`
- `dcp-distill`
- `dcp-compress`
