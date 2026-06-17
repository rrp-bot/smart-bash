/**
 * Reusable fixtures for smart-bash tests.
 */

/** A typical successful `npm test` output (~400 bytes, within any limit). */
export const SMALL_STDOUT = `
> my-project@1.0.0 test
> jest --coverage

 PASS  src/utils.test.ts
 PASS  src/api.test.ts

Test Suites: 2 passed, 2 total
Tests:       47 passed, 3 skipped, 50 total
Snapshots:   0 total
Time:        2.341 s
Coverage:    87.4%
`.trim()

/** Stderr from a build warning. */
export const SMALL_STDERR = `
warning: unused variable 'x' at line 42
warning: deprecated API usage at line 99
`.trim()

/**
 * Generate a string of exactly `bytes` bytes (ASCII-safe so byte length ===
 * char length).
 */
export function makeOutput(bytes: number, char = "x"): string {
  return char.repeat(bytes)
}

/**
 * A large stdout that intentionally exceeds the default 2 MB limit.
 * Filled with line-structured content to make truncation visible in tests.
 */
export const LARGE_STDOUT: string = (() => {
  const lines: string[] = []
  for (let i = 0; i < 50_000; i++) {
    lines.push(`[${i.toString().padStart(6, "0")}] ${"log entry ".repeat(5).trim()}`)
  }
  return lines.join("\n")
})()

/** A minimal ExecutionRecord for use in analyst / tool tests. */
export const SAMPLE_RECORD = {
  id: "test-exec-id-001",
  command: "npm test",
  stdout: SMALL_STDOUT,
  stderr: SMALL_STDERR,
  exitCode: 0,
  truncated: false,
  createdAt: 1_700_000_000_000,
}

/** A truncated ExecutionRecord simulating large output. */
export const TRUNCATED_RECORD = {
  id: "test-exec-id-002",
  command: "cat /var/log/huge.log",
  stdout: makeOutput(1_000_000, "a") + "\n...[omitted 500,000 bytes]...\n" + makeOutput(500_000, "z"),
  stderr: "",
  exitCode: 0,
  truncated: true,
  createdAt: 1_700_000_001_000,
}
