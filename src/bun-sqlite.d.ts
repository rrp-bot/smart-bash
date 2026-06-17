// Minimal ambient types for bun:sqlite so tsc doesn't error on the import.
// The real implementation is provided by Bun at runtime.
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean })
    exec(sql: string): void
    prepare(sql: string): Statement
    close(): void
  }

  export interface Statement {
    run(params?: Record<string, unknown>): { changes: number; lastInsertRowid: number | bigint }
    get(params?: Record<string, unknown>): unknown
    all(params?: Record<string, unknown>): unknown[]
  }
}
