// Small typed schema helpers with no dependencies. Each one validates
// (Standard Schema) and describes itself (Standard JSON Schema), so a product
// that does not want zod can still define capabilities. Objects are closed:
// an unknown field is refused, and the JSON Schema says
// `additionalProperties: false`.

import type { JsonSchema, StandardJSONSchemaV1, StandardSchemaV1 } from './standard.js'

type Issue = { message: string; path: PropertyKey[] }
type Check<T> = (value: unknown, path: PropertyKey[]) => { value: T } | { issues: Issue[] }

/** How a field sits in an object: must be there, may be left out, or filled from a default. */
export type Presence = 'required' | 'optional' | 'default'

export class Schema<T, P extends Presence = 'required'> implements StandardSchemaV1<unknown, T>, StandardJSONSchemaV1<unknown, T> {
  readonly '~standard': StandardSchemaV1.Props<unknown, T> & StandardJSONSchemaV1.Props<unknown, T>
  /** @internal */ readonly check: Check<T>
  /** @internal */ readonly json: JsonSchema
  /** @internal */ readonly presence: P
  /** @internal */ readonly fallback: T | undefined

  constructor(json: JsonSchema, check: Check<T>, presence: P = 'required' as P, fallback?: T) {
    this.json = json
    this.check = check
    this.presence = presence
    this.fallback = fallback
    const self = this
    this['~standard'] = {
      version: 1,
      vendor: 'omazy',
      validate(value: unknown): StandardSchemaV1.Result<T> {
        const r = self.check(value, [])
        return 'issues' in r ? { issues: r.issues } : { value: r.value }
      },
      jsonSchema: {
        input: () => structuredCopy(self.json),
        output: () => structuredCopy(self.json),
      },
    }
  }

  /** The field may be left out of its object. */
  optional(): Schema<T | undefined, 'optional'> {
    return new Schema<T | undefined, 'optional'>(this.json, this.check as Check<T | undefined>, 'optional')
  }

  /** The field may be left out; `value` is used then. */
  default(value: T): Schema<T, 'default'> {
    return new Schema<T, 'default'>({ ...this.json, default: value }, this.check, 'default', value)
  }

  /** null is accepted as well. */
  nullable(): Schema<T | null, P> {
    const json = this.json
    const type = json.type
    const next: JsonSchema =
      typeof type === 'string' ? { ...json, type: [type, 'null'] } : Array.isArray(type) ? { ...json, type: [...type, 'null'] } : { anyOf: [json, { type: 'null' }] }
    if (Array.isArray(json.enum)) next.enum = [...json.enum, null]
    const inner = this.check
    return new Schema<T | null, P>(next, (v, p) => (v === null ? { value: null } : inner(v, p)), this.presence, this.fallback)
  }

  /** A sentence for the model and for forms. */
  describe(description: string): Schema<T, P> {
    return new Schema<T, P>({ ...this.json, description }, this.check, this.presence, this.fallback)
  }
}

export type Infer<S> = S extends Schema<infer T, Presence> ? T : S extends StandardSchemaV1<unknown, infer O> ? O : never

type AnySchema = Schema<any, Presence>
type Shape = Record<string, AnySchema>
type Simplify<T> = { [K in keyof T]: T[K] } & {}
type ObjectOf<S extends Shape> = Simplify<
  { [K in keyof S as S[K] extends Schema<any, 'optional'> ? never : K]: Infer<S[K]> } & {
    [K in keyof S as S[K] extends Schema<any, 'optional'> ? K : never]?: Infer<S[K]>
  }
>

const structuredCopy = <V>(v: V): V => JSON.parse(JSON.stringify(v)) as V
const fail = (path: PropertyKey[], message: string) => ({ issues: [{ message, path }] })
const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

export interface StringOptions {
  min?: number
  max?: number
  pattern?: RegExp
  /** A JSON Schema format name, such as `email`, `uri`, `date` or `uuid`. Not checked here except `date` and `email`. */
  format?: string
}

const FORMATS: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
}

function string(opts: StringOptions = {}): Schema<string> {
  const json: JsonSchema = { type: 'string' }
  if (opts.min !== undefined) json.minLength = opts.min
  if (opts.max !== undefined) json.maxLength = opts.max
  if (opts.pattern) json.pattern = opts.pattern.source
  if (opts.format) json.format = opts.format
  return new Schema<string>(json, (v, p) => {
    if (typeof v !== 'string') return fail(p, `expected a string, got ${typeName(v)}`)
    // Lengths count characters as people see them, not UTF-16 units.
    const n = [...v].length
    if (opts.min !== undefined && n < opts.min) return fail(p, `at least ${opts.min} characters`)
    if (opts.max !== undefined && n > opts.max) return fail(p, `at most ${opts.max} characters`)
    if (opts.pattern && !opts.pattern.test(v)) return fail(p, `does not match ${opts.pattern.source}`)
    const f = opts.format ? FORMATS[opts.format] : undefined
    if (f && !f.test(v)) return fail(p, `not a valid ${opts.format}`)
    return { value: v }
  })
}

