import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import type { SmartBashConfig } from "./config.js"
import type { ExecutionStore } from "./store.js"
import type { AnalystClient } from "./analyst.js"
import { queryWithSubagent } from "./analyst.js"
import { truncateStreams } from "./truncate.js"

type LogLevel = "debug" | "info" | "warn" | "error"

function log(
  client: AnalystClient,
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
): void {
  client.app.log({ body: { service: "smart-bash", level, message, extra } }).catch(() => {})
}

// The Bun shell result shape we depend on (subset of ShellOutput).
export interface ShellResult {
  stdout: Buffer | string
  stderr: Buffer | string
  exitCode: number
}

// A shell executor — in production this is Bun's `$`, in tests it's a mock.
export type ShellExecutor = (command: string) => Promise<ShellResult>

export type { ToolContext }
export type ToolDefinition = ReturnType<typeof tool>

/**
 * Build and return the `smart_bash` tool.
 */
export function makeSmartBashTool(
  client: AnalystClient,
  shell: ShellExecutor,
  store: ExecutionStore,
  config: SmartBashConfig,
): ToolDefinition {
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
    async execute(args, context: ToolContext): Promise<string> {
      const { command, intent } = args
      const id = crypto.randomUUID()
      const now = Date.now()

      log(client, "info", "smart_bash: running command", { command, executionId: id })

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

      if (truncated) {
        log(client, "warn", "smart_bash: output truncated", { command, executionId: id, maxOutputBytes: config.maxOutputBytes })
      }

      const record = { id, command, stdout, stderr, exitCode: result.exitCode, truncated, createdAt: now }
      store.set(record)

      let answer: string
      try {
        answer = await queryWithSubagent(client, { record, question: intent }, config)
      } catch (err) {
        log(client, "error", "smart_bash: analyst query failed", { command, executionId: id, error: String(err) })
        throw err
      }

      log(client, "info", "smart_bash: answer ready", { command, executionId: id, exitCode: result.exitCode })

      context.metadata({
        title: `smart_bash: ${command}`,
        metadata: { execution_id: id, exit_code: result.exitCode, truncated },
      })

      return `execution_id: ${id}\n\n${answer}`
    },
  })
}

/**
 * Build and return the `smart_bash_query` tool.
 */
export function makeSmartBashQueryTool(
  client: AnalystClient,
  store: ExecutionStore,
  config: SmartBashConfig,
): ToolDefinition {
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
    async execute(args, context: ToolContext): Promise<string> {
      const { execution_id, question } = args
      const record = store.get(execution_id)

      if (!record) {
        log(client, "warn", "smart_bash_query: unknown execution_id", { executionId: execution_id })
        return JSON.stringify({ error: `No execution found with id: ${execution_id}` })
      }

      log(client, "info", "smart_bash_query: querying execution", { executionId: execution_id })

      let answer: string
      try {
        answer = await queryWithSubagent(client, { record, question }, config)
      } catch (err) {
        log(client, "error", "smart_bash_query: analyst query failed", { executionId: execution_id, error: String(err) })
        throw err
      }

      context.metadata({
        title: `smart_bash_query: ${execution_id}`,
        metadata: { execution_id },
      })

      return answer
    },
  })
}

/**
 * Build the replacement `bash` tool used in "always" mode.
 */
export function makeAlwaysBashTool(
  client: AnalystClient,
  shell: ShellExecutor,
  store: ExecutionStore,
  config: SmartBashConfig,
): ToolDefinition {
  return tool({
    description:
      "Execute a bash command. Output is automatically summarised by an AI " +
      "sub-agent so large outputs don't fill the context. " +
      "Provide an `intent` to get a targeted answer; omit it for a general summary.",
    args: {
      command: tool.schema
        .string()
        .describe("The bash command to execute."),
      intent: tool.schema
        .string()
        .optional()
        .describe(
          "Optional: what you want to know about the result. " +
          "Defaults to a general success/summary check.",
        ),
    },
    async execute(args, context: ToolContext): Promise<string> {
      const { command } = args
      const intent = args.intent ?? config.defaultIntent
      const id = crypto.randomUUID()
      const now = Date.now()

      log(client, "info", "bash: running command", { command, executionId: id })

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

      if (truncated) {
        log(client, "warn", "bash: output truncated", { command, executionId: id, maxOutputBytes: config.maxOutputBytes })
      }

      const record = { id, command, stdout, stderr, exitCode: result.exitCode, truncated, createdAt: now }
      store.set(record)

      let answer: string
      try {
        answer = await queryWithSubagent(client, { record, question: intent }, config)
      } catch (err) {
        log(client, "error", "bash: analyst query failed", { command, executionId: id, error: String(err) })
        throw err
      }

      log(client, "info", "bash: answer ready", { command, executionId: id, exitCode: result.exitCode })

      context.metadata({
        title: `bash: ${command}`,
        metadata: { execution_id: id, exit_code: result.exitCode, truncated },
      })

      return `execution_id: ${id}\n\n${answer}`
    },
  })
}
