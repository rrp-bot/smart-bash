import { Database } from "bun:sqlite"
import { mkdirSync } from "fs"
import { dirname } from "path"

export interface ExecutionRecord {
  id: string
  command: string
  stdout: string
  stderr: string
  exitCode: number
  /** True if stdout or stderr were truncated to fit maxOutputBytes. */
  truncated: boolean
  createdAt: number
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS executions (
  id         TEXT    PRIMARY KEY,
  command    TEXT    NOT NULL,
  stdout     TEXT    NOT NULL,
  stderr     TEXT    NOT NULL,
  exit_code  INTEGER NOT NULL,
  truncated  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)
`

const CREATE_IDX = `
CREATE INDEX IF NOT EXISTS executions_created_at ON executions (created_at)
`

/**
 * SQLite-backed store for command execution records.
 *
 * Pass ":memory:" as `dbPath` for an in-memory database (useful in tests).
 */
export class ExecutionStore {
  private db: Database

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec(CREATE_TABLE)
    this.db.exec(CREATE_IDX)
  }

  set(record: ExecutionRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO executions
        (id, command, stdout, stderr, exit_code, truncated, created_at)
      VALUES
        ($id, $command, $stdout, $stderr, $exitCode, $truncated, $createdAt)
    `)

    stmt.run({
      $id: record.id,
      $command: record.command,
      $stdout: record.stdout,
      $stderr: record.stderr,
      $exitCode: record.exitCode,
      $truncated: record.truncated ? 1 : 0,
      $createdAt: record.createdAt,
    })
  }

  get(id: string): ExecutionRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, command, stdout, stderr, exit_code, truncated, created_at
      FROM executions
      WHERE id = $id
    `)

    const row = stmt.get({ $id: id }) as RawRow | null
    return row ? rowToRecord(row) : null
  }

  list(): ExecutionRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, command, stdout, stderr, exit_code, truncated, created_at
      FROM executions
      ORDER BY created_at DESC
    `)

    return (stmt.all() as RawRow[]).map(rowToRecord)
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM executions WHERE id = $id")
    const result = stmt.run({ $id: id })
    return result.changes > 0
  }

  /**
   * Remove all records whose `createdAt` timestamp is older than `olderThanMs`
   * milliseconds ago. Returns the number of rows deleted.
   */
  pruneOlderThan(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs
    const stmt = this.db.prepare(
      "DELETE FROM executions WHERE created_at < $cutoff",
    )
    const result = stmt.run({ $cutoff: cutoff })
    return result.changes
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close()
  }
}

// ---- internal helpers -------------------------------------------------------

interface RawRow {
  id: string
  command: string
  stdout: string
  stderr: string
  exit_code: number
  truncated: number
  created_at: number
}

function rowToRecord(row: RawRow): ExecutionRecord {
  return {
    id: row.id,
    command: row.command,
    stdout: row.stdout,
    stderr: row.stderr,
    exitCode: row.exit_code,
    truncated: row.truncated !== 0,
    createdAt: row.created_at,
  }
}
