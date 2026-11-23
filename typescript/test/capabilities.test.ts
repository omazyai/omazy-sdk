import { describe, expect, test } from 'bun:test'
import { capability, createRegistry, type Ctx, defineCapabilities, schema } from '../src/capabilities/index'

// A product's own context and permission types, bound once.
type AppCtx = Ctx<{ locale: 'en' | 'bn' }>
type Permission = { platform: string } | { org: string }
type Door = 'platform' | 'org'
const kit = defineCapabilities<AppCtx, Permission, Door>()

const ctx: AppCtx = {
  principal: { kind: 'member', id: 'u1' },
  seat: { id: 's1', door: 'org', tenant: 't1' },
  tenant: 't1',
  channel: 'mcp',
  approvalId: null,
  requestId: 'r1',
  locale: 'en',
}

const staffList = kit.capability({
  name: 'staff_list',
  audiences: ['org'],
  title: 'List staff',
  description: 'Lists the staff of the current tenant with their names, teams and phone numbers. Not for members of the console: use members_list.',
  synonyms: ['employees', 'team', 'people'],
  permission: { org: 'staff.read' },
  risk: 'R1',
  input: schema.object({ team: schema.text(80).optional(), limit: schema.integer({ min: 1, max: 100 }).default(20) }),
  output: schema.object({ rows: schema.array(schema.object({ name: schema.text(120), phone: schema.text(40) })) }),
  pii: ['rows.*.name', 'rows.*.phone'],
  version: 1,
  run: (_c, input) => ({ rows: [{ name: `Rashed (${input.limit})`, phone: '+8801700000000' }] }),
})

const paymentRecord = kit.capability({
  name: 'payment_record_manual_bank',
  audiences: ['platform'],
  title: 'Record a manual bank payment',
  description:
    'Records a pending bank transfer with its bank reference. A second person approves it before it counts as paid. Not for card payments: those come from the card processor.',
  permission: { platform: 'payments' },
  risk: 'R3',
  approval: 'platform_four_eyes',
  input: schema.object({ tenant_id: schema.text(64), amount: schema.integer({ min: 1 }), external_ref: schema.text(120) }),
  version: 1,
  preview: (_c, i) => ({ summary: `Record ${i.amount} for ${i.tenant_id}`, stateVersion: 'v1' }),
  run: (_c, i) => ({ id: 'p1', amount: i.amount }),
})

describe('capabilities: the interface', () => {
  test('a registry lists by door and derives mode and annotations from the tier', async () => {
    const reg = createRegistry([staffList, paymentRecord])
    expect(reg.list('org').map((c) => c.name)).toEqual(['staff_list'])
    expect(reg.mode('staff_list')).toBe('read')
    expect(reg.mode('payment_record_manual_bank')).toBe('write')
    expect(reg.annotations('payment_record_manual_bank').destructiveHint).toBe(true)

    const parsed = await reg.parse('staff_list', {})
    expect(parsed.ok && parsed.input).toEqual({ limit: 20 })
    if (!parsed.ok) throw new Error('parse failed')
    const out = await staffList.run(ctx, parsed.input as never)
    expect(reg.redact('staff_list', out)).toEqual({ rows: [{ name: '[redacted]', phone: '[redacted]' }] })

    const [tool] = reg.mcpTools('org')
    expect(tool!.inputSchema.additionalProperties).toBe(false)
    expect(reg.modelTools({ audience: 'platform' })[0]!.name).toBe('payment_record_manual_bank')
  })

  test('a bad definition fails when it is made', () => {
    expect(() =>
      capability({
        name: 'Bad Name',
        audiences: [],
        title: 'x',
        description: 'too short',
        permission: null,
        risk: 'R3',
        input: schema.object({}),
        version: 0,
        run: () => null,
      }),
    ).toThrow(/name must be|audiences|description|approval|preview|version/)
  })
})

// ---------------------------------------------------------------------------
// Every rule, one by one.

