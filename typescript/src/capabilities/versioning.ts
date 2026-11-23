// Versioning rules. Schema changes are additive only; a breaking change is
// a new name, and the old one is deprecated with a date and kept until then.
// A product commits a snapshot of its catalog, and a test compares the live
// registry against it. The same comparison writes the tools changelog.

import { type AnyCapability, removeAfter } from './capability.js'
import type { JsonSchema } from './standard.js'
import { type Mode, modeOf, type Tier } from './tiers.js'

export interface CapabilitySnapshot {
  name: string
  title: string
  version: number
  risk: Tier
  mode: Mode
  audiences: string[]
  approval?: string
  input: JsonSchema
  output?: JsonSchema
  deprecated?: { since: string; removeAfter: string; use?: string }
}

export interface CatalogSnapshot {
  format: 1
  capabilities: CapabilitySnapshot[]
}

/** The catalog as plain data, sorted by name, ready to commit as JSON. */
export function snapshotOf(caps: readonly AnyCapability[]): CatalogSnapshot {
  return {
    format: 1,
    capabilities: [...caps]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        name: c.name,
        title: c.title,
        version: c.version,
        risk: c.risk,
        mode: modeOf(c.risk),
        audiences: [...c.audiences].sort(),
        ...(c.approval ? { approval: c.approval } : {}),
        input: c.inputJson,
        ...(c.outputJson ? { output: c.outputJson } : {}),
        ...(c.deprecated
          ? { deprecated: { since: c.deprecated.since, removeAfter: removeAfter(c.deprecated), ...(c.deprecated.use ? { use: c.deprecated.use } : {}) } }
          : {}),
      })),
  }
}

export type ChangeKind = 'added' | 'removed' | 'deprecated' | 'changed'

export interface Change {
  name: string
  kind: ChangeKind
  /** One line for the changelog. */
  detail: string
  /** True when a client written against the old catalog would break. */
  breaking: boolean
}

export interface CompareOptions {
  /** YYYY-MM-DD. A deprecated capability may be removed from this day. Defaults to today in UTC. */
  today?: string
}

const types = (s: JsonSchema): string[] | null => {
  if (s.type === undefined) return null
  return Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]
}
const props = (s: JsonSchema) => (s.properties && typeof s.properties === 'object' ? (s.properties as Record<string, JsonSchema>) : {})
const req = (s: JsonSchema) => new Set(Array.isArray(s.required) ? (s.required as string[]) : [])
const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
const at = (path: string, k: string) => (path ? `${path}.${k}` : k)

/**
 * The differences between two JSON Schemas, each marked breaking or not.
 * `input`: a caller sends values in the old shape and must still be accepted.
 * `output`: a caller reads values in the old shape and must still find them.
 */
