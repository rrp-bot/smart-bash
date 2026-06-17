import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  makeSmartBashTool,
  makeSmartBashQueryTool,
  makeAlwaysBashTool,
} from "../src/tools.ts"
import type { ShellExecutor } from "../src/tools.ts"
import type { AnalystClient } from "../src/analyst.ts"
import { ExecutionStore } from "../src/store.ts"
import { resolveConfig } from "../src/config.ts"
import { SMALL_STDOUT, SMALL_STDERR, makeOutput } from "./fixtures/outputs.ts"

// ── test helpers ──────────────────────────────────────────────────────────────

function makeStore() {
  return new ExecutionStore(":memory:")
}

function makeClient(answer = "mocked answer"): AnalystClient {
  return {
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      prompt: async () => ({ data: { info: { structured_output: { answer } } } }),
      delete: async () => ({}),
    },
  }
}

function makeShell(
  stdout = SMALL_STDOUT,
  stderr = SMALL_STDERR,
  exitCode = 0,
): ShellExecutor {
  return async (_cmd: string) => ({
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
  })
}

type ToolLike = { execute: (args: Record<string, unknown>) => Promise<string> }

function exec(t: unknown, args: Record<string, unknown>) {
  return (t as ToolLike).execute(args)
}

const defaultConfig = resolveConfig({ storePath: ":memory:" })

// ── smart_bash ────────────────────────────────────────────────────────────────