import { readdirSync, readFileSync } from 'node:fs'
import {
  annotationsOf,
  assertAdditive,
  assertParity,
  BreakingChangeError,
  CapabilityError,
  compareSnapshots,
  definitionProblems,
  modeOf,
  ParityError,
  parityProblems,
  redact,
  registry,
  removeAfter,
  type StandardSchemaV1,
  searchIndex,
  setTierAboveRiskHandler,
  tierFor,
  toJsonSchema,
  toolsChangelog,
  tokenize,
  truncateUtf8,
  unknownFields,
  validate,
  withJsonSchema,
} from '../src/capabilities/index'
import { z } from 'zod'
import { handleMessage, type Registry as ServerRegistry } from '../src/server'

const LONG = 'Does one clear thing for the current tenant and says what it does not do. Not for the other thing: use other_tool.'

/** A minimal valid spec, overridden per test. */
function spec(over: Record<string, unknown> = {}) {
  return {
    name: 'thing_get',
    audiences: ['org'],
    title: 'Get a thing',
    description: LONG,
    permission: 'things.read',
    risk: 'R0',
    input: schema.object({ id: schema.id() }),
    version: 1,
    run: () => ({ ok: true }),
    ...over,
  } as Parameters<typeof capability>[0]
}

describe('schema helpers', () => {
  const s = schema.object({
    name: schema.text(5),
    age: schema.integer({ min: 0 }).optional(),
    kind: schema.enum(['a', 'b']).default('a'),
    tags: schema.array(schema.string({ max: 3 }), { max: 2 }),
    note: schema.string().nullable().optional(),
    on: schema.boolean().optional(),
    v: schema.literal(1).optional(),
  })

  test('valid input passes, defaults fill in', async () => {
    expect(await validate(s, { name: 'Rina', tags: ['x'] })).toEqual({ ok: true, value: { name: 'Rina', kind: 'a', tags: ['x'] } })
    expect(await validate(s, { name: 'Rina', tags: [], note: null, on: true, v: 1 })).toMatchObject({ ok: true })
  })

  test('unknown fields, missing fields and wrong types are refused with paths', async () => {
    const r = await validate(s, { name: '', tags: ['long', 1], extra: 1, age: 1.5, kind: 'c' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    const paths = r.issues.map((i) => i.path).sort()
    expect(paths).toEqual(['age', 'extra', 'kind', 'name', 'tags.0', 'tags.1'])
    expect(r.issues.find((i) => i.path === 'extra')!.message).toBe('unknown field')
    expect((await validate(s, null)).ok).toBe(false)
    expect((await validate(s, [])).ok).toBe(false)
  })

  test('string length counts characters, not bytes or UTF-16 units', async () => {
    expect((await validate(schema.text(5), 'বিটোপি')).ok).toBe(false) // 6 code points
    expect((await validate(schema.text(6), 'বিটোপি')).ok).toBe(true)
    expect((await validate(schema.text(2), '😀😀')).ok).toBe(true)
  })

  test('id, minorUnits, email and date', async () => {
    expect((await validate(schema.id(), 'a b')).ok).toBe(false)
    expect((await validate(schema.minorUnits(), -1)).ok).toBe(false)
    expect((await validate(schema.minorUnits(), 2.5)).ok).toBe(false)
    expect((await validate(schema.minorUnits(), 1500)).ok).toBe(true)
    expect((await validate(schema.number(), Number.NaN)).ok).toBe(false)
    expect((await validate(schema.string({ format: 'email' }), 'x@y.z')).ok).toBe(true)
    expect((await validate(schema.string({ format: 'date' }), '24-11-2026')).ok).toBe(false)
  })

  test('JSON Schema is closed and lists only the required fields', () => {
    const json = toJsonSchema(s)
    expect(json.additionalProperties).toBe(false)
    expect(json.required).toEqual(['name', 'tags'])
    expect((json.properties as any).kind).toEqual({ type: 'string', enum: ['a', 'b'], default: 'a' })
    expect((json.properties as any).note.type).toEqual(['string', 'null'])
    expect(toJsonSchema(schema.text(3).describe('Who')).description).toBe('Who')
  })
})

describe('Standard Schema interop', () => {
  // A stand-in for zod or valibot: validates, and describes itself as JSON Schema with an open nested object.
  const foreign = {
    '~standard': {
      version: 1 as const,
      vendor: 'other',
      validate: (v: unknown) => (typeof v === 'object' && v ? { value: v as { a: string } } : { issues: [{ message: 'nope', path: [{ key: 'a' }] }] }),
      jsonSchema: {
        input: () => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { a: { type: 'string' }, b: { type: 'object', properties: {} }, m: { type: 'object', additionalProperties: { type: 'string' } } } }),
        output: () => ({ type: 'object' }),
      },
    },
  }

  test('a foreign schema gives closed JSON Schema and validates through its vendor', async () => {
    const json = toJsonSchema(foreign)
    expect(json.$schema).toBeUndefined()
    expect(json.additionalProperties).toBe(false)
    expect((json.properties as any).b.additionalProperties).toBe(false)
    expect((json.properties as any).m.additionalProperties).toEqual({ type: 'string' })
    expect(await validate(foreign, 1)).toEqual({ ok: false, issues: [{ message: 'nope', path: 'a' }] })
    const c = capability(spec({ input: foreign }))
    expect(c.inputJson.additionalProperties).toBe(false)
  })

  test('zod 4 works as is: typed input, closed JSON Schema, its own validation', async () => {
    const c = capability({
      ...spec(),
      input: z.strictObject({ amount: z.number().int().min(1), note: z.string().max(10).optional(), payer: z.object({ name: z.string() }) }),
      output: z.object({ id: z.string() }),
      run: (_ctx, input) => ({ id: `${input.amount}${input.payer.name}` }),
    })
    expect(c.inputJson.additionalProperties).toBe(false)
    expect((c.inputJson.properties as any).payer.additionalProperties).toBe(false)
    expect(c.inputJson.$schema).toBeUndefined()
    expect(c.outputJson).toMatchObject({ type: 'object', required: ['id'] })
    const reg = registry([c])
    expect(await reg.parse('thing_get', { amount: 2, payer: { name: 'R' } })).toMatchObject({ ok: true, input: { amount: 2 } })
    const bad = await reg.parse('thing_get', { amount: 0, payer: {}, extra: 1 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues.map((i) => i.path).sort()).toEqual(['', 'amount', 'extra', 'payer.name'])
    expect(await c.run(ctx as any, { amount: 3, payer: { name: 'K' } })).toEqual({ id: '3K' })
  })

  test('parse refuses unknown fields itself, even where zod would drop them', async () => {
    const c = capability({
      ...spec(),
      input: z.object({ a: z.string(), payer: z.object({ name: z.string() }), rows: z.array(z.object({ x: z.number() })), tags: z.record(z.string(), z.object({ on: z.boolean() })), maybe: z.object({ y: z.number() }).nullable().optional() }),
    })
    const reg = registry([c])
    const good = { a: 'x', payer: { name: 'R' }, rows: [{ x: 1 }], tags: { any: { on: true } }, maybe: null }
    expect(await reg.parse('thing_get', good)).toMatchObject({ ok: true })
    const bad = await reg.parse('thing_get', { ...good, top: 1, payer: { name: 'R', nested: 2 }, rows: [{ x: 1, deep: 3 }], tags: { k: { on: true, no: 1 } }, maybe: { y: 1, z: 2 } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues.map((i) => `${i.path} ${i.message}`).sort()).toEqual(['maybe.z unknown field', 'payer.nested unknown field', 'rows.0.deep unknown field', 'tags.k.no unknown field', 'top unknown field'])
  })

  test('unknownFields follows local refs and pattern properties', () => {
    const json = {
      type: 'object',
      properties: { node: { $ref: '#/$defs/n' } },
      additionalProperties: false,
      patternProperties: { '^x_': { type: 'string' } },
      $defs: { n: { type: 'object', properties: { child: { $ref: '#/$defs/n' } }, additionalProperties: false } },
    }
    expect(unknownFields(json, { x_ok: 's', node: { child: { child: {} } } })).toEqual([])
    expect(unknownFields(json, { node: { child: { bad: 1 } } })).toEqual([{ message: 'unknown field', path: 'node.child.bad' }])
    expect(unknownFields({ type: 'object' }, { any: 1 })).toEqual([])
  })

  test('a schema without JSON Schema needs withJsonSchema', () => {
    const bare: StandardSchemaV1<unknown, { a: string }> = { '~standard': { version: 1, vendor: 'bare', validate: (v) => ({ value: v as { a: string } }) } }
    expect(() => toJsonSchema(bare)).toThrow(/withJsonSchema/)
    expect(() => capability(spec({ input: bare }))).toThrow(CapabilityError)
    const paired = withJsonSchema(bare, { type: 'object', properties: { a: { type: 'string' } } })
    expect(capability(spec({ input: paired })).inputJson.additionalProperties).toBe(false)
  })

  test('input must be a closed object', () => {
    expect(() => capability(spec({ input: schema.text(3) }))).toThrow(/closed object/)
    const open = withJsonSchema(schema.object({}), { type: 'object', additionalProperties: true })
    expect(() => capability(spec({ input: open }))).toThrow(/closed object/)
  })
})

describe('tiers', () => {
  test('mode derives from the tier, and anything unknown writes', () => {
    expect(['R0', 'R1', 'R2', 'R3', 'R4', 'R9', undefined, 'r0'].map(modeOf)).toEqual(['read', 'read', 'write', 'write', 'write', 'write', 'write', 'write'])
  })

  test('annotations come from the tier and fail closed', () => {
    expect(annotationsOf('R0')).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    expect(annotationsOf('R2')).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(annotationsOf('R3', { openWorld: true })).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true })
    expect(annotationsOf('bogus')).toEqual(annotationsOf('R4'))
  })

  test('a mis-tiered registry entry fails closed', () => {
    // Forged past capability(): the registry still treats it as R4.
    const forged = { ...capability(spec()), risk: 'R7' } as any
    const reg = registry([forged])
    expect(reg.mode('thing_get')).toBe('write')
    expect(reg.annotations('thing_get').destructiveHint).toBe(true)
    expect(parityProblems(reg).map((p) => p.problem)).toContain('risk must be one of R0 to R4, is R7')
  })

  test('riskFor lowers per input; a higher tier wins and is reported; nonsense or a throw is R4', () => {
    const c = { risk: 'R3' as const, riskFor: (i: { on: boolean }) => (i.on ? 'R3' : 'R2') as any }
    expect(tierFor(c, { on: false })).toBe('R2')
    expect(tierFor(c, { on: true })).toBe('R3')
    const seen: string[] = []
    setTierAboveRiskHandler((name, declared, got) => seen.push(`${name} ${declared} ${got}`))
    try {
      expect(tierFor({ name: 'flag_set', risk: 'R2', riskFor: () => 'R4' }, {})).toBe('R4')
      expect(seen).toEqual(['flag_set R2 R4'])
    } finally {
      setTierAboveRiskHandler(() => {})
    }
    expect(tierFor({ risk: 'R2', riskFor: () => 'nope' as any }, {})).toBe('R4')
    expect(
      tierFor({ risk: 'R2', riskFor: () => {
        throw new Error('x')
      } }, {}),
    ).toBe('R4')
    expect(tierFor({ risk: 'R9' as any }, {})).toBe('R4')
  })
})

