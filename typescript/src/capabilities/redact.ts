// Personal data out of logs. A capability names the paths of its personal
// fields; these helpers replace them before anything is written down.

export const REDACTED = '[redacted]'

/**
 * A copy of `value` with every field on `paths` replaced by `[redacted]`.
 * A path is dotted; `*` matches any key or array index: `rows.*.email`.
 * Paths that are not there are skipped. `value` is not changed.
 */
export function redact<T>(value: T, paths: readonly string[]): T {
  if (!paths.length || value === null || typeof value !== 'object') return value
  const copy = JSON.parse(JSON.stringify(value)) as T
  for (const p of paths) mask(copy, p.split('.'))
  return copy
}

function mask(node: unknown, path: string[]): void {
  if (node === null || typeof node !== 'object' || path.length === 0) return
  const [head, ...rest] = path as [string, ...string[]]
  const obj = node as Record<string, unknown>
  const keys = head === '*' ? Object.keys(obj) : Object.prototype.hasOwnProperty.call(obj, head) ? [head] : []
  for (const k of keys) {
    if (rest.length === 0) {
      if (obj[k] !== undefined && obj[k] !== null) obj[k] = REDACTED
    } else mask(obj[k], rest)
  }
}

/**
 * Cuts a string to at most `maxBytes` of UTF-8 without splitting a
 * character, and marks the cut with `…`. Byte slicing would leave half a
 * Bangla letter, which Postgres and some log stores refuse outright.
 */
export function truncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder()
  if (enc.encode(s).length <= maxBytes) return s
  const budget = maxBytes - 3 // the ellipsis is three bytes
  let used = 0
  let out = ''
  for (const ch of s) {
    const n = enc.encode(ch).length
    if (used + n > budget) break
    used += n
    out += ch
  }
  return `${out}…`
}

/** Redacted JSON, at most `maxBytes` (4 KB by default), for a request log. */
export function redactedJson(value: unknown, paths: readonly string[], maxBytes = 4096): string {
  return truncateUtf8(JSON.stringify(redact(value, paths)) ?? 'null', maxBytes)
}
