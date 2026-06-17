export interface TruncationResult {
  text: string
  truncated: boolean
  /** Number of bytes omitted from the middle (0 when not truncated). */
  omittedBytes: number
}

/**
 * Truncate `text` to at most `maxBytes` using a head+tail strategy.
 *
 * When `text` exceeds `maxBytes` the result contains:
 *   - the first  floor(maxBytes / 2) bytes
 *   - a gap notice: `\n...[omitted N bytes]...\n`
 *   - the last   floor(maxBytes / 2) bytes
 *
 * The gap notice itself is not counted against the byte budget. The returned
 * text will never exceed maxBytes + notice.length bytes.
 *
 * When `text` is within budget it is returned unchanged with truncated=false.
 */
export function truncate(text: string, maxBytes: number): TruncationResult {
  const buf = Buffer.from(text, "utf8")

  if (buf.length <= maxBytes) {
    return { text, truncated: false, omittedBytes: 0 }
  }

  const half = Math.floor(maxBytes / 2)
  const head = buf.subarray(0, half).toString("utf8")
  const tail = buf.subarray(buf.length - half).toString("utf8")
  const omittedBytes = buf.length - half * 2
  const notice = `\n...[omitted ${omittedBytes.toLocaleString()} bytes]...\n`

  return {
    text: head + notice + tail,
    truncated: true,
    omittedBytes,
  }
}

/**
 * Apply truncation independently to stdout and stderr.
 * Each stream gets its own `maxBytes` budget.
 */
export function truncateStreams(
  stdout: string,
  stderr: string,
  maxBytes: number,
): {
  stdout: string
  stderr: string
  truncated: boolean
} {
  const outResult = truncate(stdout, maxBytes)
  const errResult = truncate(stderr, maxBytes)

  return {
    stdout: outResult.text,
    stderr: errResult.text,
    truncated: outResult.truncated || errResult.truncated,
  }
}
