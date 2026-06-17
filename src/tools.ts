import { tool } from "@opencode-ai/plugin"
import type { SmartBashConfig } from "./config.ts"
import type { ExecutionStore } from "./store.ts"
import type { AnalystClient } from "./analyst.ts"
import { queryWithSubagent } from "./analyst.ts"
import { truncateStreams } from "./truncate.ts"

// The Bun shell result shape we depend on (subset of ShellOutput).
export interface ShellResult {
  stdout: Buffer | string
  stderr: Buffer | string
  exitCode: number
}

// A shell executor — in production this is Bun's `$`, in tests it's a mock.
export type ShellExecutor = (command: string) => Promise<ShellResult>

/** Shared response shape returned by both smart bash tools. */
export interface SmartBashResult {
  answer: string
  execution_id: string
  exit_code: number
  truncated: boolean
}

export interface SmartBashQueryResult {
  answer: string
  execution_id: string
}

/**
 * Build and return the `smart_bash` tool.
 *
 * Executes `command`, stores the full (possibly truncated) output, dispatches
 * an analyst sub-session to answer `intent`, and returns both the concise
 * answer and an `execution_id` for follow-up queries.
 */
export function makeSmartBashTool(
  client: AnalystClient,
  shell: ShellExecutor,
  store: ExecutionStore,
  config: SmartBashConfig,
) {
  return tool({
    description:
      "Execute a bash command and get a concise, targeted answer about the result " +
      "without flooding the context with raw output. " +
      "The full output is stored and can be re-queried later via `smart_bash_query`. " +
      "Use this instead of `bash` for commands that typically produce large output " +
      "(builds, tests, installs, diffs, log tails, etc.).",
    args: {
      command: tool.schema
        .string()
        .describe("The bash command to execute."),
      intent: tool.schema
        .string()
        .describe(
          "What you want to know about the result. " +
            "Be specific: e.g. \"Did all tests pass?\", " +
            "\"What errors were reported?\", " +
            "\"What is the total bundle size?\"",
        ),
    },
    async execute(args): Promise<string> {
      const { command, intent } = args
      const id = crypto.randomUUID()
      const now = Date.now()

      // Run the command, tolerating non-zero exit codes.
      const result = await shell(command)
      const rawStdout = typeof result.stdout === "string"
        ? result.stdout
        : result.stdout.toString("utf8")
      const rawStderr = typeof result.stderr === "string"
        ? result.stderr
        : result.stderr.toString("utf8")

      // Truncate large outputs before storing.
      const { stdout, stderr, truncated } = truncateStreams(
        rawStdout,
        rawStderr,
        config.maxOutputBytes,
      )

      const record = {
        id,
        command,
        stdout,
        stderr,
        exitCode: result.exitCode,
        truncated,
        createdAt: now,
      }

      store.set(record)

      // Ask the analyst to interpret the output.
      const answer = await queryWithSubagent(
        client,
        { record, question: intent },
        config,
      )

      const out: SmartBashResult = {
        answer,
        execution_id: id,
        exit_code: result.exitCode,
        truncated,
      }

      return JSON.stringify(out)
    },
  })
}

/**
 * Build and return the `smart_bash_query` tool.
 *
 * Retrieves a previously stored execution record and dispatches a fresh analyst
 * sub-session to answer a new question — without re-running the command.
 */
export function makeSmartBashQueryTool(
  client: AnalystClient,
  store: ExecutionStore,
  config: SmartBashConfig,
) {
  return tool({
    description:
      "Ask a follow-up question about the output of a previous `smart_bash` " +
      "execution without re-running the command. " +
      "Use this when you need more information from a command you already ran.",
    args: {
      execution_id: tool.schema
        .string()
        .describe("The execution_id returned by a previous `smart_bash` call."),
      question: tool.schema
        .string()
        .describe(
          "Your follow-up question about the stored output. " +
            "E.g. \"How many tests were skipped?\", \"List the failing file names.\"",
        ),
    },
    async execute(args): Promise<string> {
      const { execution_id, question } = args
      const record = store.get(execution_id)

      if (!record) {
        return JSON.stringify({
          error: `No execution found with id: ${execution_id}`,
        })
      }

      const answer = await queryWithSubagent(
        client,
        { record, question },
        config,
      )

      const out: SmartBashQueryResult = {
        answer,
        execution_id,
      }

      return JSON.stringify(out)
    },
  })
}

/**
 * Build the replacement `bash` tool used in "always" mode.
 *
 * Preserves the built-in `bash` interface (only `command` required) so the LLM
 * doesn't need to change its behaviour.  `intent` is optional and falls back to
 * `config.defaultIntent`.
 */
export function makeAlwaysBashTool(
  client: AnalystClient,
  shell: ShellExecutor,
  store: ExecutionStore,
  config: SmartBashConfig,
) {
  return tool({
    description:
      "Execute a bash command. Output is automatically summarised by an AI " +
      "sub-agent so large outputs don't fill the context. " +
      "Provide an `intent` to get a targeted answer; omit it for a general summary.",
    args: {
      command: tool.schema.string().describe("The bash command to execute."),
      intent: tool.schema
        .string()
        .optional()
        .describe(
          "Optional: what you want to know about the result. " +
            "Defaults to a general success/summary check.",
        ),
    },
    async execute(args): Promise<string> {
      const { command, intent = config.defaultIntent } = args
      const id = crypto.randomUUID()
      const now = Date.now()

      const result = await shell(command)
      const rawStdout = typeof result.stdout === "string"
        ? result.stdout
        : result.stdout.toString("utf8")
      const rawStderr = typeof result.stderr === "string"
        ? result.stderr
        : result.stderr.toString("utf8")

      const { stdout, stderr, truncated } = truncateStreams(
        rawStdout,
        rawStderr,
        config.maxOutputBytes,
      )

      const record = {
        id,
        command,
        stdout,
        stderr,
        exitCode: result.exitCode,
        truncated,
        createdAt: now,
      }

      store.set(record)

      const answer = await queryWithSubagent(
        client,
        { record, question: intent },
        config,
      )

      const out: SmartBashResult = {
        answer,
        execution_id: id,
        exit_code: result.exitCode,
        truncated,
      }

      return JSON.stringify(out)
    },
  })
}