describe('capability rules', () => {
  const problems = (over: Record<string, unknown>) => definitionProblems(spec(over) as any)

  test('a sound spec has no problems', () => expect(problems({})).toEqual([]))
  test('name is noun_verb', () => {
    for (const n of ['get', 'Thing_get', 'thing-get', 'thing__get', '_thing', 'a'.repeat(61) + '_get']) expect(problems({ name: n }).length).toBe(1)
    expect(problems({ name: 'payment_record_manual_bank' })).toEqual([])
  })
  test('audiences', () => {
    expect(problems({ audiences: [] })).toEqual(['audiences must name at least one door'])
    expect(problems({ audiences: ['org', 'org'] })).toEqual(['audiences repeat a door'])
  })
  test('description 80 to 600 characters', () => {
    expect(problems({ description: 'x'.repeat(79) })[0]).toMatch(/80 to 600/)
    expect(problems({ description: 'x'.repeat(601) })[0]).toMatch(/is 601/)
    expect(problems({ description: 'x'.repeat(600) })).toEqual([])
  })
  test('tier, approval and preview', () => {
    expect(problems({ risk: undefined })[0]).toMatch(/risk must be/)
    expect(problems({ risk: 'R2' })).toEqual(['R2 needs a preview'])
    expect(problems({ risk: 'R3', preview: () => ({ summary: '' }) })).toEqual(['R3 needs an approval policy'])
    expect(problems({ risk: 'R4', preview: () => ({ summary: '' }), approval: 'super_admin_step_up' })).toEqual([])
  })
  test('version, pii, synonyms, deprecation', () => {
    expect(problems({ version: 1.5 })).toEqual(['version must be a whole number from 1'])
    expect(problems({ pii: ['a..b'] })).toEqual(['pii must be dotted paths'])
    expect(problems({ synonyms: [''] })).toEqual(['synonyms must be non-empty strings'])
    expect(problems({ deprecated: { since: '2026-13-01' } })).toEqual(['deprecated.since must be YYYY-MM-DD'])
    expect(problems({ deprecated: { since: '2026-11-24', use: 'Not A Name' } })).toEqual(['deprecated.use must name a capability'])
    expect(removeAfter({ since: '2026-11-24' })).toBe('2027-02-22')
    expect(removeAfter({ since: '2026-11-24', removeAfter: '2027-01-01' })).toBe('2027-01-01')
  })
  test('capability() throws every problem at once and freezes the result', () => {
    try {
      capability(spec({ name: 'x', version: 0 }))
      throw new Error('did not throw')
    } catch (e) {
      expect(e).toBeInstanceOf(CapabilityError)
      expect((e as CapabilityError).problems.length).toBe(2)
    }
    const c = capability(spec())
    expect(Object.isFrozen(c)).toBe(true)
    expect(Object.isFrozen(c.audiences)).toBe(true)
  })
})