export interface NumberOptions {
  min?: number
  max?: number
}

function numeric(integer: boolean, opts: NumberOptions = {}): Schema<number> {
  const json: JsonSchema = { type: integer ? 'integer' : 'number' }
  if (opts.min !== undefined) json.minimum = opts.min
  if (opts.max !== undefined) json.maximum = opts.max
  return new Schema<number>(json, (v, p) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fail(p, `expected a number, got ${typeName(v)}`)
    if (integer && !Number.isInteger(v)) return fail(p, 'expected a whole number')
    if (opts.min !== undefined && v < opts.min) return fail(p, `at least ${opts.min}`)
    if (opts.max !== undefined && v > opts.max) return fail(p, `at most ${opts.max}`)
    return { value: v }
  })
}

function enumOf<const V extends readonly [string, ...string[]]>(values: V): Schema<V[number]> {
  return new Schema<V[number]>({ type: 'string', enum: [...values] }, (v, p) =>
    typeof v === 'string' && values.includes(v) ? { value: v as V[number] } : fail(p, `expected one of ${values.join(', ')}`),
  )
}

function literal<const V extends string | number | boolean>(value: V): Schema<V> {
  return new Schema<V>({ const: value }, (v, p) => (v === value ? { value } : fail(p, `expected ${JSON.stringify(value)}`)))
}

export interface ArrayOptions {
  min?: number
  max?: number
}

function array<S extends AnySchema>(item: S, opts: ArrayOptions = {}): Schema<Infer<S>[]> {
  const json: JsonSchema = { type: 'array', items: item.json }
  if (opts.min !== undefined) json.minItems = opts.min
  if (opts.max !== undefined) json.maxItems = opts.max
  return new Schema<Infer<S>[]>(json, (v, p) => {
    if (!Array.isArray(v)) return fail(p, `expected an array, got ${typeName(v)}`)
    if (opts.min !== undefined && v.length < opts.min) return fail(p, `at least ${opts.min} items`)
    if (opts.max !== undefined && v.length > opts.max) return fail(p, `at most ${opts.max} items`)
    const out: Infer<S>[] = []
    const issues: Issue[] = []
    v.forEach((x, i) => {
      const r = item.check(x, [...p, i])
      if ('issues' in r) issues.push(...r.issues)
      else out.push(r.value)
    })
    return issues.length ? { issues } : { value: out }
  })
}

function object<S extends Shape>(shape: S): Schema<ObjectOf<S>> {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [k, s] of Object.entries(shape)) {
    properties[k] = s.json
    if (s.presence === 'required') required.push(k)
  }
  const json: JsonSchema = { type: 'object', properties, additionalProperties: false }
  if (required.length) json.required = required
  return new Schema<ObjectOf<S>>(json, (v, p) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(p, `expected an object, got ${typeName(v)}`)
    const src = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    const issues: Issue[] = []
    for (const k of Object.keys(src)) if (!(k in shape)) issues.push({ message: 'unknown field', path: [...p, k] })
    for (const [k, s] of Object.entries(shape)) {
      if (src[k] === undefined) {
        if (s.presence === 'required') issues.push({ message: 'required', path: [...p, k] })
        else if (s.presence === 'default') out[k] = structuredCopy(s.fallback)
        continue
      }
      const r = s.check(src[k], [...p, k])
      if ('issues' in r) issues.push(...r.issues)
      else out[k] = r.value
    }
    return issues.length ? { issues } : { value: out as ObjectOf<S> }
  })
}

/**
 * The helpers. Every object is closed; strings count characters, not bytes.
 *
 *     schema.object({ name: schema.text(80), note: schema.text(500).optional() })
 */
export const schema = {
  string,
  /** A string of 1 to `max` characters (0 when `min` is 0). */
  text: (max: number, min = 1) => string({ min, max }),
  number: (opts?: NumberOptions) => numeric(false, opts),
  integer: (opts?: NumberOptions) => numeric(true, opts),
  boolean: () =>
    new Schema<boolean>({ type: 'boolean' }, (v, p) => (typeof v === 'boolean' ? { value: v } : fail(p, `expected true or false, got ${typeName(v)}`))),
  enum: enumOf,
  literal,
  array,
  object,
  /** An opaque id: 1 to 128 characters with no spaces. */
  id: () => string({ min: 1, max: 128, pattern: /^\S+$/ }),
  /** A money amount in the currency's smallest unit (cents, poisha): a whole number from 0. */
  minorUnits: (opts: { max?: number } = {}) => numeric(true, { min: 0, max: opts.max ?? Number.MAX_SAFE_INTEGER }),
  /** Anything that is valid JSON. For outputs whose shape is not fixed. */
  unknown: () => new Schema<unknown>({}, (v) => ({ value: v })),
}
