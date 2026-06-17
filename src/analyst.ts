import type { SmartBashConfig } from "./config.ts"
import type { ExecutionRecord } from "./store.ts"

// Minimal types for the parts of the OpenCode client we use, so callers don't
// need to import the full SDK in tests and we keep the surface narrow.
export interface AnalystClient {
  session: {
    create(opts: { body: Record<string, unknown> }): Promise<{ data: { id: string } }>
    prompt(opts: {
      path: { id: string }
      body: {
        noReply?: boolean
        parts: Array<{ type: "text"; text: string }>
        model?: { providerID: string; modelID: string }
        format?: {
          type: "json_schema"
          schema: Record<string, unknown>
        }
      }
    }): Promise<{ data: { info: { structured_output?: { answer?: string } } } }>
    delete(opts: { path: { id: string } }): Promise<unknown>
  }
}

/** Parameters for a single analyst query. */
export interface AnalystParams {
  record: ExecutionRecord
  question: string
}

/**
 * Build the context block that is injected into the analyst sub-session as a
 * no-reply user message. This contains the full (possibly truncated) command
 * output so the analyst can answer questions without re-running the command.
 */
export function buildContextBlock(record: ExecutionRecord): string {
  const lines: string[] = [
    `## Command execution record`,
    ``,
    `**Command:** \`${record.command}\``,
    `**Exit code:** ${record.exitCode}`,
    `**Executed at:** ${new Date(record.createdAt).toISOString()}`,
  ]

  if (record.truncated) {
    lines.push(
      `**Note:** The output below has been truncated. ` +
        `The full output was stored but was too large to send in its entirety.`,
    )
  }

  lines.push(``, `### stdout`, `\`\`\``, record.stdout || "(empty)", `\`\`\``)
  lines.push(``, `### stderr`, `\`\`\``, record.stderr || "(empty)", `\`\`\``)

  return lines.join("\n")
}

/**
 * Parse a model string like "anthropic/claude-haiku-4-20250514" into the
 * `{ providerID, modelID }` shape the SDK expects.
 *
 * Returns undefined when `model` is falsy so callers can use optional spread.
 */
export function parseModel(
  model: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash === -1) return { providerID: model, modelID: model }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "A concise, direct answer to the question. " +
        "Include only the information requested — no preamble, no padding.",
    },
  },
  required: ["answer"],
} as const

/**
 * Create an ephemeral OpenCode sub-session, inject the command output as
 * read-only context, ask the question, and return the model's concise answer.
 *
 * The sub-session is always deleted in a `finally` block so it does not
 * accumulate in the user's session list.
 */
export async function queryWithSubagent(
  client: AnalystClient,
  params: AnalystParams,
  config: SmartBashConfig,
): Promise<string> {
  const { record, question } = params

  // 1. Create an ephemeral session.
  const created = await client.session.create({ body: {} })
  const sessionId = created.data.id

  try {
    // 2. Inject the command output as context — no AI reply triggered.
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: "text", text: buildContextBlock(record) }],
      },
    })

    // 3. Ask the question and request structured JSON output.
    const parsedModel = parseModel(config.analystModel)

    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        ...(parsedModel ? { model: parsedModel } : {}),
        parts: [{ type: "text", text: question }],
        format: {
          type: "json_schema",
          schema: ANSWER_SCHEMA,
        },
      },
    })

    const answer = result.data.info.structured_output?.answer
    if (typeof answer !== "string" || answer.trim() === "") {
      throw new Error("Analyst sub-session returned an empty or invalid answer.")
    }

    return answer
  } finally {
    // 4. Always clean up the ephemeral session.
    await client.session.delete({ path: { id: sessionId } }).catch(() => {
      /* best-effort — don't mask the original error */
    })
  }
}
