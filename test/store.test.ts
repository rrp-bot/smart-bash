import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ExecutionStore } from "../src/store.ts"
import { SAMPLE_RECORD, TRUNCATED_RECORD } from "./fixtures/outputs.ts"

function makeStore() {
  return new ExecutionStore(":memory:")
}

describe("ExecutionStore", () => {
  // ── set / get ────────────────────────────────────────────────────────────

  describe("set + get", () => {
    it("returns the stored record with all fields intact", () => {
      const store = makeStore()
      store.set(SAMPLE_RECORD)
      const got = store.get(SAMPLE_RECORD.id)

      assert.ok(got !== null)
      assert.equal(got.id, SAMPLE_RECORD.id)
      assert.equal(got.command, SAMPLE_RECORD.command)
      assert.equal(got.stdout, SAMPLE_RECORD.stdout)
      assert.equal(got.stderr, SAMPLE_RECORD.stderr)
      assert.equal(got.exitCode, SAMPLE_RECORD.exitCode)
      assert.equal(got.truncated, false)
      assert.equal(got.createdAt, SAMPLE_RECORD.createdAt)
      store.close()
    })

    it("stores truncated=true correctly", () => {
      const store = makeStore()
      store.set(TRUNCATED_RECORD)
      const got = store.get(TRUNCATED_RECORD.id)
      assert.equal(got!.truncated, true)
      store.close()
    })

    it("returns null for an unknown id", () => {
      const store = makeStore()
      assert.equal(store.get("does-not-exist"), null)
      store.close()
    })

    it("overwrites an existing record on duplicate id (INSERT OR REPLACE)", () => {
      const store = makeStore()
      store.set(SAMPLE_RECORD)
      const updated = { ...SAMPLE_RECORD, stdout: "updated output" }
      store.set(updated)

      const got = store.get(SAMPLE_RECORD.id)
      assert.equal(got!.stdout, "updated output")
      store.close()
    })

    it("handles empty stdout and stderr", () => {
      const store = makeStore()
      const record = { ...SAMPLE_RECORD, id: "empty-streams", stdout: "", stderr: "" }
      store.set(record)
      const got = store.get("empty-streams")
      assert.equal(got!.stdout, "")
      assert.equal(got!.stderr, "")
      store.close()
    })

    it("handles a large record (>1 MB string)", () => {
      const store = makeStore()
      const big = { ...SAMPLE_RECORD, id: "big", stdout: "x".repeat(1_500_000) }
      store.set(big)
      const got = store.get("big")
      assert.equal(got!.stdout.length, 1_500_000)
      store.close()
    })

    it("handles non-zero exit codes", () => {
      const store = makeStore()
      const record = { ...SAMPLE_RECORD, id: "fail", exitCode: 127 }
      store.set(record)
      assert.equal(store.get("fail")!.exitCode, 127)
      store.close()
    })
  })

  // ── list ─────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns an empty array when store is empty", () => {
      const store = makeStore()
      assert.deepEqual(store.list(), [])
      store.close()
    })

    it("returns all stored records", () => {
      const store = makeStore()
      store.set(SAMPLE_RECORD)
      store.set(TRUNCATED_RECORD)
      assert.equal(store.list().length, 2)
      store.close()
    })

    it("returns records ordered by createdAt DESC", () => {
      const store = makeStore()
      const older = { ...SAMPLE_RECORD, id: "older", createdAt: 1_000 }
      const newer = { ...SAMPLE_RECORD, id: "newer", createdAt: 2_000 }
      store.set(older)
      store.set(newer)

      const ids = store.list().map((r) => r.id)
      assert.equal(ids[0], "newer")
      assert.equal(ids[1], "older")
      store.close()
    })
  })

  // ── delete ────────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("removes the record and returns true", () => {
      const store = makeStore()
      store.set(SAMPLE_RECORD)
      const deleted = store.delete(SAMPLE_RECORD.id)
      assert.equal(deleted, true)
      assert.equal(store.get(SAMPLE_RECORD.id), null)
      store.close()
    })

    it("returns false when the id does not exist", () => {
      const store = makeStore()
      assert.equal(store.delete("ghost-id"), false)
      store.close()
    })

    it("does not affect other records", () => {
      const store = makeStore()
      store.set(SAMPLE_RECORD)
      store.set(TRUNCATED_RECORD)
      store.delete(SAMPLE_RECORD.id)

      assert.ok(store.get(TRUNCATED_RECORD.id) !== null)
      store.close()
    })
  })

  // ── pruneOlderThan ────────────────────────────────────────────────────────

  describe("pruneOlderThan", () => {
    it("removes records older than the threshold", () => {
      const store = makeStore()
      const old = { ...SAMPLE_RECORD, id: "old", createdAt: Date.now() - 10_000 }
      store.set(old)

      const removed = store.pruneOlderThan(5_000)
      assert.equal(removed, 1)
      assert.equal(store.get("old"), null)
      store.close()
    })

    it("keeps records newer than the threshold", () => {
      const store = makeStore()
      const fresh = { ...SAMPLE_RECORD, id: "fresh", createdAt: Date.now() }
      store.set(fresh)

      store.pruneOlderThan(60_000)
      assert.ok(store.get("fresh") !== null)
      store.close()
    })

    it("returns 0 when nothing is pruned", () => {
      const store = makeStore()
      // Use a record stamped right now so it's newer than any threshold
      store.set({ ...SAMPLE_RECORD, id: "fresh-now", createdAt: Date.now() })
      assert.equal(store.pruneOlderThan(1), 0)
      store.close()
    })

    it("can prune multiple records at once", () => {
      const store = makeStore()
      const age = 100_000
      for (let i = 0; i < 5; i++) {
        store.set({ ...SAMPLE_RECORD, id: `old-${i}`, createdAt: Date.now() - age })
      }
      store.set({ ...SAMPLE_RECORD, id: "keeper", createdAt: Date.now() })

      const removed = store.pruneOlderThan(age - 1_000)
      assert.equal(removed, 5)
      assert.ok(store.get("keeper") !== null)
      store.close()
    })
  })

  // ── DB file creation ──────────────────────────────────────────────────────

  describe("DB file creation", () => {
    it("creates the database file and its parent directory if missing", () => {
      const tmp = mkdtempSync(join(tmpdir(), "smart-bash-test-"))
      const dbPath = join(tmp, "nested", "dir", "store.db")

      const s = new ExecutionStore(dbPath)
      s.set(SAMPLE_RECORD)
      s.close()

      assert.ok(existsSync(dbPath))
      rmSync(tmp, { recursive: true, force: true })
    })
  })
})