export function diffSchema(before: JsonSchema, after: JsonSchema, side: 'input' | 'output', path = ''): { detail: string; breaking: boolean }[] {
  const out: { detail: string; breaking: boolean }[] = []
  const where = path || '(root)'
  const t0 = types(before)
  const t1 = types(after)
  if (t0 && t1) {
    const lost = t0.filter((t) => !t1.includes(t) && !(t === 'integer' && t1.includes('number')))
    const gained = t1.filter((t) => !t0.includes(t) && !(t === 'integer' && t0.includes('number')))
    if (side === 'input' && lost.length) out.push({ detail: `${side} ${where} no longer takes ${lost.join(', ')}`, breaking: true })
    if (side === 'output' && gained.length) out.push({ detail: `${side} ${where} may now be ${gained.join(', ')}`, breaking: true })
    if (side === 'input' && gained.length) out.push({ detail: `${side} ${where} also takes ${gained.join(', ')}`, breaking: false })
  } else if (t0 && !t1 && side === 'output') out.push({ detail: `${side} ${where} is no longer typed`, breaking: true })
  else if (!t0 && t1 && side === 'input' && before.const === undefined && !before.enum)
    out.push({ detail: `${side} ${where} is now limited to ${t1.join(', ')}`, breaking: true })

  if (Array.isArray(before.enum) || Array.isArray(after.enum)) {
    const e0 = (before.enum as unknown[] | undefined) ?? null
    const e1 = (after.enum as unknown[] | undefined) ?? null
    const k = (v: unknown) => JSON.stringify(v)
    if (side === 'input' && e1 && (!e0 || e0.some((v) => !e1.map(k).includes(k(v)))))
      out.push({ detail: `${side} ${where} accepts fewer values`, breaking: true })
    else if (side === 'output' && e0 && (!e1 || e1.some((v) => !e0.map(k).includes(k(v)))))
      out.push({ detail: `${side} ${where} may return new values`, breaking: true })
    else if (e0 && e1 && e0.length !== e1.length) out.push({ detail: `${side} ${where} values changed`, breaking: false })
  }
  if (k2(before.const) !== k2(after.const)) out.push({ detail: `${side} ${where} constant changed`, breaking: true })

  if (side === 'input') {
    for (const [lo, hi] of [
      ['minLength', 'maxLength'],
      ['minimum', 'maximum'],
      ['minItems', 'maxItems'],
    ] as const) {
      const a0 = num(before[lo])
      const a1 = num(after[lo])
      if (a1 !== undefined && (a0 === undefined || a1 > a0)) out.push({ detail: `${side} ${where} ${lo} raised to ${a1}`, breaking: true })
      const b0 = num(before[hi])
      const b1 = num(after[hi])
      if (b1 !== undefined && (b0 === undefined || b1 < b0)) out.push({ detail: `${side} ${where} ${hi} lowered to ${b1}`, breaking: true })
    }
    if (after.pattern !== undefined && after.pattern !== before.pattern) out.push({ detail: `${side} ${where} pattern changed`, breaking: true })
    if (after.format !== undefined && after.format !== before.format) out.push({ detail: `${side} ${where} format changed`, breaking: true })
  }

  const p0 = props(before)
  const p1 = props(after)
  const r0 = req(before)
  const r1 = req(after)
  for (const k of Object.keys(p0)) {
    if (!(k in p1)) {
      // A closed input refuses a field it no longer knows; an output reader misses it.
      out.push({ detail: `${side} field ${at(path, k)} removed`, breaking: true })
      continue
    }
    out.push(...diffSchema(p0[k]!, p1[k]!, side, at(path, k)))
  }
  for (const k of Object.keys(p1)) {
    if (k in p0) continue
    const required = r1.has(k)
    out.push({
      detail: `${side} gained ${required ? 'required' : 'optional'} field ${at(path, k)}`,
      breaking: side === 'input' && required,
    })
  }
  for (const k of r1) if (k in p0 && !r0.has(k) && side === 'input') out.push({ detail: `${side} field ${at(path, k)} is now required`, breaking: true })
  for (const k of r0) if (k in p1 && !r1.has(k) && side === 'output') out.push({ detail: `${side} field ${at(path, k)} may now be missing`, breaking: true })
  if (before.additionalProperties !== false && after.additionalProperties === false && side === 'input' && Object.keys(p0).length + Object.keys(p1).length > 0)
    out.push({ detail: `${side} ${where} now refuses unknown fields`, breaking: true })

  const i0 = before.items
  const i1 = after.items
  if (i0 && i1 && typeof i0 === 'object' && typeof i1 === 'object' && !Array.isArray(i0) && !Array.isArray(i1))
    out.push(...diffSchema(i0 as JsonSchema, i1 as JsonSchema, side, `${path}[]`))
  return out
}

const k2 = (v: unknown) => (v === undefined ? undefined : JSON.stringify(v))
const todayUtc = () => new Date().toISOString().slice(0, 10)

