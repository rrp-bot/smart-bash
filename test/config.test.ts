import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { homedir } from "os"
import { join } from "path"
import { resolveConfig, DEFAULT_CONFIG } from "../src/config.ts"
import type { SmartBashConfig } from "../src/config.ts"

describe("resolveConfig", () => {
  // ── defaults ──────────────────────────────────────────────────────────────

  describe("defaults", () => {
    it("returns all defaults when called with no arguments", () => {
      const cfg = resolveConfig()
      assert.equal(cfg.mode, "auto")
      assert.equal(cfg.maxOutputBytes, 2_000_000)
      assert.ok(cfg.defaultIntent.length > 0)
      assert.equal(cfg.analystModel, undefined)
    })

    it("storePath default resolves to an absolute path under home dir", () => {
      const cfg = resolveConfig()
      assert.ok(cfg.storePath.startsWith("/"))
      assert.ok(cfg.storePath.includes(homedir()))
    })

    it("matches DEFAULT_CONFIG shape (except path expansion)", () => {
      const cfg = resolveConfig()
      assert.equal(cfg.mode, DEFAULT_CONFIG.mode)
      assert.equal(cfg.maxOutputBytes, DEFAULT_CONFIG.maxOutputBytes)
      assert.equal(cfg.defaultIntent, DEFAULT_CONFIG.defaultIntent)
    })
  })

  // ── partial overrides ─────────────────────────────────────────────────────

  describe("partial overrides", () => {
    it("overrides mode to always", () => {
      assert.equal(resolveConfig({ mode: "always" }).mode, "always")
    })

    it("overrides mode to never", () => {
      assert.equal(resolveConfig({ mode: "never" }).mode, "never")
    })

    it("overrides mode to auto", () => {
      assert.equal(resolveConfig({ mode: "auto" }).mode, "auto")
    })

    it("overrides maxOutputBytes", () => {
      const cfg = resolveConfig({ maxOutputBytes: 512 })
      assert.equal(cfg.maxOutputBytes, 512)
    })

    it("overrides defaultIntent", () => {
      const cfg = resolveConfig({ defaultIntent: "custom intent" })
      assert.equal(cfg.defaultIntent, "custom intent")
    })

    it("preserves analystModel when set", () => {
      const cfg = resolveConfig({ analystModel: "anthropic/claude-haiku-4-20250514" })
      assert.equal(cfg.analystModel, "anthropic/claude-haiku-4-20250514")
    })

    it("leaves analystModel undefined when not set", () => {
      assert.equal(resolveConfig({}).analystModel, undefined)
    })

    it("does not mutate DEFAULT_CONFIG", () => {
      resolveConfig({ mode: "always", maxOutputBytes: 1 })
      assert.equal(DEFAULT_CONFIG.mode, "auto")
      assert.equal(DEFAULT_CONFIG.maxOutputBytes, 2_000_000)
    })
  })

  // ── tilde expansion ───────────────────────────────────────────────────────

  describe("tilde expansion in storePath", () => {
    it("expands ~/... to an absolute path", () => {
      const cfg = resolveConfig({ storePath: "~/mydb.sqlite" })
      assert.equal(cfg.storePath, join(homedir(), "mydb.sqlite"))
      assert.ok(!cfg.storePath.startsWith("~"))
    })

    it("expands bare ~ to home dir", () => {
      const cfg = resolveConfig({ storePath: "~" })
      assert.equal(cfg.storePath, homedir())
    })

    it("does not modify already-absolute paths", () => {
      const cfg = resolveConfig({ storePath: "/absolute/path/store.db" })
      assert.equal(cfg.storePath, "/absolute/path/store.db")
    })

    it("does not modify relative paths that don't start with ~", () => {
      const cfg = resolveConfig({ storePath: "relative/path/store.db" })
      assert.equal(cfg.storePath, "relative/path/store.db")
    })
  })

  // ── full config override ──────────────────────────────────────────────────

  it("applies a full config correctly", () => {
    const full: SmartBashConfig = {
      mode: "never",
      storePath: "/tmp/test.db",
      maxOutputBytes: 100_000,
      defaultIntent: "Did it work?",
      analystModel: "openai/gpt-4o-mini",
      analystTimeoutMs: 30_000,
      analystSystemPrompt: "Be terse.",
    }
    const cfg = resolveConfig(full)
    assert.deepEqual(cfg, full)
  })
})
