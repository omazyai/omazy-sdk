// Product-defined tags on model calls, sent in the client's `metadata`. The platform stores the four run tags
// (unit, unit_version, prompt_version, run_id) in columns of their own and up
// to eight more keys in a tags column, and the usage API groups by any of
// them. A call sent as `role:<name>` has its role in the platform's own
// ledger column; only a call whose role the product's `roles` map turned into
// a model name carries a `role` tag, and only when the product left a key
// free. The rules here are the platform's, so a bad tag fails in the product,
// not as a 400 on a live call.

import type { Metadata } from '../types.js'

/** A tag value as the client's `Metadata` takes it. */
export type TagValue = Exclude<Metadata[string], undefined>
/** The product's own keys of a call's `Metadata`. */
export type Tags = Readonly<Record<string, TagValue>>

/** Keys the kit sets. A product tag cannot use them. */
export const RESERVED_TAGS: readonly string[] = ['unit', 'unit_version', 'prompt_version', 'run_id', 'role']
export const TAG_KEY = /^[a-z][a-z0-9_.-]*$/
export const TAG_KEY_MAX = 40
export const TAG_VALUE_MAX_BYTES = 200
export const MAX_TAGS = 8

const bytes = (s: string) => new TextEncoder().encode(s).length

export class TagError extends Error {
  override readonly name = 'TagError'
}

/** Every rule a set of product tags breaks, as sentences. Empty means it is sound. */
export function tagProblems(tags: unknown, where = 'tags'): string[] {
  if (tags === undefined) return []
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) return [`${where} must be an object of keys to values`]
  const p: string[] = []
  const entries = Object.entries(tags)
  if (entries.length > MAX_TAGS) p.push(`${where} has ${entries.length} keys; at most ${MAX_TAGS} besides the kit's own`)
  for (const [k, v] of entries) {
    if (RESERVED_TAGS.includes(k)) p.push(`${where}.${k} is set by the kit`)
    else if (!TAG_KEY.test(k) || k.length > TAG_KEY_MAX) p.push(`${where} key ${k} must match [a-z][a-z0-9_.-]* and be at most ${TAG_KEY_MAX} characters`)
    if (!['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))) p.push(`${where}.${k} must be a string, a number or a boolean`)
    else if (bytes(String(v)) > TAG_VALUE_MAX_BYTES) p.push(`${where}.${k} is over ${TAG_VALUE_MAX_BYTES} bytes`)
  }
  return p
}

/**
 * The product tags of one call: the unit's, then the run's, then the call's,
 * later ones replacing earlier keys. Throws `TagError` when the result breaks
 * a rule, such as more than eight keys in all. Values go out as text, which
 * is how the platform stores them.
 */
export function mergeTags(...layers: (Tags | undefined)[]): Record<string, string> {
  const merged: Record<string, TagValue> = {}
  for (const l of layers) if (l) Object.assign(merged, l)
  const p = tagProblems(merged)
  if (p.length) throw new TagError(p.join('; '))
  return Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, String(v)]))
}