describe('registry', () => {
  const read = capability(spec({ name: 'visitor_find', audiences: ['org', 'platform'], risk: 'R1', synonyms: ['guest lookup'], pii: ['email'], output: schema.object({ email: schema.string() }) }))
  const write = capability(spec({ name: 'brief_publish', risk: 'R3', approval: 'tenant_self', preview: () => ({ summary: 'publish' }), openWorld: true }))
  const old = capability(spec({ name: 'brief_push', risk: 'R2', preview: () => ({ summary: '' }), deprecated: { since: '2026-11-24', use: 'brief_publish' } }))
  const reg = registry([read, write, old])

  test('a name used twice does not load', () => {
    expect(() => registry([read, read])).toThrow(/used twice/)
    expect(() => registry([{ name: 'x' } as any])).toThrow(/capability\(\)/)
  })

  test('lists by door, in definition order', () => {
    expect(reg.size).toBe(3)
    expect(reg.list().map((c) => c.name)).toEqual(['visitor_find', 'brief_publish', 'brief_push'])
    expect(reg.list('platform').map((c) => c.name)).toEqual(['visitor_find'])
    expect(reg.has('nope')).toBe(false)
    expect(reg.mode('nope')).toBe('write')
    expect(reg.tier('nope')).toBe('R4')
  })

  test('MCP tools carry inputSchema, outputSchema and tier annotations', () => {
    const tools = reg.mcpTools('org')
    expect(tools.map((t) => t.name)).toEqual(['visitor_find', 'brief_publish', 'brief_push'])
    expect(tools[0]!.outputSchema).toMatchObject({ type: 'object', additionalProperties: false })
    expect(tools[0]!.annotations).toMatchObject({ title: 'Get a thing', readOnlyHint: true })
    expect(tools[1]!.outputSchema).toBeUndefined()
    expect(tools[1]!.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true })
    expect(tools[2]!.description).toStartWith('Deprecated, removed after 2027-02-22. Use brief_publish instead.')
    expect(reg.mcpTools('org', { maxTier: 'R2' }).map((t) => t.name)).toEqual(['visitor_find', 'brief_push'])
  })

  test('model tools for /core/ai/complete, filtered by door, names and tier', () => {
    expect(reg.modelTools({ maxTier: 'R1' })).toEqual([{ name: 'visitor_find', description: LONG, input_schema: read.inputJson }])
    expect(reg.modelTools({ audience: 'org', names: ['brief_publish'] }).map((t) => t.name)).toEqual(['brief_publish'])
    expect(reg.modelTools({ names: ['visitor_find'], synonyms: true })[0]!.description).toEndWith('Also called: guest lookup.')
  })

  test('form schema', () => {
    expect(reg.formSchema('visitor_find')).toMatchObject({ title: 'Get a thing', description: LONG, additionalProperties: false })
    expect(() => reg.formSchema('nope')).toThrow(CapabilityError)
  })

  test('parse validates and gives the tier of the call', async () => {
    expect(await reg.parse('nope', {})).toMatchObject({ ok: false, reason: 'unknown_tool' })
    expect(await reg.parse('visitor_find', { id: 'a', x: 1 })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await reg.parse('brief_publish', { id: 'a' })).toMatchObject({ ok: true, tier: 'R3', mode: 'write', input: { id: 'a' } })
  })

  test('the MCP list plugs into the existing serveMcp registry', async () => {
    const server: ServerRegistry<null> = {
      info: { name: 't', title: 'T', version: '1' },
      instructions: () => '',
      tools: reg.mcpTools('org'),
      call: async () => ({ text: 'ok' }),
    }
    const res = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null, server)) as any
    expect(res.result.tools[0].annotations.readOnlyHint).toBe(true)
  })
})

