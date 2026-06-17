import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createSmartBashPlugin } from "../src/index.ts"
import { resolveConfig } from "../src/config.ts"

// ── mock plugin context ───────────────────────────────────────────────────────

function makeMockCtx() {
  const shellFn = async (_strings: TemplateStringsArray, ..._values: unknown[]) => ({
    stdout: Buffer.from("mock output"),
    stderr: Buffer.from(""),
    exitCode: 0,
  })
  shellFn.nothrow = async () => ({
    stdout: Buffer.from("mock output"),
    stderr: Buffer.from(""),
    exitCode: 0,
  })

  return {
    client: {
      session: {
        create: async () => ({ data: { id: "sess-mock" } }),
        prompt: async () => ({
          data: { info: { structured_output: { answer: "mocked" } } },
        }),
        delete: async () => ({}),
      },
    },
    $: Object.assign(shellFn, {
      nothrow: shellFn.nothrow,
    }),
    project: {},
    directory: "/tmp",
    worktree: "/tmp",
  }
}

// ── mode: "auto" (default) ────────────────────────────────────────────────────

describe('createSmartBashPlugin — mode: "auto"', () => {
  it("registers smart_bash tool", async () => {
    const plugin = createSmartBashPlugin({ mode: "auto", storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.ok("smart_bash" in (hooks.tool ?? {}))
  })

  it("registers smart_bash_query tool", async () => {
    const plugin = createSmartBashPlugin({ mode: "auto", storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.ok("smart_bash_query" in (hooks.tool ?? {}))
  })

  it("does NOT register bash override in auto mode", async () => {
    const plugin = createSmartBashPlugin({ mode: "auto", storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.ok(!("bash" in (hooks.tool ?? {})))
  })
})

// ── mode: "always" ────────────────────────────────────────────────────────────

describe('createSmartBashPlugin — mode: "always"', () => {
  it("registers bash override in always mode", async () => {
    const plugin = createSmartBashPlugin({ mode: "always", storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.ok("bash" in (hooks.tool ?? {}))
  })

  it("still registers smart_bash in always mode", async () => {
    const plugin = createSmartBashPlugin({ mode: "always", storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.ok("smart_bash" in (hooks.tool ?? {}))
  })

  it("still registers smart_bash_query in always mode", async () => {
    const plugin = createSmartBashPlugin({ mode: "always", storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.ok("smart_bash_query" in (hooks.tool ?? {}))
  })
})

// ── mode: "never" ─────────────────────────────────────────────────────────────

describe('createSmartBashPlugin — mode: "never"', () => {
  it("registers smart_bash in never mode", async () => {
    const plugin = createSmartBashPlugin({ mode: "never", storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.ok("smart_bash" in (hooks.tool ?? {}))
  })

  it("registers smart_bash_query in never mode", async () => {
    const plugin = createSmartBashPlugin({ mode: "never", storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.ok("smart_bash_query" in (hooks.tool ?? {}))
  })

  it("does NOT register bash override in never mode", async () => {
    const plugin = createSmartBashPlugin({ mode: "never", storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.ok(!("bash" in (hooks.tool ?? {})))
  })
})

// ── factory with no config ────────────────────────────────────────────────────

describe("createSmartBashPlugin — no config (defaults)", () => {
  it("uses auto mode by default", () => {
    const cfg = resolveConfig()
    assert.equal(cfg.mode, "auto")
  })

  it("default export is a plugin function (not a factory)", async () => {
    const { default: defaultExport } = await import("../src/index.ts")
    // The default export must be a Plugin — an async function that accepts ctx
    // and returns hooks. It should NOT be the factory (which takes config).
    // We verify it behaves as a plugin: called with ctx it returns { tool: ... }
    assert.equal(typeof defaultExport, "function")
    const hooks = await (defaultExport as (ctx: never) => Promise<{ tool?: unknown }>)(makeMockCtx() as never)
    assert.ok(hooks.tool !== undefined)
  })

  it("plugin returns a hooks object with tool key", async () => {
    const plugin = createSmartBashPlugin({ storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.equal(typeof hooks, "object")
    assert.ok(hooks.tool !== undefined)
  })
})

// ── config propagation ────────────────────────────────────────────────────────

describe("createSmartBashPlugin — config propagation", () => {
  it("partial config is merged with defaults without throwing", async () => {
    const plugin = createSmartBashPlugin({ maxOutputBytes: 1000, storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.ok(hooks.tool !== undefined)
  })

  it("registers exactly 2 tools in auto mode (smart_bash, smart_bash_query)", async () => {
    const plugin = createSmartBashPlugin({ mode: "auto", storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.equal(Object.keys(hooks.tool ?? {}).length, 2)
  })

  it("registers exactly 3 tools in always mode (bash, smart_bash, smart_bash_query)", async () => {
    const plugin = createSmartBashPlugin({ mode: "always", storePath: ":memory:" })
    const hooks = await plugin(makeMockCtx() as never)
    assert.equal(Object.keys(hooks.tool ?? {}).length, 3)
  })
})
