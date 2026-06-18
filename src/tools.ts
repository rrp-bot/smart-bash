import type { SmartBashConfig } from "./config.js"
import type { ExecutionStore } from "./store.js"
import type { AnalystClient } from "./analyst.js"
import { queryWithSubagent } from "./analyst.js"
import { truncateStreams } from "./truncate.js"

// The Bun shell result shape we depend on (subset of ShellOutput).
export interface ShellResult {
  stdout: Buffer | string
  stderr: Buffer | string
  exitCode: number
}

// A shell executor — in production this is Bun's `$`, in tests it's a mock.
export type ShellExecutor = (command: string) => Promise<ShellResult>

/** Minimal tool context shape OpenCode passes to execute(). */
export interface ToolContext {
  metadata(opts: { title: string; metadata: Record<string, unknown> }): void
}

/**
 * Plain tool definition — no Zod, no @opencode-ai/plugin.
 * OpenCode accepts { description, args, execute } where args is a plain
 * JSON Schema record.
 */
export interface ToolDefinition {
  description: string
  args: Record<string, unknown>
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>
}

/**
 * Build and return the `smart_bash` tool.
 */
export function makeSmartBashTool(
  client: AnalystClient,
  shell: ShellExecutor,
  store: ExecutionStore,
  config: SmartBashConfig,
): ToolDefinition {
  return {
    description:
      "Execute a bash command and get a concise, targeted answer about the result " +
      "without flooding the context with raw output. " +
      "The full output is stored and can be re-queried later via `smart_bash_query`. " +
      "Use this instead of `bash` for commands that typically produce large output " +
      "(builds, tests, installs, diffs, log tails, etc.).",
    args: {
      command: {
        type: "string",
        description: "The bash command to execute.",
      },
      intent: {
        type: "string",
        description:
          "What you want to know about the result. " +
          "Be specific: e.g. \"Did all tests pass?\", " +
          "\"What errors were reported?\", " +
          "\"What is the total bundle size?\"",
      },
    },
    async execute(args, context): Promise<string> {
      const command = args["command"] as string
      const intent = args["intent"] as string
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

      context.metadata({
        title: `smart_bash: ${command}`,
        metadata: { execution_id: id, exit_code: result.exitCode, truncated },
      })

      return answer
    },
  }
}

/**
 * Build and return the `smart_bash_query` tool.
 */
export function makeSmartBashQueryTool(
  client: AnalystClient,
  store: ExecutionStore,
  config: SmartBashConfig,
): ToolDefinition {
  return {
    description:
      "Ask a follow-up question about the output of a previous `smart_bash` " +
      "execution without re-running the command. " +
      "Use this when you need more information from a command you already ran.",
    args: {
      execution_id: {
        type: "string",
        description: "The execution_id returned by a previous `smart_bash` call.",
      },
      question: {
        type: "string",
        description:
          "Your follow-up question about the stored output. " +
          "E.g. \"How many tests were skipped?\", \"List the failing file names.\"",
      },
    },
    async execute(args, context): Promise<string> {
      const execution_id = args["execution_id"] as string
      const question = args["question"] as string
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

      context.metadata({
        title: `smart_bash_query: ${execution_id}`,
        metadata: { execution_id },
      })

      return answer
    },
  }
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
  return {
    description:
      "Execute a bash command. Output is automatically summarised by an AI " +
      "sub-agent so large outputs don't fill the context. " +
      "Provide an `intent` to get a targeted answer; omit it for a general summary.",
    args: {
      command: {
        type: "string",
        description: "The bash command to execute.",
      },
      intent: {
        type: "string",
        description:
          "Optional: what you want to know about the result. " +
          "Defaults to a general success/summary check.",
        optional: true,
      },
    },
    async execute(args, context): Promise<string> {
      const command = args["command"] as string
      const intent = (args["intent"] as string | undefined) ?? config.defaultIntent
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

      context.metadata({
        title: `bash: ${command}`,
        metadata: { execution_id: id, exit_code: result.exitCode, truncated },
      })

      return answer
    },
  }
}
