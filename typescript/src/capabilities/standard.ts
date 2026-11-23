// The Standard Schema and Standard JSON Schema interfaces, copied as the
// specifications ask (https://standardschema.dev), so a product can bring
// zod, valibot, ArkType or our own `schema` helpers without the SDK
// depending on any of them.

/** The Standard Schema interface, version 1. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>
    readonly types?: Types<Input, Output> | undefined
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult
  export interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }
  export interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined
  }
  export interface PathSegment {
    readonly key: PropertyKey
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input
    readonly output: Output
  }
  export type InferInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input']
  export type InferOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output']
}

/** The Standard JSON Schema interface, version 1: a schema that can describe itself as JSON Schema. */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardJSONSchemaV1.Props<Input, Output>
}

export declare namespace StandardJSONSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    readonly vendor: string
    readonly types?: StandardSchemaV1.Types<Input, Output> | undefined
    readonly jsonSchema: Converter
  }
  export interface Converter {
    readonly input: (options: Options) => Record<string, unknown>
    readonly output: (options: Options) => Record<string, unknown>
  }
  export type Target = 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | ({} & string)
  export interface Options {
    readonly target: Target
    readonly libraryOptions?: Record<string, unknown> | undefined
  }
}

export type JsonSchema = Record<string, unknown>

/**
 * What a capability takes as its input or output schema: a Standard Schema
 * that also gives JSON Schema, either through Standard JSON Schema (zod 4.2
 * and later, our `schema` helpers) or through `withJsonSchema`.
 */
export type SchemaLike<T> = StandardSchemaV1<unknown, T> & {
  readonly '~standard': { readonly jsonSchema?: StandardJSONSchemaV1.Converter }
  readonly jsonSchema?: JsonSchema
}

/**
 * Pairs a validating schema with JSON Schema written by hand or produced by
 * the library's own converter (valibot's `toJsonSchema`, TypeBox's schema).
 */
export function withJsonSchema<T>(schema: StandardSchemaV1<unknown, T>, jsonSchema: JsonSchema): SchemaLike<T> {
  // The JSON given here wins over any converter the vendor has.
  const { validate, vendor, version, types } = schema['~standard']
  return { '~standard': { validate, vendor, version, ...(types ? { types } : {}) }, jsonSchema }
}

export type Issue = { message: string; path: string }

export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: Issue[] }

function pathOf(issue: StandardSchemaV1.Issue): string {
  return (issue.path ?? [])
    .map((p) => (typeof p === 'object' && p !== null && 'key' in p ? p.key : p))
    .map(String)
    .join('.')
}

/** Runs a Standard Schema and flattens its answer. */
export async function validate<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): Promise<Parsed<T>> {
  const r = await schema['~standard'].validate(value)
  if (r.issues) return { ok: false, issues: r.issues.map((i) => ({ message: i.message, path: pathOf(i) })) }
  return { ok: true, value: r.value }
}

/**
 * The JSON Schema of a schema's input (or output) side, draft 2020-12, with
 * every object closed (`additionalProperties: false` wherever it was left
 * open by omission) and the `$schema` key dropped.
 */
export function toJsonSchema(schema: SchemaLike<unknown>, io: 'input' | 'output' = 'input'): JsonSchema {
  let json: JsonSchema | undefined
  const conv = schema['~standard'].jsonSchema
  if (conv) json = conv[io]({ target: 'draft-2020-12' })
  else if (schema.jsonSchema) json = schema.jsonSchema
  if (!json || typeof json !== 'object') {
    throw new TypeError(
      `a ${schema['~standard'].vendor} schema gave no JSON Schema: use one that implements Standard JSON Schema, or wrap it with withJsonSchema(schema, json)`,
    )
  }
  const copy = JSON.parse(JSON.stringify(json)) as JsonSchema
  delete copy.$schema
  return closeObjects(copy)
}

const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']
const SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems']
const SCHEMA_ONE = ['items', 'not', 'if', 'then', 'else', 'contains', 'additionalItems', 'unevaluatedItems']