/** Every change from one catalog to the next, breaking ones marked. */
export function compareSnapshots(before: CatalogSnapshot, after: CatalogSnapshot, opts: CompareOptions = {}): Change[] {
  const today = opts.today ?? todayUtc()
  const old = new Map(before.capabilities.map((c) => [c.name, c]))
  const now = new Map(after.capabilities.map((c) => [c.name, c]))
  const changes: Change[] = []
  for (const [name, c] of now) {
    const o = old.get(name)
    if (!o) {
      changes.push({ name, kind: 'added', detail: `${c.title} (${c.risk}; ${c.audiences.join(', ')})`, breaking: false })
      continue
    }
    if (c.deprecated && !o.deprecated)
      changes.push({
        name,
        kind: 'deprecated',
        detail: `removed after ${c.deprecated.removeAfter}${c.deprecated.use ? `; use ${c.deprecated.use}` : ''}`,
        breaking: false,
      })
    const diffs = [...diffSchema(o.input, c.input, 'input'), ...diffSchema(o.output ?? {}, c.output ?? {}, 'output')]
    const lostDoors = o.audiences.filter((a) => !c.audiences.includes(a))
    const newDoors = c.audiences.filter((a) => !o.audiences.includes(a))
    if (lostDoors.length) diffs.push({ detail: `no longer on ${lostDoors.join(', ')}`, breaking: true })
    if (newDoors.length) diffs.push({ detail: `now also on ${newDoors.join(', ')}`, breaking: false })
    if (o.risk !== c.risk) diffs.push({ detail: `tier ${o.risk} to ${c.risk}`, breaking: false })
    if (o.approval !== c.approval) diffs.push({ detail: `approval ${o.approval ?? 'none'} to ${c.approval ?? 'none'}`, breaking: false })
    const schemaChanged = JSON.stringify([o.input, o.output]) !== JSON.stringify([c.input, c.output])
    if (c.version < o.version) diffs.push({ detail: `version went back from ${o.version} to ${c.version}`, breaking: true })
    else if (schemaChanged && c.version === o.version) diffs.push({ detail: `schema changed but version is still ${c.version}`, breaking: true })
    for (const d of diffs) changes.push({ name, kind: 'changed', ...d })
    if (c.version > o.version && !diffs.length) changes.push({ name, kind: 'changed', detail: `version ${o.version} to ${c.version}`, breaking: false })
  }
  for (const [name, o] of old) {
    if (now.has(name)) continue
    const due = o.deprecated && o.deprecated.removeAfter <= today
    changes.push({
      name,
      kind: 'removed',
      detail: due ? `deprecated since ${o.deprecated!.since}` : o.deprecated ? `removed before ${o.deprecated.removeAfter}` : 'removed without deprecation',
      breaking: !due,
    })
  }
  return changes
}

export class BreakingChangeError extends Error {
  constructor(readonly changes: Change[]) {
    super(`breaking catalog changes (make a new name and deprecate the old one):\n${changes.map((c) => `  ${c.name}: ${c.detail}`).join('\n')}`)
    this.name = 'BreakingChangeError'
  }
}

/** Throws `BreakingChangeError` when the new catalog breaks a client of the old one. Returns every change otherwise. */
export function assertAdditive(before: CatalogSnapshot, after: CatalogSnapshot, opts?: CompareOptions): Change[] {
  const changes = compareSnapshots(before, after, opts)
  const breaking = changes.filter((c) => c.breaking)
  if (breaking.length) throw new BreakingChangeError(breaking)
  return changes
}

export interface ChangelogOptions extends CompareOptions {
  /** YYYY-MM-DD for the heading. Defaults to `today`. */
  date?: string
}

const SECTIONS: [ChangeKind, string][] = [
  ['added', 'Added'],
  ['changed', 'Changed'],
  ['deprecated', 'Deprecated'],
  ['removed', 'Removed'],
]

/** The tools changelog between two catalogs, as Markdown. Empty when nothing changed. */
export function toolsChangelog(before: CatalogSnapshot, after: CatalogSnapshot, opts: ChangelogOptions = {}): string {
  const changes = compareSnapshots(before, after, opts)
  if (!changes.length) return ''
  const lines = [`## ${opts.date ?? opts.today ?? todayUtc()}`, '']
  for (const [kind, heading] of SECTIONS) {
    const these = changes.filter((c) => c.kind === kind)
    if (!these.length) continue
    lines.push(`### ${heading}`, '')
    for (const c of these) lines.push(`- \`${c.name}\`: ${c.detail}${c.breaking ? ' (breaking)' : ''}`)
    lines.push('')
  }
  return lines.join('\n')
}