describe('redaction', () => {
  test('dotted paths and * reach into arrays and objects; the source is untouched', () => {
    const src = { email: 'a@b.c', rows: [{ name: 'A', id: 1 }, { name: 'B' }], deep: { x: { phone: '1' } }, nil: null }
    const out = redact(src, ['email', 'rows.*.name', 'deep.*.phone', 'nil', 'missing.path'])
    expect(out).toEqual({ email: '[redacted]', rows: [{ name: '[redacted]', id: 1 }, { name: '[redacted]' }], deep: { x: { phone: '[redacted]' } }, nil: null })
    expect(src.email).toBe('a@b.c')
    expect(redact('plain', ['x'])).toBe('plain')
  })

  test('log arguments are redacted and capped on a character boundary', () => {
    const reg = registry([capability(spec({ pii: ['id'] }))])
    expect(reg.logArgs('thing_get', { id: 'secret' })).toBe('{"id":"[redacted]"}')
    expect(reg.logArgs('nope', { id: 'x' })).toBe('{"id":"x"}')
    const bn = 'বিটোপিয়া'.repeat(400)
    const cut = reg.logArgs('nope', { t: bn }, 100)
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(100)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).not.toContain('�')
    expect(truncateUtf8('short', 100)).toBe('short')
  })
})

