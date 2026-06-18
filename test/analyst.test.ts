import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildContextBlock, parseModel, queryWithSubagent } from "../src/analyst.ts"
import type { AnalystClient } from "../src/analyst.ts"
import { resolveConfig } from "../src/config.ts"
import { SAMPLE_RECORD, TRUNCATED_RECORD } from "./fixtures/outputs.ts"

// ── buildContextBlock ─────────────────────────────────────────────────────────

describe("buildContextBlock", () => {
  it("includes the command", () => {
    const block = buildContextBlock(SAMPLE_RECORD)
    assert.ok(block.includes(SAMPLE_RECORD.command))
  })

  it("includes the exit code", () => {
    const block = buildContextBlock(SAMPLE_RECORD)
    assert.ok(block.includes(String(SAMPLE_RECORD.exitCode)))
  })

  it("includes stdout content", () => {
    const block = buildContextBlock(SAMPLE_RECORD)
    assert.ok(block.includes(SAMPLE_RECORD.stdout))
  })

  it("includes stderr content", () => {
    const block = buildContextBlock(SAMPLE_RECORD)
    assert.ok(block.includes(SAMPLE_RECORD.stderr))
  })

  it("includes a truncation notice when truncated=true", () => {
    const block = buildContextBlock(TRUNCATED_RECORD)
    assert.ok(block.toLowerCase().includes("truncated"))
  })

  it("does not include a truncation notice when truncated=false", () => {
    const block = buildContextBlock(SAMPLE_RECORD)
    assert.ok(!block.toLowerCase().includes("truncated"))
  })

  it("shows '(empty)' placeholder for empty stdout", () => {
    const record = { ...SAMPLE_RECORD, stdout: "" }
    const block = buildContextBlock(record)
    assert.ok(block.includes("(empty)"))
  })

  it("shows '(empty)' placeholder for empty stderr", () => {
    const record = { ...SAMPLE_RECORD, stderr: "" }
    const block = buildContextBlock(record)
    assert.ok(block.includes("(empty)"))
  })

  it("includes an ISO timestamp derived from createdAt", () => {
    const block = buildContextBlock(SAMPLE_RECORD)
    const iso = new Date(SAMPLE_RECORD.createdAt).toISOString()
    assert.ok(block.includes(iso))
  })
})

// ── parseModel ────────────────────────────────────────────────────────────────

describe("parseModel", () => {
  it("returns undefined for undefined input", () => {
    assert.equal(parseModel(undefined), undefined)
  })

  it("returns undefined for empty string", () => {
    assert.equal(parseModel(""), undefined)
  })

  it("splits 'anthropic/claude-haiku' correctly", () => {
    const m = parseModel("anthropic/claude-haiku-4-20250514")
    assert.deepEqual(m, {
      providerID: "anthropic",
      modelID: "claude-haiku-4-20250514",
    })
  })

  it("splits 'openai/gpt-4o-mini' correctly", () => {
    const m = parseModel("openai/gpt-4o-mini")
    assert.deepEqual(m, { providerID: "openai", modelID: "gpt-4o-mini" })
  })

  it("handles model string with no slash", () => {
    const m = parseModel("somemodel")
    assert.deepEqual(m, { providerID: "somemodel", modelID: "somemodel" })
  })
})

// ── queryWithSubagent ─────────────────────────────────────────────────────────

type Call = { method: string; args: unknown[] }

function makeMockClient(answerOverride?: string): { client: AnalystClient; calls: Call[] } {
  const calls: Call[] = []

  const client: AnalystClient = {
    session: {
      create: async (opts) => {
        calls.push({ method: "session.create", args: [opts] })
        return { data: { id: "mock-session-id" } }
      },
      prompt: async (opts) => {
        calls.push({ method: "session.prompt", args: [opts] })
        return {
          data: {
            parts: [{ type: "text", text: answerOverride ?? "mocked answer" }],
          },
        }
      },
      delete: async (opts) => {
        calls.push({ method: "session.delete", args: [opts] })
        return {}
      },
    },
    app: { log: async () => ({}) },
  }

  return { client, calls }
}

