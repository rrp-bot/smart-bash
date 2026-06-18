import { homedir } from "os"
import { join } from "path"

/**
 * Routing mode for the smart-bash plugin.
 *
 * - "auto"   — both `bash` (built-in) and `smart_bash` / `smart_bash_query`
 *              are available. The LLM reads tool descriptions and decides which
 *              to use. Best for mixed workloads.
 *
 * - "always" — the built-in `bash` tool is replaced with one that routes every
 *              call through the smart pipeline. `intent` is optional; falls back
 *              to `defaultIntent`. The LLM retains the familiar `bash` interface.
 *
 * - "never"  — only `smart_bash` and `smart_bash_query` are added. Native `bash`
 *              is untouched. The LLM must explicitly choose `smart_bash`.
 */
export type SmartBashMode = "auto" | "always" | "never"

export interface SmartBashConfig {
  /**
   * Routing strategy.
   * @default "auto"
   */
  mode: SmartBashMode

  /**
   * Absolute path (or ~ path) to the SQLite database file used to persist
   * execution records between sessions.
   * @default "~/.local/share/smart-bash/store.db"
   */
  storePath: string

  /**
   * Maximum number of bytes to retain from command output (combined stdout +
   * stderr). Output exceeding this is truncated using a head+tail strategy
   * with a gap notice indicating how many bytes were omitted.
   * @default 2_000_000
   */
  maxOutputBytes: number

  /**
   * Intent used when no explicit intent is provided. This applies in "always"
   * mode where the bash interface is preserved and the caller cannot supply an
   * intent.
   * @default "Did this command succeed? Summarize the key output."
   */
  defaultIntent: string

  /**
   * Model identifier (e.g. "anthropic/claude-haiku-4-20250514") for the
   * ephemeral analyst sub-sessions. When omitted the analyst session inherits
   * the model of the calling session.
   */
  analystModel?: string

  /**
   * Maximum milliseconds to wait for the analyst sub-session to respond.
   * If the LLM call exceeds this, the tool returns a timeout error message
   * rather than hanging indefinitely.
   * @default 30_000
   */
  analystTimeoutMs: number
}

export const DEFAULT_CONFIG: SmartBashConfig = {
  mode: "auto",
  storePath: join(homedir(), ".local", "share", "smart-bash", "store.db"),
  maxOutputBytes: 2_000_000,
  defaultIntent: "Did this command succeed? Summarize the key output.",
  analystTimeoutMs: 30_000,
}

/**
 * Merge user-supplied partial config over defaults and resolve "~" in paths.
 */
export function resolveConfig(partial?: Partial<SmartBashConfig>): SmartBashConfig {
  const merged: SmartBashConfig = { ...DEFAULT_CONFIG, ...partial }

  // Expand leading "~" to the user's home directory
  if (merged.storePath.startsWith("~/") || merged.storePath === "~") {
    merged.storePath = join(homedir(), merged.storePath.slice(2))
  }

  return merged
}