describe('tool search', () => {
  const cap = (name: string, title: string, synonyms: string[] = [], audiences = ['org']) =>
    capability(spec({ name, title, synonyms, audiences, description: `${title}. ${LONG}` }))
  const reg = registry([
    cap('payment_record_manual_bank', 'Record a manual bank payment', ['bank slip', 'deposit'], ['platform']),
    cap('staff_list', 'List staff', ['employees', 'team']),
    cap('device_revoke', 'Revoke a screen', ['kiosk', 'tablet']),
    cap('visitor_forget', 'Forget a visitor', ['erase', 'gdpr', 'মুছে ফেলুন']),
  ])

  test('finds by name, title and synonyms, best first', () => {
    expect(reg.search('who are my employees')[0]!.name).toBe('staff_list')
    expect(reg.search('remove the kiosk tablet')[0]!.name).toBe('device_revoke')
    expect(reg.search('deposit slip')[0]!.name).toBe('payment_record_manual_bank')
    expect(reg.search('মুছে')[0]!.name).toBe('visitor_forget')
  })

  test('respects door, limit and exclude, and an empty query finds nothing', () => {
    expect(reg.search('deposit', { audience: 'org' }).map((h) => h.name)).not.toContain('payment_record_manual_bank')
    expect(reg.search('tool', { limit: 2 }).length).toBe(2)
    expect(reg.search('employees', { exclude: ['staff_list'] }).map((h) => h.name)).not.toContain('staff_list')
    expect(reg.search('the of and')).toEqual([])
  })

  test('tokenize splits names and drops plurals', () => {
    expect(tokenize('tenants_list Devices')).toEqual(['tenant', 'list', 'device'])
    expect(searchIndex([]).search('x')).toEqual([])
  })
})

