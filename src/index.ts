/**
 * smart-bash — OpenCode plugin
 *
 * Provides `smart_bash` and `smart_bash_query` tools that route command
 * execution through an AI analyst sub-session, preventing context rot from
 * large command output.
 *
 * ── Installation ────────────────────────────────────────────────────────────
 *
 * METHOD A — Local dependency (recommended for configuration):
 *
 *   // .opencode/package.json
 *   { "dependencies": { "smart-bash": "file:../path/to/smart-bash" } }
 *
 *   // .opencode/plugins/smart-bash.ts
 *   import { createSmartBashPlugin } from "smart-bash"
 *   export default createSmartBashPlugin({
 *     mode: "auto",
 *     analystModel: "anthropic/claude-haiku-4-20250514",
 *   })
 *
 *   OpenCode runs `bun install` automatically at startup, resolving the dep.
 *
 * METHOD B — npm (zero-config, uses env vars for customisation):
 *
 *   // opencode.json
 *   { "plugin": ["smart-bash"] }
 *
 *   The package default export is a ready-to-use plugin with defaults.
 *   Use env vars (SMART_BASH_MODE, SMART_BASH_ANALYST_MODEL, etc.) to
 *   override config without a wrapper file.
 *
 * ── Environment variable overrides ──────────────────────────────────────────
 *
 *   SMART_BASH_MODE            "auto" | "always" | "never"
 *   SMART_BASH_ANALYST_MODEL   e.g. "anthropic/claude-haiku-4-20250514"
 *   SMART_BASH_MAX_OUTPUT_BYTES  e.g. "2000000"
 *   SMART_BASH_STORE_PATH      path to SQLite DB (default: ~/.local/share/…)
 */

import { resolveConfig } from "./config.js"
import type { SmartBashConfig } from "./config.js"
import { ExecutionStore } from "./store.js"
import {
  makeSmartBashTool,
  makeSmartBashQueryTool,
  makeAlwaysBashTool,
} from "./tools.js"
import type { ToolDefinition } from "./tools.js"
import type { AnalystClient } from "./analyst.js"

/** Plugin context shape OpenCode passes to the plugin function. */
export interface PluginContext {
  client: unknown
  $: (strings: TemplateStringsArray, ...values: unknown[]) => {
    quiet(): { nothrow(): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> }
  }
}

/** A Plugin is an async function returning a record of tool definitions. */
export type Plugin = (ctx: PluginContext) => Promise<{ tool: Record<string, ToolDefinition> }>

export type { SmartBashConfig, SmartBashMode } from "./config.js"
export type { ExecutionRecord } from "./store.js"
export { ExecutionStore } from "./store.js"
export { truncate, truncateStreams } from "./truncate.js"
export { buildContextBlock, parseModel } from "./analyst.js"

/**
 * Create a configured Smart Bash plugin.
 *
 * Returns a Plugin-compatible async function. Use this when you need to
 * configure the plugin via code (method A — local dependency):
 *
 * @example
 * // .opencode/plugins/smart-bash.ts
 * import { createSmartBashPlugin } from "smart-bash"
 * export default createSmartBashPlugin({
 *   mode: "auto",
 *   analystModel: "anthropic/claude-haiku-4-20250514",
 * })
 */
export function createSmartBashPlugin(
  userConfig?: Partial<SmartBashConfig>,
): Plugin {
  return async (ctx) => {
    const config = resolveConfig(userConfig)
    const store = new ExecutionStore(config.storePath)

    // Cast to our narrow AnalystClient interface.
    // The real OpenCode client satisfies this shape.
    const client = ctx.client as unknown as AnalystClient

    // Build a shell executor that uses Bun's shell API from the plugin context.
    // .quiet() suppresses stdout/stderr from being written to the terminal.
    const shell = async (command: string) => {
      const result = await ctx.$`bash -c ${command}`.quiet().nothrow()
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
      }
    }

    const tools: Record<string, ToolDefinition> = {
      smart_bash: makeSmartBashTool(client, shell, store, config),
      smart_bash_query: makeSmartBashQueryTool(client, store, config),
    }

    // In "always" mode, also register as "bash" to override the built-in tool.
    if (config.mode === "always") {
      tools["bash"] = makeAlwaysBashTool(client, shell, store, config)
    }

    return { tool: tools }
  }
}

/**
 * Read plugin config from environment variables.
 * Used by the default export so the npm `"plugin"` array path is configurable
 * without a wrapper file.
 */
function configFromEnv(): Partial<SmartBashConfig> {
  const partial: Partial<SmartBashConfig> = {}

  const mode = process.env["SMART_BASH_MODE"]
  if (mode === "auto" || mode === "always" || mode === "never") {
    partial.mode = mode
  }

  const analystModel = process.env["SMART_BASH_ANALYST_MODEL"]
  if (analystModel) partial.analystModel = analystModel

  const maxBytes = process.env["SMART_BASH_MAX_OUTPUT_BYTES"]
  if (maxBytes) {
    const n = parseInt(maxBytes, 10)
    if (!isNaN(n) && n > 0) partial.maxOutputBytes = n
  }

  const storePath = process.env["SMART_BASH_STORE_PATH"]
  if (storePath) partial.storePath = storePath

  return partial
}

/**
 * Ready-to-use plugin with defaults + env var overrides.
 *
 * This is the default export, used when the package is listed in the
 * `"plugin"` array of `opencode.json`:
 *
 *   { "plugin": ["smart-bash"] }
 *
 * OpenCode loads this export directly as a plugin function.
 * Configure via environment variables (SMART_BASH_MODE, etc.) or use
 * `createSmartBashPlugin` for code-based configuration.
 */
const SmartBashPlugin: Plugin = createSmartBashPlugin(configFromEnv())
export default SmartBashPlugin