/** Sets `additionalProperties: false` on every object schema that left it out. Mutates and returns `json`. */
export function closeObjects(json: JsonSchema): JsonSchema {
  const isObject = json.type === 'object' || (Array.isArray(json.type) && json.type.includes('object')) || 'properties' in json
  if (isObject && !('additionalProperties' in json) && !('unevaluatedProperties' in json)) json.additionalProperties = false
  for (const k of SCHEMA_MAPS) {
    const m = json[k]
    if (m && typeof m === 'object') for (const v of Object.values(m)) if (isNode(v)) closeObjects(v)
  }
  for (const k of SCHEMA_LISTS) {
    const l = json[k]
    if (Array.isArray(l)) for (const v of l) if (isNode(v)) closeObjects(v)
  }
  for (const k of SCHEMA_ONE) {
    const v = json[k]
    if (Array.isArray(v)) v.forEach((x) => isNode(x) && closeObjects(x))
    else if (isNode(v)) closeObjects(v)
  }
  if (isNode(json.additionalProperties)) closeObjects(json.additionalProperties)
  return json
}

const isNode = (v: unknown): v is JsonSchema => !!v && typeof v === 'object' && !Array.isArray(v)

const kindOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v)

function typeMatches(schema: JsonSchema, value: unknown): boolean {
  if (schema.type === undefined) return true
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]
  const k = kindOf(value)
  return types.includes(k) || (k === 'integer' && types.includes('number'))
}

/**
 * Fields in `value` that a closed object in `json` does not name, as issues
 * with their paths. It reads only the JSON Schema, so it holds whatever the
 * schema library does with unknown fields (zod's plain `z.object` drops them
 * silently). Follows `properties`, `patternProperties`, `additionalProperties`
 * schemas, `items`, `prefixItems`, local `$ref`s and `anyOf`/`oneOf` (a value
 * passes when one branch of its type names every field).
 */
export function unknownFields(json: JsonSchema, value: unknown, path: string[] = [], root: JsonSchema = json, depth = 0): Issue[] {
  if (depth > 64 || value === null || typeof value !== 'object') return []
  let node = json
  for (let hops = 0; typeof node.$ref === 'string' && hops < 16; hops++) {
    const ref = node.$ref as string
    if (!ref.startsWith('#/')) return []
    let target: unknown = root
    for (const part of ref.slice(2).split('/')) target = (target as Record<string, unknown> | undefined)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
    if (!isNode(target)) return []
    node = target
  }
  const out: Issue[] = []
  for (const k of ['anyOf', 'oneOf']) {
    const branches = (Array.isArray(node[k]) ? (node[k] as unknown[]) : []).filter((b): b is JsonSchema => isNode(b) && typeMatches(b, value))
    if (branches.length) {
      const results = branches.map((b) => unknownFields(b, value, path, root, depth + 1))
      const clean = results.find((r) => r.length === 0)
      if (!clean) out.push(...results[0]!)
    }
  }
  if (Array.isArray(value)) {
    const prefix = Array.isArray(node.prefixItems) ? (node.prefixItems as unknown[]) : []
    value.forEach((v, i) => {
      const s = i < prefix.length ? prefix[i] : node.items
      if (isNode(s)) out.push(...unknownFields(s, v, [...path, String(i)], root, depth + 1))
    })
    return out
  }
  const props = isNode(node.properties) ? (node.properties as Record<string, unknown>) : {}
  const patterns = isNode(node.patternProperties) ? Object.entries(node.patternProperties as Record<string, unknown>) : []
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const at = [...path, key]
    const known = props[key]
    if (isNode(known)) {
      out.push(...unknownFields(known, v, at, root, depth + 1))
      continue
    }
    const pattern = patterns.find(([re]) => {
      try {
        return new RegExp(re, 'u').test(key)
      } catch {
        return false
      }
    })
    if (pattern) {
      if (isNode(pattern[1])) out.push(...unknownFields(pattern[1], v, at, root, depth + 1))
      continue
    }
    if (node.additionalProperties === false) out.push({ message: 'unknown field', path: at.join('.') })
    else if (isNode(node.additionalProperties)) out.push(...unknownFields(node.additionalProperties, v, at, root, depth + 1))
  }
  return out
}
