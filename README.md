# smart-bash

An [OpenCode](https://opencode.ai) plugin that routes bash commands through an AI analyst sub-session, preventing context rot from large command output.

Instead of dumping raw stdout/stderr into the main agent's context, `smart_bash` runs the command, stores the full output in a local SQLite database, and returns only a concise answer to your specific question. You can then ask follow-up questions against the stored output at any time — without re-running the command.

---

## How it works

```
Main Agent
  │
  ├─ smart_bash(command="npm test", intent="Did all tests pass?")
  │       │
  │       ├─ 1. Executes the command, captures full stdout/stderr
  │       ├─ 2. Stores raw output in SQLite → execution_id
  │       ├─ 3. Spins up an ephemeral OpenCode sub-session
  │       │       ├─ Injects output as context (no reply)
  │       │       ├─ Asks: "Did all tests pass?"
  │       │       └─ Gets: { answer: "Yes, all 47 tests passed in 2.3s" }
  │       └─ Returns: { answer, execution_id, exit_code, truncated }
  │
  └─ smart_bash_query(execution_id, question="How many tests were skipped?")
          │
          ├─ Retrieves stored output from SQLite (no re-run)
          ├─ New sub-session answers the follow-up question
          └─ Returns: { answer: "3 tests were skipped" }
```

---

## Tools

### `smart_bash`

Executes a bash command and returns a targeted answer without flooding context.

| Argument | Type | Description |
|---|---|---|
| `command` | `string` | The bash command to run |
| `intent` | `string` | What you want to know — e.g. `"Did the build succeed?"` |

Returns `{ answer, execution_id, exit_code, truncated }`.

### `smart_bash_query`

Re-queries the stored output of a previous `smart_bash` call. No re-execution.

| Argument | Type | Description |
|---|---|---|
| `execution_id` | `string` | The `execution_id` from a prior `smart_bash` call |
| `question` | `string` | Your follow-up question |

Returns `{ answer, execution_id }`.

### `bash` _(only in `"always"` mode)_

Replaces the built-in `bash` tool. Same interface, but every call is automatically routed through the smart pipeline. `intent` is optional and falls back to `defaultIntent`.

---

## Installation

### Method A — Local dependency (recommended for configuration)

Add `smart-bash` to your project's OpenCode package file. OpenCode runs `bun install` automatically at startup.

**`.opencode/package.json`**
```json
{
  "dependencies": {
    "smart-bash": "file:../path/to/smart-bash"
  }
}
```

Create a plugin file that imports and configures the plugin:

**`.opencode/plugins/smart-bash.ts`**
```typescript
import { createSmartBashPlugin } from "smart-bash"

export default createSmartBashPlugin({
  mode: "auto",                                      // "auto" | "always" | "never"
  analystModel: "anthropic/claude-haiku-4-20250514", // cheaper model for analysis
})
```

### Method B — npm (once published, zero-config)

Add the package name to the `"plugin"` array in `opencode.json`. OpenCode installs it automatically from npm.

**`opencode.json`**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["smart-bash"]
}
```

Configure via environment variables (see [Configuration](#configuration) below).

---

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `mode` | `"auto" \| "always" \| "never"` | `"auto"` | Routing strategy (see [Modes](#modes)) |
| `storePath` | `string` | `~/.local/share/smart-bash/store.db` | Path to the SQLite database |
| `maxOutputBytes` | `number` | `2_000_000` | Per-stream truncation limit (bytes) |
| `defaultIntent` | `string` | `"Did this command succeed? Summarize the key output."` | Fallback intent used in `"always"` mode |
| `analystModel` | `string \| undefined` | inherits from current session | Model for analyst sub-sessions (e.g. use a cheaper/faster model) |

### Environment variable overrides

When using Method B (npm `"plugin"` array), configure via environment variables:

| Variable | Config key |
|---|---|
| `SMART_BASH_MODE` | `mode` |
| `SMART_BASH_ANALYST_MODEL` | `analystModel` |
| `SMART_BASH_MAX_OUTPUT_BYTES` | `maxOutputBytes` |
| `SMART_BASH_STORE_PATH` | `storePath` |

---

## Modes

| Mode | Behaviour |
|---|---|
| `"auto"` _(default)_ | Both the built-in `bash` and `smart_bash` / `smart_bash_query` are available. The LLM reads tool descriptions and picks the right one — `bash` for quick commands, `smart_bash` for anything likely to produce large output. |
| `"always"` | The built-in `bash` tool is replaced by a smart wrapper. Every bash call is automatically routed through the pipeline. `intent` is optional; falls back to `defaultIntent`. The LLM keeps its familiar `bash` interface. |
| `"never"` | Only `smart_bash` and `smart_bash_query` are added. The built-in `bash` is untouched. The LLM must explicitly choose `smart_bash`. |

---

## Future work

### Pass-through threshold

Currently every `smart_bash` call spins up an analyst sub-session regardless of output size. For small outputs this is wasteful — the overhead of creating an ephemeral session, injecting context, and getting a reply can cost more (in latency and tokens) than simply returning the raw output directly into the main context.

A future `passthroughBytes` config option could short-circuit the analyst when `stdout + stderr` is below a threshold:

```typescript
createSmartBashPlugin({
  passthroughBytes: 2_000, // outputs smaller than this skip the analyst
})
```

The cutoff is not purely about size though — a 1KB stack trace may be more useful summarised than 10KB of `ls` output. A more nuanced heuristic might combine byte count with output characteristics (line count, presence of structured data, etc.). Worth experimenting with.

---

## Output truncation

When command output exceeds `maxOutputBytes`, each stream (stdout, stderr) is independently truncated using a **head + tail** strategy:

```
<first half of budget>
...[omitted 1,234,567 bytes]...
<last half of budget>
```

The `truncated` flag in the response and the stored record indicates when this occurred. The analyst sub-session is informed of the truncation so it can caveat its answer accordingly.

---

## Development

```bash
# Run tests (Node 22+, no install required)
node --experimental-strip-types --experimental-sqlite --test test/*.test.ts

# Type-check
npx tsc --noEmit
```

Tests use Node's built-in `node:test` and `node:sqlite` — no external test runner or database driver required.

### Test coverage

| Module | Tests | Coverage |
|---|---|---|
| `store.ts` | 18 | ~100% |
| `config.ts` | 15 | ~100% |
| `truncate.ts` | 14 | ~100% |
| `analyst.ts` | 26 | ~80% |
| `tools.ts` | 13 | ~80% |
| `index.ts` | 19 | ~70% |

---

## Project structure

```
src/
├── config.ts      — SmartBashConfig types, defaults, path resolution
├── truncate.ts    — Head+tail truncation utility
├── store.ts       — SQLite execution store (node:sqlite)
├── analyst.ts     — Ephemeral OpenCode sub-session query wrapper
├── tools.ts       — smart_bash, smart_bash_query, bash tool definitions
└── index.ts       — createSmartBashPlugin factory + default export

test/
├── fixtures/outputs.ts  — Shared test fixtures
├── store.test.ts
├── config.test.ts
├── truncate.test.ts
├── analyst.test.ts
├── tools.test.ts
└── plugin.test.ts
```
