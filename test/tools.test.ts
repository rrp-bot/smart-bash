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
      prompt: async () => ({ data: { parts: [{ type: "text", text: answer }] } }),
      delete: async () => ({}),
    },
    app: {
      log: async () => ({}),
    },
  }
}

type LogCall = { level: string; message: string; extra?: Record<string, unknown> }

/** Like makeClient but records every app.log call for inspection. */
function makeCapturingClient(answer = "mocked answer"): { client: AnalystClient; logs: LogCall[] } {
  const logs: LogCall[] = []
  const client: AnalystClient = {
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      prompt: async () => ({ data: { parts: [{ type: "text", text: answer }] } }),
      delete: async () => ({}),
    },
    app: {
      log: async (opts) => { logs.push(opts.body as LogCall); return {} },
    },
  }
  return { client, logs }
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

type ToolLike = { execute: (args: Record<string, unknown>, ctx: { metadata: (m: unknown) => void }) => Promise<string> }

function exec(t: unknown, args: Record<string, unknown>) {
  return (t as ToolLike).execute(args, { metadata: () => {} })
}

const defaultConfig = resolveConfig({ storePath: ":memory:" })

// ── smart_bash ────────────────────────────────────────────────────────────────

describe("makeSmartBashTool", () => {
  it("returns the analyst answer string with execution_id prefix", async () => {
    const store = makeStore()
    const tool = makeSmartBashTool(makeClient("yes, all tests passed"), makeShell(), store, defaultConfig)
    const result = await exec(tool, { command: "npm test", intent: "Did tests pass?" })
    assert.match(result, /^execution_id: [0-9a-f-]{36}\n\n/)
    assert.match(result, /yes, all tests passed/)
    store.close()
  })

  it("stores the execution record in the store", async () => {
    const store = makeStore()
    const tool = makeSmartBashTool(makeClient(), makeShell(), store, defaultConfig)
    await exec(tool, { command: "ls -la", intent: "how many files?" })
    const records = store.list()
    assert.equal(records.length, 1)
    assert.equal(records[0]!.command, "ls -la")
    assert.equal(records[0]!.stdout, SMALL_STDOUT)
    store.close()
  })

  it("stored record has correct exit code", async () => {
    const store = makeStore()
    const tool = makeSmartBashTool(makeClient(), makeShell(SMALL_STDOUT, "", 1), store, defaultConfig)
    await exec(tool, { command: "false", intent: "did it fail?" })
    const records = store.list()
    assert.equal(records[0]!.exitCode, 1)
    store.close()
  })

  it("captures stderr in the stored record", async () => {
    const store = makeStore()
    const tool = makeSmartBashTool(makeClient(), makeShell("", "error output", 0), store, defaultConfig)
    await exec(tool, { command: "cmd", intent: "errors?" })
    const records = store.list()
    assert.equal(records[0]!.stderr, "error output")
    store.close()
  })

  it("sets truncated=true in stored record for large output", async () => {
    const store = makeStore()
    const smallMax = resolveConfig({ storePath: ":memory:", maxOutputBytes: 100 })
    const tool = makeSmartBashTool(makeClient(), makeShell(makeOutput(500)), store, smallMax)
    await exec(tool, { command: "big cmd", intent: "summarize" })
    const records = store.list()
    assert.equal(records[0]!.truncated, true)
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
      app: { log: async () => ({}) },
    }

    const tool = makeSmartBashTool(failingClient, makeShell(), store, defaultConfig)

    await assert.rejects(
      () => exec(tool, { command: "cmd", intent: "?" }),
      /analyst down/,
    )

    assert.equal(store.list().length, 1)
    store.close()
  })

  it("emits a warn log when output is truncated", async () => {
    const store = makeStore()
    const { client, logs } = makeCapturingClient()
    const smallMax = resolveConfig({ storePath: ":memory:", maxOutputBytes: 100 })
    const tool = makeSmartBashTool(client, makeShell(makeOutput(500)), store, smallMax)
    await exec(tool, { command: "big cmd", intent: "summarize" })
    const warnLogs = logs.filter((l) => l.level === "warn")
    assert.ok(warnLogs.length > 0, "expected at least one warn log")
    assert.ok(warnLogs.some((l) => l.message.includes("truncated")), "warn log should mention truncation")
    store.close()
  })

  it("emits an error log when the analyst throws", async () => {
    const store = makeStore()
    const logs: LogCall[] = []
    const failingClient: AnalystClient = {
      session: {
        create: async () => ({ data: { id: "s" } }),
        prompt: async () => { throw new Error("analyst down") },
        delete: async () => ({}),
      },
      app: { log: async (opts) => { logs.push(opts.body as LogCall); return {} } },
    }
    const tool = makeSmartBashTool(failingClient, makeShell(), store, defaultConfig)
    await assert.rejects(() => exec(tool, { command: "cmd", intent: "?" }), /analyst down/)
    const errorLogs = logs.filter((l) => l.level === "error")
    assert.ok(errorLogs.length > 0, "expected at least one error log")
    store.close()
  })
})

// ── smart_bash_query ──────────────────────────────────────────────────────────

describe("makeSmartBashQueryTool", () => {
  it("returns the analyst answer for a stored execution_id", async () => {
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
    const result = await exec(tool, { execution_id: "known-id", question: "How many tests were skipped?" })
    assert.equal(result, "3 tests skipped")
    store.close()
  })

  it("returns error JSON for unknown execution_id", async () => {
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
        prompt: async () => ({ data: { parts: [{ type: "text", text: `answer ${createCount}` }] } }),
        delete: async () => ({}),
      },
      app: { log: async () => ({}) },
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
          return { data: { parts: [{ type: "text", text: "ok" }] } }
        },
        delete: async () => ({}),
      },
      app: { log: async () => ({}) },
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
          return { data: { parts: [{ type: "text", text: "ok" }] } }
        },
        delete: async () => ({}),
      },
      app: { log: async () => ({}) },
    }

    const tool = makeAlwaysBashTool(capturingClient, makeShell(), store, defaultConfig)
    await exec(tool, { command: "npm install", intent: "Did dependencies install without errors?" })
    assert.equal(capturedQuestion, "Did dependencies install without errors?")
    store.close()
  })

  it("returns the analyst answer string", async () => {
    const store = makeStore()
    const tool = makeAlwaysBashTool(makeClient("success"), makeShell(), store, defaultConfig)
    const result = await exec(tool, { command: "echo hi" })
    assert.match(result, /success/)
    store.close()
  })
})