describe('versioning', () => {
  const base = capability(spec({ name: 'note_add', input: schema.object({ text: schema.text(200), kind: schema.enum(['a', 'b']) }), output: schema.object({ id: schema.id() }) }))
  const before = registry([base]).snapshot()
  const next = (over: Record<string, unknown>) => registry([capability(spec({ ...base, ...over }))]).snapshot()

  test('snapshot is plain, sorted data with mode derived', () => {
    expect(before.format).toBe(1)
    expect(before.capabilities[0]).toMatchObject({ name: 'note_add', risk: 'R0', mode: 'read', version: 1 })
    expect(JSON.parse(JSON.stringify(before))).toEqual(before)
  })

  test('an optional field with a version bump is additive', () => {
    const after = next({ version: 2, input: schema.object({ text: schema.text(200), kind: schema.enum(['a', 'b', 'c']), note: schema.text(50).optional() }) })
    const changes = assertAdditive(before, after)
    expect(changes.every((c) => !c.breaking)).toBe(true)
    expect(changes.map((c) => c.detail)).toContain('input gained optional field note')
  })

  test('breaking changes are caught', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ version: 2, input: schema.object({ text: schema.text(200) }) }, /field kind removed/],
      [{ version: 2, input: schema.object({ text: schema.text(200), kind: schema.enum(['a', 'b']), must: schema.id() }) }, /gained required field must/],
      [{ version: 2, input: schema.object({ text: schema.text(100), kind: schema.enum(['a', 'b']) }) }, /maxLength lowered/],
      [{ version: 2, input: schema.object({ text: schema.text(200), kind: schema.enum(['a']) }) }, /accepts fewer values/],
      [{ version: 2, input: schema.object({ text: schema.integer(), kind: schema.enum(['a', 'b']) }) }, /no longer takes string/],
      [{ version: 2, output: schema.object({ other: schema.id() }) }, /output field id removed/],
      [{ version: 2, output: schema.object({ id: schema.id().optional() }) }, /may now be missing/],
      [{ input: schema.object({ text: schema.text(200), kind: schema.enum(['a', 'b']), x: schema.id().optional() }) }, /version is still 1/],
      [{ version: 0 + 1, audiences: ['platform'] }, /no longer on org/],
    ]
    for (const [over, why] of cases) {
      expect(() => assertAdditive(before, next(over))).toThrow(BreakingChangeError)
      expect(compareSnapshots(before, next(over)).find((c) => c.breaking)!.detail).toMatch(why)
    }
  })

  test('removal is breaking until the deprecation date has passed', () => {
    const empty = registry([]).snapshot()
    expect(compareSnapshots(before, empty)[0]).toMatchObject({ kind: 'removed', breaking: true, detail: 'removed without deprecation' })
    const dep = next({ deprecated: { since: '2026-11-24', use: 'note_create' } })
    expect(() => assertAdditive(dep, empty, { today: '2027-02-21' })).toThrow(/removed before 2027-02-22/)
    expect(assertAdditive(dep, empty, { today: '2027-02-22' })[0]).toMatchObject({ kind: 'removed', breaking: false })
  })

  test('the tools changelog lists added, changed, deprecated and removed', () => {
    const after = registry([
      capability(spec({ ...base, version: 2, risk: 'R2', preview: () => ({ summary: '' }), input: schema.object({ text: schema.text(200), kind: schema.enum(['a', 'b']), tag: schema.id().optional() }), deprecated: { since: '2026-11-24', use: 'note_create' } })),
      capability(spec({ name: 'note_create', title: 'Create a note' })),
    ]).snapshot()
    const md = toolsChangelog(before, after, { date: '2026-11-24' })
    expect(md).toContain('## 2026-11-24')
    expect(md).toContain('### Added\n\n- `note_create`: Create a note (R0; org)')
    expect(md).toContain('- `note_add`: tier R0 to R2')
    expect(md).toContain('### Deprecated\n\n- `note_add`: removed after 2027-02-22; use note_create')
    expect(md).not.toContain('(breaking)')
    expect(toolsChangelog(before, before)).toBe('')
  })
})