describe("makeSmartBashTool", () => {
  it("returns answer and execution_id", async () => {
    const store = makeStore()
    const tool = makeSmartBashTool(makeClient("yes, all tests passed"), makeShell(), store, defaultConfig)
    const result = JSON.parse(await exec(tool, { command: "npm test", intent: "Did tests pass?" }))
    assert.equal(result.answer, "yes, all tests passed")
    assert.ok(typeof result.execution_id === "string" && result.execution_id.length > 0)
    store.close()
  })

  it("execution_id is a valid UUID (8-4-4-4-12 format)", async () => {
    const store = makeStore()
    const tool = makeSmartBashTool(makeClient(), makeShell(), store, defaultConfig)
    const { execution_id } = JSON.parse(await exec(tool, { command: "echo hi", intent: "any?" }))
    assert.match(execution_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    store.close()
  })

  it("stores the execution record in the store", async () => {
    const store = makeStore()
    const tool = makeSmartBashTool(makeClient(), makeShell(), store, defaultConfig)
    const { execution_id } = JSON.parse(await exec(tool, { command: "ls -la", intent: "how many files?" }))
    const record = store.get(execution_id)
    assert.ok(record !== null)
    assert.equal(record.command, "ls -la")
    assert.equal(record.stdout, SMALL_STDOUT)
    store.close()
  })

  it("captures exit_code in the response", async () => {
    const store = makeStore()
    const tool = makeSmartBashTool(makeClient(), makeShell(SMALL_STDOUT, "", 1), store, defaultConfig)
    const result = JSON.parse(await exec(tool, { command: "false", intent: "did it fail?" }))
    assert.equal(result.exit_code, 1)
    store.close()
  })

  it("captures stderr in the stored record", async () => {
    const store = makeStore()
    const tool = makeSmartBashTool(makeClient(), makeShell("", "error output", 0), store, defaultConfig)
    const { execution_id } = JSON.parse(await exec(tool, { command: "cmd", intent: "errors?" }))
    assert.equal(store.get(execution_id)!.stderr, "error output")
    store.close()
  })

  it("sets truncated=true in response for large output", async () => {
    const store = makeStore()
    const smallMax = resolveConfig({ storePath: ":memory:", maxOutputBytes: 100 })
    const tool = makeSmartBashTool(makeClient(), makeShell(makeOutput(500)), store, smallMax)
    const result = JSON.parse(await exec(tool, { command: "big cmd", intent: "summarize" }))
    assert.equal(result.truncated, true)
    store.close()
  })

  it("stores execution record even when analyst throws", async () => {
    const store = makeStore()
    const failingClient: AnalystClient = {
      session: {
        create: async () => ({ data: { id: "s" } }),
        prompt: async () => { throw new Error("analyst down") },
        delete: async () => ({}),
      },
    }

    const tool = makeSmartBashTool(failingClient, makeShell(), store, defaultConfig)

    await assert.rejects(
      () => exec(tool, { command: "cmd", intent: "?" }),
      /analyst down/,
    )

    assert.equal(store.list().length, 1)
    store.close()
  })
})

// ── smart_bash_query ──────────────────────────────────────────────────────────

describe("makeSmartBashQueryTool", () => {
  it("returns answer for a stored execution_id", async () => {
    const store = makeStore()
    store.set({
      id: "known-id",
      command: "npm test",
      stdout: SMALL_STDOUT,
      stderr: "",
      exitCode: 0,
      truncated: false,
      createdAt: Date.now(),
    })

    const tool = makeSmartBashQueryTool(makeClient("3 tests skipped"), store, defaultConfig)
    const result = JSON.parse(
      await exec(tool, { execution_id: "known-id", question: "How many tests were skipped?" }),
    )
    assert.equal(result.answer, "3 tests skipped")
    assert.equal(result.execution_id, "known-id")
    store.close()
  })

  it("returns error object for unknown execution_id", async () => {
    const store = makeStore()
    const tool = makeSmartBashQueryTool(makeClient(), store, defaultConfig)
    const result = JSON.parse(
      await exec(tool, { execution_id: "ghost-id", question: "anything" }),
    )
    assert.ok(result.error)
    assert.ok(result.error.includes("ghost-id"))
    store.close()
  })

  it("different questions on the same execution_id invoke analyst each time", async () => {
    const store = makeStore()
    store.set({
      id: "exec-1",
      command: "npm test",
      stdout: SMALL_STDOUT,
      stderr: "",
      exitCode: 0,
      truncated: false,
      createdAt: Date.now(),
    })

    let createCount = 0
    const countingClient: AnalystClient = {
      session: {
        create: async () => ({ data: { id: `s${++createCount}` } }),
        prompt: async () => ({ data: { info: { structured_output: { answer: `answer ${createCount}` } } } }),
        delete: async () => ({}),
      },
    }

    const tool = makeSmartBashQueryTool(countingClient, store, defaultConfig)
    await exec(tool, { execution_id: "exec-1", question: "q1" })
    await exec(tool, { execution_id: "exec-1", question: "q2" })

    assert.equal(createCount, 2)
    store.close()
  })
})

// ── always-bash tool ──────────────────────────────────────────────────────────

describe("makeAlwaysBashTool", () => {
  it("uses defaultIntent when intent is omitted", async () => {
    const store = makeStore()
    const cfg = resolveConfig({ storePath: ":memory:", defaultIntent: "custom default intent" })

    let capturedQuestion = ""
    const capturingClient: AnalystClient = {
      session: {
        create: async () => ({ data: { id: "s" } }),
        prompt: async (opts) => {
          const body = opts.body as { noReply?: boolean; parts: Array<{ text: string }> }
          if (!body.noReply) capturedQuestion = body.parts[0]?.text ?? ""
          return { data: { info: { structured_output: { answer: "ok" } } } }
        },
        delete: async () => ({}),
      },
    }

    const tool = makeAlwaysBashTool(capturingClient, makeShell(), store, cfg)
    await exec(tool, { command: "npm install" })
    assert.equal(capturedQuestion, "custom default intent")
    store.close()
  })

  it("uses the provided intent when given", async () => {
    const store = makeStore()
    let capturedQuestion = ""
    const capturingClient: AnalystClient = {
      session: {
        create: async () => ({ data: { id: "s" } }),
        prompt: async (opts) => {
          const body = opts.body as { noReply?: boolean; parts: Array<{ text: string }> }
          if (!body.noReply) capturedQuestion = body.parts[0]?.text ?? ""
          return { data: { info: { structured_output: { answer: "ok" } } } }
        },
        delete: async () => ({}),
      },
    }

    const tool = makeAlwaysBashTool(capturingClient, makeShell(), store, defaultConfig)
    await exec(tool, { command: "npm install", intent: "Did dependencies install without errors?" })
    assert.equal(capturedQuestion, "Did dependencies install without errors?")
    store.close()
  })

  it("returns answer, execution_id, exit_code, truncated", async () => {
    const store = makeStore()
    const tool = makeAlwaysBashTool(makeClient("success"), makeShell(), store, defaultConfig)
    const result = JSON.parse(await exec(tool, { command: "echo hi" }))
    assert.ok(result.answer)
    assert.ok(typeof result.execution_id === "string")
    assert.ok(typeof result.exit_code === "number")
    assert.ok(typeof result.truncated === "boolean")
    store.close()
  })
})