describe("queryWithSubagent", () => {
  const config = resolveConfig()

  it("calls session.create exactly once", async () => {
    const { client, calls } = makeMockClient()
    await queryWithSubagent(client, { record: SAMPLE_RECORD, question: "did it work?" }, config)
    const creates = calls.filter((c) => c.method === "session.create")
    assert.equal(creates.length, 1)
  })

  it("calls session.prompt twice (context inject then question)", async () => {
    const { client, calls } = makeMockClient()
    await queryWithSubagent(client, { record: SAMPLE_RECORD, question: "did it work?" }, config)
    const prompts = calls.filter((c) => c.method === "session.prompt")
    assert.equal(prompts.length, 2)
  })

  it("first prompt call uses noReply=true", async () => {
    const { client, calls } = makeMockClient()
    await queryWithSubagent(client, { record: SAMPLE_RECORD, question: "did it work?" }, config)
    const firstPrompt = calls.filter((c) => c.method === "session.prompt")[0]!
    const body = (firstPrompt.args[0] as { body: { noReply?: boolean } }).body
    assert.equal(body.noReply, true)
  })

  it("context injection prompt contains the command and stdout", async () => {
    const { client, calls } = makeMockClient()
    await queryWithSubagent(client, { record: SAMPLE_RECORD, question: "did it work?" }, config)
    const firstPrompt = calls.filter((c) => c.method === "session.prompt")[0]!
    const body = (firstPrompt.args[0] as { body: { parts: Array<{ text: string }> } }).body
    const text = body.parts[0]?.text ?? ""
    assert.ok(text.includes(SAMPLE_RECORD.command))
    assert.ok(text.includes(SAMPLE_RECORD.stdout))
  })

  it("second prompt contains the question text", async () => {
    const { client, calls } = makeMockClient()
    const question = "how many tests failed?"
    await queryWithSubagent(client, { record: SAMPLE_RECORD, question }, config)
    const secondPrompt = calls.filter((c) => c.method === "session.prompt")[1]!
    const body = (secondPrompt.args[0] as { body: { parts: Array<{ text: string }> } }).body
    assert.equal(body.parts[0]?.text, question)
  })

  it("returns the answer from text parts", async () => {
    const { client } = makeMockClient("all 47 tests passed")
    const answer = await queryWithSubagent(client, { record: SAMPLE_RECORD, question: "?" }, config)
    assert.equal(answer, "all 47 tests passed")
  })

  it("calls session.delete after a successful query", async () => {
    const { client, calls } = makeMockClient()
    await queryWithSubagent(client, { record: SAMPLE_RECORD, question: "?" }, config)
    const deletes = calls.filter((c) => c.method === "session.delete")
    assert.equal(deletes.length, 1)
    const path = (deletes[0]!.args[0] as { path: { id: string } }).path
    assert.equal(path.id, "mock-session-id")
  })

  it("calls session.delete even when prompt throws", async () => {
    const called: string[] = []
    const failingClient: AnalystClient = {
      session: {
        create: async () => ({ data: { id: "s1" } }),
        prompt: async () => {
          called.push("prompt")
          throw new Error("LLM unavailable")
        },
        delete: async () => {
          called.push("delete")
          return {}
        },
      },
      app: { log: async () => ({}) },
    }

    await assert.rejects(
      () => queryWithSubagent(failingClient, { record: SAMPLE_RECORD, question: "?" }, config),
      /LLM unavailable/,
    )

    assert.ok(called.includes("delete"))
  })

  it("omits model field when analystModel is not set", async () => {
    const { client, calls } = makeMockClient()
    await queryWithSubagent(client, { record: SAMPLE_RECORD, question: "?" }, resolveConfig())
    const secondPrompt = calls.filter((c) => c.method === "session.prompt")[1]!
    const body = secondPrompt.args[0] as { body: { model?: unknown } }
    assert.equal(body.body.model, undefined)
  })

  it("passes model when analystModel is configured", async () => {
    const { client, calls } = makeMockClient()
    const cfg = resolveConfig({ analystModel: "anthropic/claude-haiku-4-20250514" })
    await queryWithSubagent(client, { record: SAMPLE_RECORD, question: "?" }, cfg)
    const secondPrompt = calls.filter((c) => c.method === "session.prompt")[1]!
    const body = secondPrompt.args[0] as { body: { model?: { providerID: string; modelID: string } } }
    assert.deepEqual(body.body.model, {
      providerID: "anthropic",
      modelID: "claude-haiku-4-20250514",
    })
  })

  it("throws when answer parts are empty", async () => {
    const badClient: AnalystClient = {
      session: {
        create: async () => ({ data: { id: "s2" } }),
        prompt: async () => ({ data: { parts: [] } }),
        delete: async () => ({}),
      },
      app: { log: async () => ({}) },
    }

    await assert.rejects(
      () => queryWithSubagent(badClient, { record: SAMPLE_RECORD, question: "?" }, config),
    )
  })
})
