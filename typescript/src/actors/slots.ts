// Slots matched to the target's input schema: the order, which are required,
// how a read value becomes the value the target takes, the schema checks a
// slot can run on its own, and how a value reads to a person.

import type { BaseCtx } from '../capabilities/capability.js'
import type { JsonSchema } from '../capabilities/standard.js'
import type { Actor, SlotDef, Words } from './actor.js'
import { ActorError } from './actor.js'

export interface ResolvedSlot<C extends BaseCtx = BaseCtx> extends SlotDef<C> {
  /** The field's JSON Schema in the target's input. */
  prop: JsonSchema
  required: boolean
  threshold: number
  /** Whether the extractor may fill it. */
  extractable: boolean
}

const propsOf = (input: JsonSchema) => (input.properties ?? {}) as Record<string, JsonSchema>

/** The actor's slots against the target's input schema, in asking order. Throws `ActorError` on a slot the target lacks. */
export function resolveSlots<C extends BaseCtx>(a: Actor<C>, input: JsonSchema): ResolvedSlot<C>[] {
  const props = propsOf(input)
  const required = new Set((input.required as string[] | undefined) ?? [])
  const problems: string[] = []
  const listed = new Set(a.slots.map((s) => s.name))
  const defs: SlotDef<C>[] = [...a.slots]
  if (!a.only) for (const name of Object.keys(props)) if (!listed.has(name)) defs.push({ name })
  for (const s of a.slots) if (!props[s.name]) problems.push(`slot ${s.name} is not a field of ${a.target}`)
  if (a.only) {
    for (const name of required) {
      const p = props[name]
      if (!listed.has(name) && p && p.default === undefined) problems.push(`${a.target} requires ${name}, which is not a slot`)
    }
  }
  if (problems.length) throw new ActorError(a.id, problems)
  return defs.map((s) => {
    const prop = props[s.name]!
    const derived = typeof s.derive === 'function'
    const hasDefault = s.default !== undefined || prop.default !== undefined
    return {
      ...s,
      prop,
      required: s.required ?? (required.has(s.name) && !hasDefault && !derived),
      threshold: s.threshold ?? a.threshold,
      extractable: !derived && s.extract !== false,
    }
  })
}

// ---------------------------------------------------------------- words

export const wordsIn = (w: Words | undefined, language: string): string | undefined => {
  if (w === undefined) return undefined
  if (typeof w === 'string') return w
  return w[language] ?? w[language.split('-')[0]!] ?? w.en ?? Object.values(w)[0]
}

/** `tenant_id` reads "tenant", `external_ref` reads "external ref". */
export const humanise = (name: string) => name.replace(/_id$/, '').replace(/_/g, ' ').trim() || name

export function labelOf(s: Pick<ResolvedSlot, 'name' | 'label' | 'prop'>, language: string): string {
  return wordsIn(s.label, language) ?? (typeof s.prop.title === 'string' ? s.prop.title : humanise(s.name))
}

// ---------------------------------------------------------------- values

const BANGLA_DIGITS = /[০-৯]/g
const toAsciiDigits = (s: string) => s.replace(BANGLA_DIGITS, (d) => String(d.charCodeAt(0) - 0x09e6))

const typesOf = (prop: JsonSchema): string[] => (Array.isArray(prop.type) ? (prop.type as string[]) : typeof prop.type === 'string' ? [prop.type] : [])

const YES = new Set(['yes', 'y', 'true', '1', 'হ্যাঁ', 'হ্যা', 'জি'])
const NO = new Set(['no', 'n', 'false', '0', 'না'])

/**
 * The value a slot takes from what was read: the slot's own `parse`, then
 * the schema's type (numbers with commas or Bangla digits, yes and no, an
 * enum ignoring case). Returns `{ issue }` when it cannot be read as one.
 */
