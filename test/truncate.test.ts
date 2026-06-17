import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { truncate, truncateStreams } from "../src/truncate.ts"
import { makeOutput } from "./fixtures/outputs.ts"

describe("truncate", () => {
  // ── within budget ─────────────────────────────────────────────────────────

  describe("within budget", () => {
    it("returns text unchanged when within limit", () => {
      const text = "hello world"
      const result = truncate(text, 1000)
      assert.equal(result.text, text)
      assert.equal(result.truncated, false)
      assert.equal(result.omittedBytes, 0)
    })

    it("returns text unchanged when exactly at limit", () => {
      const text = makeOutput(100)
      const result = truncate(text, 100)
      assert.equal(result.text, text)
      assert.equal(result.truncated, false)
      assert.equal(result.omittedBytes, 0)
    })

    it("handles empty string", () => {
      const result = truncate("", 100)
      assert.equal(result.text, "")
      assert.equal(result.truncated, false)
      assert.equal(result.omittedBytes, 0)
    })
  })

  // ── truncation triggered ──────────────────────────────────────────────────

  describe("truncation triggered", () => {
    it("sets truncated=true when 1 byte over limit", () => {
      const text = makeOutput(101)
      const result = truncate(text, 100)
      assert.equal(result.truncated, true)
    })

    it("gap notice contains the word 'omitted'", () => {
      const text = makeOutput(200)
      const result = truncate(text, 100)
      assert.ok(result.text.includes("omitted"))
    })

    it("omittedBytes matches bytes skipped", () => {
      const result = truncate(makeOutput(200), 100)
      // half = 50, so omitted = 200 - 50 - 50 = 100
      assert.equal(result.omittedBytes, 100)
    })

    it("head is the first half of maxBytes", () => {
      const text = "A".repeat(50) + "B".repeat(50) + "C".repeat(100)
      const result = truncate(text, 100)
      assert.ok(result.text.startsWith("A".repeat(50)))
    })

    it("tail is the last half of maxBytes", () => {
      const text = "A".repeat(100) + "B".repeat(50) + "C".repeat(50)
      const result = truncate(text, 100)
      const parts = result.text.split(/\.\.\.\[omitted.*?\]\.\.\.\n/)
      assert.equal(parts[parts.length - 1], "C".repeat(50))
    })

    it("result contains both head and tail", () => {
      const head = "HEAD".repeat(25)  // 100 chars = 100 bytes
      const tail = "TAIL".repeat(25)  // 100 chars = 100 bytes
      const middle = "X".repeat(500)
      const text = head + middle + tail

      const result = truncate(text, 200)  // half = 100
      assert.ok(result.text.startsWith(head))
      assert.ok(result.text.endsWith(tail))
    })

    it("10x oversized output produces valid truncation", () => {
      const result = truncate(makeOutput(20_000), 1000)
      assert.equal(result.truncated, true)
      assert.equal(result.omittedBytes, 19_000)
    })
  })

  // ── boundary: maxBytes=2 ──────────────────────────────────────────────────

  describe("boundary: maxBytes=2", () => {
    it("produces single-char head and tail", () => {
      const result = truncate("abcde", 2)
      assert.equal(result.truncated, true)
      assert.ok(result.text.startsWith("a"))
      assert.ok(result.text.endsWith("e"))
    })
  })
})

// ── truncateStreams ───────────────────────────────────────────────────────────

describe("truncateStreams", () => {
  it("returns both streams unchanged when within budget", () => {
    const r = truncateStreams("stdout", "stderr", 100)
    assert.equal(r.stdout, "stdout")
    assert.equal(r.stderr, "stderr")
    assert.equal(r.truncated, false)
  })

  it("truncates stdout independently of stderr", () => {
    const bigStdout = makeOutput(500)
    const r = truncateStreams(bigStdout, "small", 100)
    assert.equal(r.truncated, true)
    assert.equal(r.stderr, "small")
    assert.ok(r.stdout.length < bigStdout.length)
  })

  it("truncates stderr independently of stdout", () => {
    const bigStderr = makeOutput(500)
    const r = truncateStreams("small", bigStderr, 100)
    assert.equal(r.truncated, true)
    assert.equal(r.stdout, "small")
  })

  it("truncated=true when either stream exceeds budget", () => {
    const r = truncateStreams(makeOutput(200), makeOutput(50), 100)
    assert.equal(r.truncated, true)
  })

  it("truncated=false when both streams are within budget", () => {
    const r = truncateStreams(makeOutput(40), makeOutput(40), 100)
    assert.equal(r.truncated, false)
  })

  it("handles empty strings", () => {
    const r = truncateStreams("", "", 100)
    assert.equal(r.stdout, "")
    assert.equal(r.stderr, "")
    assert.equal(r.truncated, false)
  })
})