describe('parity', () => {
  const a = capability(spec({ name: 'thing_get' }))
  const b = capability(spec({ name: 'thing_set', audiences: ['platform'], risk: 'R2', preview: () => ({ summary: '' }) }))
  const reg = registry([a, b])

  test('a matching catalog passes', () => {
    expect(() => reg.parity({ console: ['thing_get', 'thing_set'], org: { audience: 'org', tools: ['thing_get'] } }, { audiences: ['org', 'platform'] })).not.toThrow()
  })

  test('a surface naming a missing tool, a hidden tool or a repeat fails', () => {
    expect(() => reg.parity({ copilot: ['thing_gone'] })).toThrow(ParityError)
    const p = parityProblems(reg, { surfaces: [{ name: 'org door', audience: 'org', tools: ['thing_set', 'thing_get', 'thing_get', 'nope_x'] }] })
    expect(p.map((x) => x.problem)).toEqual(['not visible to door org', 'listed twice', 'not in the registry'])
  })

  test('parityProblems takes the same record as reg.parity, and the deprecated array form gives the same answer', () => {
    const record = parityProblems(reg, { surfaces: { 'org door': { audience: 'org', tools: ['thing_set', 'thing_get', 'thing_get', 'nope_x'] }, copilot: ['thing_gone'] } })
    const array = parityProblems(reg, {
      surfaces: [
        { name: 'org door', audience: 'org', tools: ['thing_set', 'thing_get', 'thing_get', 'nope_x'] },
        { name: 'copilot', tools: ['thing_gone'] },
      ],
    })
    expect(record).toEqual(array)
    expect(record.map((x) => `${x.surface} / ${x.capability}: ${x.problem}`)).toEqual([
      'org door / thing_set: not visible to door org',
      'org door / thing_get: listed twice',
      'org door / nope_x: not in the registry',
      'copilot / thing_gone: not in the registry',
    ])
    expect(() => assertParity(reg, { surfaces: { console: ['thing_get', 'thing_set'] } })).not.toThrow()
  })

  test('raw lists catch repeats, unknown doors, missing tiers and dangling deprecations', () => {
    const dangling = capability(spec({ name: 'thing_old', deprecated: { since: '2026-11-24', use: 'thing_new' } }))
    const noTier = { ...a, name: 'thing_bad', risk: undefined } as any
    const p = parityProblems([a, a, dangling, noTier], { audiences: ['platform'] }).map((x) => `${x.capability}: ${x.problem}`)
    expect(p).toContain('thing_get: name is used twice')
    expect(p).toContain('thing_get: unknown door org')
    expect(p).toContain('thing_old: deprecated in favour of thing_new, which is not in the registry')
    expect(p).toContain('thing_bad: risk must be one of R0 to R4, is undefined')
    expect(() => assertParity([a, a])).toThrow(/used twice/)
  })
})

test('the kit uses no Node-only API, so it runs on Workers', () => {
  const dir = new URL('../src/capabilities/', import.meta.url)
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), 'utf8')
    expect(src).not.toMatch(/from ['"](node:|fs|path|crypto|buffer|process)['"]|\bBuffer\.|\bprocess\.|require\(/)
  }
})

describe('capabilities: unknown fields, say and invalidMessage', () => {
  const pad = (s: string) => `${s} This sentence pads the description to the eighty characters the kit asks for.`
  const base = {
    audiences: ['org'] as const,
    title: 'File a note',
    description: pad('Files a note.'),
    permission: 'notes',
    risk: 'R0' as const,
    input: schema.object({ text: schema.text(80), meta: schema.object({ tag: schema.text(20) }).optional() }),
    version: 1,
    run: (_c: unknown, i: { text: string }) => ({ text: i.text }),
  }

  test('refuse is the default; strip drops unknown fields at any depth and says which', async () => {
    const refuse = registry([capability({ ...base, name: 'note_file' })])
    const r = await refuse.parse('note_file', { text: 'a', ward: 3 })
    expect(r.ok).toBe(false)
    const strip = registry([capability({ ...base, name: 'note_file', unknownFields: 'strip' })])
    const s = await strip.parse('note_file', { text: 'a', ward: 3, meta: { tag: 'x', colour: 'red' } })
    expect(s.ok && s.input).toEqual({ text: 'a', meta: { tag: 'x' } })
    expect(s.ok && s.stripped).toEqual(['ward', 'meta.colour'])
    const missing = await strip.parse('note_file', { ward: 3 })
    expect(missing.ok).toBe(false)
  })

  test('a definition with a bad say, invalidMessage or unknownFields does not load', () => {
    expect(() => capability({ ...base, name: 'note_file', say: 'text' as never })).toThrow(/say must be a function/)
    expect(() => capability({ ...base, name: 'note_file', invalidMessage: 1 as never })).toThrow(/invalidMessage must be a function/)
    expect(() => capability({ ...base, name: 'note_file', unknownFields: 'drop' as never })).toThrow(/unknownFields/)
  })
})