export function normalise(s: Pick<ResolvedSlot, 'parse' | 'prop'>, raw: unknown): { value: unknown } | { issue: string } {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { issue: 'empty' }
  if (s.parse) {
    try {
      const v = s.parse(raw)
      return v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? { issue: 'unreadable' } : { value: v }
    } catch {
      return { issue: 'unreadable' }
    }
  }
  const types = typesOf(s.prop)
  const en = s.prop.enum as unknown[] | undefined
  if (en) {
    const hit = en.find((e) => e === raw || (typeof e === 'string' && typeof raw === 'string' && e.toLowerCase() === raw.trim().toLowerCase()))
    return hit === undefined ? { issue: 'not_allowed' } : { value: hit }
  }
  if (types.includes('integer') || types.includes('number')) {
    let n: number
    if (typeof raw === 'number') n = raw
    else {
      const m = toAsciiDigits(String(raw)).replace(/,/g, '').match(/-?\d+(\.\d+)?/)
      if (!m) return { issue: 'unreadable' }
      n = Number(m[0])
    }
    if (!Number.isFinite(n)) return { issue: 'unreadable' }
    if (types.includes('integer') && !types.includes('number') && !Number.isInteger(n)) return { issue: 'not_whole' }
    return { value: n }
  }
  if (types.includes('boolean')) {
    if (typeof raw === 'boolean') return { value: raw }
    const t = String(raw).trim().toLowerCase()
    if (YES.has(t)) return { value: true }
    if (NO.has(t)) return { value: false }
    return { issue: 'unreadable' }
  }
  return { value: typeof raw === 'string' ? raw.trim() : String(raw) }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** The checks a field's schema asks for that one value can pass on its own. Null, or the problem as a code. */
export function propIssue(prop: JsonSchema, v: unknown): string | null {
  const types = typesOf(prop)
  if (v === null) return types.includes('null') ? null : 'type'
  if (types.length) {
    const ok = types.some((t) =>
      t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' : t === 'array' ? Array.isArray(v) : t === 'object' ? typeof v === 'object' && !Array.isArray(v) : typeof v === t,
    )
    if (!ok) return 'type'
  }
  if (Array.isArray(prop.enum) && !(prop.enum as unknown[]).includes(v)) return 'not_allowed'
  if (typeof v === 'number') {
    if (typeof prop.minimum === 'number' && v < prop.minimum) return 'too_small'
    if (typeof prop.maximum === 'number' && v > prop.maximum) return 'too_large'
    if (typeof prop.exclusiveMinimum === 'number' && v <= prop.exclusiveMinimum) return 'too_small'
    if (typeof prop.exclusiveMaximum === 'number' && v >= prop.exclusiveMaximum) return 'too_large'
  }
  if (typeof v === 'string') {
    const len = [...v].length
    if (typeof prop.minLength === 'number' && len < prop.minLength) return 'too_short'
    if (typeof prop.maxLength === 'number' && len > prop.maxLength) return 'too_long'
    if (typeof prop.pattern === 'string') {
      try {
        if (!new RegExp(prop.pattern, 'u').test(v)) return 'pattern'
      } catch {
        // A pattern this engine cannot read is left to the target's own parse.
      }
    }
    if (prop.format === 'date' && (!DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) return 'date'
    if (prop.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email'
  }
  return null
}

/**
 * A number as a person reads it. Bangla gets lakh grouping and Bangla digits
 * on every runtime, whatever ICU data it carries.
 */
export function localNumber(n: number, language: string, o: Intl.NumberFormatOptions = {}): string {
  const bn = language === 'bn' || language.startsWith('bn-')
  let s: string
  try {
    s = new Intl.NumberFormat(bn ? 'en-IN' : language, o).format(n)
  } catch {
    s = o.minimumFractionDigits !== undefined ? n.toFixed(o.minimumFractionDigits) : String(n)
  }
  return bn ? s.replace(/[0-9]/g, (d) => String.fromCharCode(0x09e6 + Number(d))) : s
}

/** How a value reads to a person. */
export function display(s: Pick<ResolvedSlot, 'format'>, v: unknown, language: string, known?: string): string {
  if (known !== undefined) return known
  if (s.format) {
    try {
      return s.format(v, language)
    } catch {
      // Fall through to the plain form.
    }
  }
  if (typeof v === 'number') {
    return localNumber(v, language)
  }
  if (typeof v === 'boolean') return language === 'bn' ? (v ? 'হ্যাঁ' : 'না') : v ? 'yes' : 'no'
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/** Minor units (paisa, cents) from an amount as written, and back for display. */
export function minorUnits(opts: { scale?: number; currency?: string } = {}) {
  const scale = opts.scale ?? 100
  return {
    parse(raw: unknown): number | undefined {
      const t = typeof raw === 'number' ? raw : Number(toAsciiDigits(String(raw)).replace(/,/g, '').match(/-?\d+(\.\d+)?/)?.[0])
      return Number.isFinite(t) ? Math.round(t * scale) : undefined
    },
    format(v: unknown, language: string): string {
      const n = typeof v === 'number' ? v / scale : Number.NaN
      if (!Number.isFinite(n)) return String(v)
      const digits = Math.round(Math.log10(scale))
      const s = localNumber(n, language, { minimumFractionDigits: digits, maximumFractionDigits: digits })
      return opts.currency ? `${opts.currency} ${s}` : s
    },
  }
}
