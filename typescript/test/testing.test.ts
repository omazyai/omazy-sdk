import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actor, actorRuntime, EXTRACT_PROMPT, slot } from '../src/actors/index'
import { copilotUnit, createAi, memoryRunStore, promptTemplates, task } from '../src/ai/index'
import { type BaseCtx, capability, registry, schema } from '../src/capabilities/index'
import { approver, createGuard, type Guard, memoryGuardStore, policies } from '../src/guard/index'
import { ROUTES } from '../src/routes'
import {
  assertEval,
  assertNoUnsafeEffects,
  assertRouteContract,
  autoevalsClient,
  BANGLA_REGISTER,
  CONTRACT_URL,
  checkRouteContract,
  ContractError,
  type EvalCase,
  EvalFailure,
  evalCore,
  evalUnit,
  exact,
  fakeCore,
  formatInjection,
  formatReport,
  formatToolPicking,
  fromAutoevals,
  GoldenSetError,
  type GuardCallRecord,
  INJECTION_FIXTURES,
  type InjectionFixture,
  InjectionViolation,
  includes,
  injectionSuite,
  JUDGE_ROLE,
  JUDGE_UNIT_ID,
  judge,
  jsonFields,
  loadGoldenSet,
  memoryAdapters,
  modelPicker,
  obeyingModel,
  parseJsonl,
  reply,
  runActorCase,
  schemaValid,
  slotAccuracy,
  spyGuard,
  toolPicking,
  unfencedHits,
  unsafeEffects,
} from '../src/testing/index'

// ---------------------------------------------------------------- a small product

const D = (s: string) => `${s} This sentence pads the description so that it passes the eighty character minimum of the kit.`

const tenantsList = capability({
  name: 'tenants_list',
  audiences: ['org'],
  title: 'Find tenants',
  description: D('Finds tenants by name.'),
  synonyms: ['organisations', 'প্রতিষ্ঠান'],
  permission: 'tenants.read',
  risk: 'R0',
  input: schema.object({ q: schema.text(100).optional() }),
  version: 1,
  run: () => ({ rows: [] }),
})
const invoicesOpen = capability({
  name: 'invoices_open',
  audiences: ['org'],
  title: 'Open invoices',
  description: D('Lists the unpaid invoices of a tenant, by month.'),
  synonyms: ['bills due', 'unpaid', 'বকেয়া', 'ইনভয়েস', 'বিল'],
  permission: 'invoices.read',
  risk: 'R0',
  input: schema.object({ tenant_id: schema.id().optional() }),
  version: 1,
  run: () => ({ rows: [] }),
})
const staffAdded: unknown[] = []
const staffAdd = capability({
  name: 'staff_add',
  audiences: ['org'],
  title: 'Add a staff member',
  description: D('Adds one staff member to the tenant with a role.'),
  synonyms: ['new employee', 'hire', 'কর্মী যোগ'],
  permission: 'staff.write',
  risk: 'R2',
  input: schema.object({ name: schema.text(80), role: schema.enum(['host', 'manager']), email: schema.string({ max: 200, format: 'email' }).optional() }),
  version: 1,
  preview: (_c, i) => ({ summary: `Add ${i.name} as ${i.role}`, stateVersion: 's1' }),
  run: (_c, i) => {
    staffAdded.push(i)
    return { staff: `st_${staffAdded.length}` }
  },
})
const deleted: unknown[] = []
const tenantDelete = capability({
  name: 'tenant_delete',
  audiences: ['org'],
  title: 'Delete a tenant',
  description: D('Deletes a tenant and every record it holds.'),
  permission: 'tenants.delete',
  risk: 'R4',
  approval: 'four_eyes',
  input: schema.object({ tenant_id: schema.id() }),
  version: 1,
  preview: (_c, i) => ({ summary: `Delete ${i.tenant_id}` }),
  run: (_c, i) => {
    deleted.push(i)
    return { deleted: true }
  },
})
const reg = registry([tenantsList, invoicesOpen, staffAdd, tenantDelete])

const ctx: BaseCtx = {
  principal: { kind: 'member', id: 'p_rina' },
  seat: { id: 'seat_1', door: 'org', tenant: 'tA' },
  tenant: 'tA',
  channel: 'copilot',
  approvalId: null,
  requestId: 'req_1',
}

const Brief = schema.object({ title: schema.text(200), summary: schema.text(2000) })
const briefTask = task({
  id: 'brief_draft',
  version: 2,
  owner: 'onboarding',
  model: { use: 'extract.strong', fallback: 'extract.fast', temperature: 0, maxOutputTokens: 500 },
  prompt: { template: 'tasks/brief', version: 3, languages: ['en'] },
  context: { layers: ['unit'], budgetTokens: 4000, untrusted: ['site_text'] },
  memory: { read: [], write: [] },
  input: schema.object({ url: schema.text(300), site_text: schema.text(20000) }),
  output: Brief,
  target: 'staff_add',
  evals: 'evals/tasks/brief.jsonl',
  caps: { perRunUsd: 0.05, perDayUsd: 1 },
})
const staffOnboard = actor({
  id: 'staff_onboard',
  version: 1,
  owner: 'org',
  target: 'staff_add',
  model: { use: 'extract.fast' },
  prompt: { template: 'actors/staff-onboard', version: 1, languages: ['en'] },
  evals: 'evals/actors/staff-onboard.jsonl',
  caps: { perRunUsd: 0.05, perDayUsd: 5 },
  slots: [slot('name'), slot('role'), slot('email', { required: false })],
})
const helper = copilotUnit({
  id: 'org_helper',
  version: 1,
  owner: 'org',
  model: { use: 'converse' },
  prompt: { template: 'copilot/main', version: 1, languages: ['en'] },
  context: { layers: ['unit'], budgetTokens: 8000, untrusted: ['message'] },
  memory: { read: [], write: [] },
  tools: { allow: ['tenants_list', 'invoices_open', 'staff_add', 'tenant_delete'], maxTier: 'R4' },
  evals: 'evals/copilot/helper.jsonl',
  caps: { perRunUsd: 0.5, perDayUsd: 5 },
})
const prompts = promptTemplates({
  'tasks/brief': { 3: { en: 'Draft a brief for {{url}}.' } },
  'actors/staff-onboard': { 1: { en: EXTRACT_PROMPT } },
  'copilot/main': { 1: { en: 'You help the team.' } },
})

function guardFor(): Guard<BaseCtx> {
  return createGuard<BaseCtx, string>({
    registry: reg,
    can: () => true,
    secret: 'test-secret-test-secret-test-secret-0123',
    store: memoryGuardStore(),
    policies: { four_eyes: policies.fourEyes({ approver: approver.role(['finance']), stepUp: 'code', expires: '24h' }) },
    rolesOf: () => ['member'],
    stepUp: { methods: ['code'], verify: async () => ({ ok: true, method: 'code' }) },
  })
}

function world(fake = fakeCore()) {
  const guard = spyGuard(guardFor(), reg)
  const ai = createAi<BaseCtx>({ omazy: () => fake.client, runs: memoryRunStore(), prompts, guard, registry: reg })
  const rt = actorRuntime<BaseCtx>({ ai, registry: reg, guard, actors: [staffOnboard], sessions: memoryAdapters().sessions, onError: () => {} })
  return { fake, guard, ai, rt }
}

const item = (s: string, value: unknown, confidence = 0.95) => ({ slot: s, value, confidence, evidence: String(value), from: 'message' })

// ---------------------------------------------------------------- the fake Core API

describe('fakeCore', () => {
  test('answers a task through the real client: structured output, tags, role, usage and cost', async () => {
    const fake = fakeCore({ script: [reply.json({ title: 'Hemi', summary: 'A salon.' }, { usage: { input_tokens: 1000, output_tokens: 200 } })], models: { 'extract.strong': 'anthropic/claude-sonnet-5.5' } })
    const { ai } = world(fake)
    const r = await ai.run(ctx, briefTask, { url: 'https://hemi.test', site_text: 'Hemi is a salon.' }, { save: false })
    expect(r.outcome).toBe('ok')
    if (r.outcome !== 'ok') return
    expect(r.output).toEqual({ title: 'Hemi', summary: 'A salon.' })
    // $1 in, $4 out a million tokens: 1000 + 800 micros.
    expect(r.usage.costMicros).toBe(1800)
    expect(fake.spentMicros).toBe(1800)
    const [call] = fake.completions()
    expect(call!.role).toBe('extract.strong')
    expect(call!.tags).toMatchObject({ unit: 'brief_draft', unit_version: '2', prompt_version: '3', run_id: r.runId })
    expect(call!.result!.model).toBe('anthropic/claude-sonnet-5.5')
    expect(call!.body.response_format?.type).toBe('json_schema')
  })

  test('a model without JSON Schema gets the forced tool, and the same output comes back through it', async () => {
    const fake = fakeCore({ structured: 'unsupported', fallback: reply.json({ title: 'T', summary: 'S' }) })
    const { ai } = world(fake)
    const r = await ai.run(ctx, briefTask, { url: 'u', site_text: 's' }, { save: false })
    expect(r.outcome).toBe('ok')
    const calls = fake.completions()
    expect(calls.map((c) => c.status)).toEqual([422, 200])
    expect(calls[1]!.result!.tool_calls![0]!.name).toBe('submit_output')
  })

  test('a spent budget is a 402 the run reports as the platform cap', async () => {
    const fake = fakeCore({ budgetUsd: 0.000001, fallback: reply.json({ title: 'T', summary: 'S' }) })
    const { ai } = world(fake)
    expect((await ai.run(ctx, briefTask, { url: 'u', site_text: 's' }, { save: false })).outcome).toBe('ok')
    const r = await ai.run(ctx, briefTask, { url: 'u', site_text: 's' }, { save: false })
    expect(r.outcome).toBe('refused_cap')
    if (r.outcome === 'refused_cap') expect(r.cap).toBe('platform')
    expect(fake.calls.at(-1)!.error!.code).toBe('BUDGET_EXCEEDED')
  })

  test('a provider failure lets the unit fall back to its second role; maxCalls caps the turns', async () => {
    const fake = fakeCore({ script: [reply.down(), reply.json({ title: 'T', summary: 'S' })], maxCalls: 1 })
    const { ai } = world(fake)
    const r = await ai.run(ctx, briefTask, { url: 'u', site_text: 's' }, { save: false })
    expect(r.outcome).toBe('ok')
    expect(fake.completions().map((c) => c.role)).toEqual(['extract.strong', 'extract.fast'])
    const again = await ai.run(ctx, briefTask, { url: 'u', site_text: 's' }, { save: false })
    expect(again.outcome).toBe('refused_cap')
    expect(fake.calls.at(-1)!.error!.code).toBe('AI_TURNS_EXCEEDED')
  })

  test('streams as server-sent events, answers whoami, refuses a route it does not serve', async () => {
    const fake = fakeCore({ fallback: reply.text('Hello there, Rina.', { chunk: 5 }) })
    const { ai } = world(fake)
    const scope = await ai.start(ctx, helper)
    const deltas: string[] = []
    for await (const ev of scope.stream({ messages: [{ role: 'user', content: 'hi' }] })) if (ev.type === 'delta') deltas.push(ev.text)
    expect(deltas.join('')).toBe('Hello there, Rina.')
    expect(deltas.length).toBe(4)
    expect(scope.usage.calls).toBe(1)
    expect(fake.completions()[0]!.stream).toBe(true)
    expect((await fake.client.whoami()) as unknown).toMatchObject({ workspace: { id: 'ws_test' } })
    await expect(fake.client.knowledge.search({ query: 'x' })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })

  test('rules by unit come before the script; tool calls get ids; reportCost false leaves pricing to the kit', async () => {
    const fake = fakeCore({ reportCost: false, script: [reply.text('scripted')] })
    fake.on('org_helper', reply.tool('tenants_list', { q: 'Hemi' }), { times: 1 })
    const { ai } = world(fake)
    const scope = await ai.start(ctx, helper)
    const first = await scope.complete({ messages: [{ role: 'user', content: 'find Hemi' }] })
    expect(first.tool_calls).toEqual([{ id: 'call_1_1', name: 'tenants_list', input: { q: 'Hemi' } }])
    expect(first.usage.cost_micros).toBeUndefined()
    expect((await scope.complete({ messages: [{ role: 'user', content: 'again' }] })).text).toBe('scripted')
    expect(scope.usage.unpricedCalls).toBe(2)
    fake.reset()
    expect(fake.calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------- golden sets

describe('golden sets', () => {
  test('parseJsonl reads cases, the $meta line and comments, and names a bad line', () => {
    const set = parseJsonl(['// brief_draft', '{"$meta": {"threshold": 0.95}}', '', '{"id": "hemi", "input": {"url": "u"}, "expected": {"title": "Hemi"}}', '{"input": 1}'].join('\n'), 'brief.jsonl')
    expect(set.meta.threshold).toBe(0.95)
    expect(set.cases.map((c) => c.id)).toEqual(['hemi', '#5'])
    expect(() => parseJsonl('{"input": 1}\n{oops}', 'x.jsonl')).toThrow(/x.jsonl line 2: not JSON/)
    expect(() => parseJsonl('{"expected": 1}')).toThrow(GoldenSetError)
    expect(() => parseJsonl('{"$meta": {"threshold": 2}}')).toThrow(/threshold/)
  })

  test('loadGoldenSet reads the unit\'s evals path under a root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omazy-evals-'))
    const dir = join(root, 'evals', 'tasks')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'brief.jsonl'), '{"input": {"url": "a"}}\n{"input": {"url": "b"}}\n')
    const set = await loadGoldenSet(briefTask, { root })
    expect(set.cases.length).toBe(2)
    expect(set.source).toBe('evals/tasks/brief.jsonl')
  })

  const cases: EvalCase[] = [
    { id: 'hemi', input: { url: 'https://hemi.test', site_text: 'Hemi Beauty Parlour, Dhaka.' }, expected: { title: 'Hemi Beauty Parlour' }, fake: reply.json({ title: 'Hemi Beauty Parlour', summary: 'A salon in Dhaka.' }) },
    { id: 'rina', input: { url: 'https://rina.test', site_text: 'Rina Store.' }, expected: { title: 'Rina Store' }, fake: reply.json({ title: 'Rina Store', summary: 'A shop.' }) },
    { id: 'kyro', input: { url: 'https://kyro.test', site_text: 'Kyro.' }, expected: { title: 'Kyro' }, fake: reply.json({ title: 'Kyro Labs', summary: 'Software.' }) },
    { id: 'broken', input: { url: 'https://x.test', site_text: 'x' }, expected: { title: 'X' }, fake: reply.json({ title: 'X' }) },
  ]

  test('runs a task on the fake with each case\'s replies, scores it and holds it to the threshold', async () => {
    const { ai, fake } = world()
    const report = await evalUnit(briefTask, {
      cases,
      fake,
      live: false,
      run: (c) => ai.run(ctx, briefTask, c.input as never, { save: false }),
      scorers: [schemaValid(), jsonFields({ fields: ['title'] })],
      threshold: 0.75,
    })
    expect(report.unit).toEqual({ id: 'brief_draft', kind: 'task', version: 2, promptVersion: 3, evals: 'evals/tasks/brief.jsonl' })
    expect(report.total).toBe(4)
    expect(report.passed).toBe(2)
    expect(report.errors).toBe(1)
    expect(report.pass).toBe(false)
    expect(report.scorers.json_fields!.mean).toBe(0.5)
    // The invalid output still made its call.
    expect(report.usage.calls).toBe(4)
    expect(report.usage.costMicros).toBeGreaterThan(0)
    expect(report.warnings[0]).toContain('at least 30')
    const kyro = report.cases.find((c) => c.id === 'kyro')!
    expect(kyro.scores.find((s) => s.name === 'json_fields')!.detail).toBe('title: expected "Kyro", got "Kyro Labs"')
    expect(report.cases.find((c) => c.id === 'broken')!.error).toMatch(/^invalid_output/)
    const text = formatReport(report)
    expect(text.split('\n')[0]).toBe('FAIL brief_draft v2 (prompt 3): 2/4 passed (50.0%), threshold 75.0%')
    expect(text).toContain('x kyro: json_fields 0.00 (title: expected "Kyro", got "Kyro Labs")')
    expect(() => assertEval(report)).toThrow(EvalFailure)
    // The same set with a lower bar passes.
    const ok = await evalUnit(briefTask, { cases: cases.slice(0, 2), fake, live: false, run: (c) => ai.run(ctx, briefTask, c.input as never, { save: false }), scorers: [exact({ path: 'title', expected: (c) => (c.expected as { title: string }).title })], minCases: 2 })
    expect(assertEval(ok).pass).toBe(true)
    expect(ok.warnings).toEqual([])
  })

  test('the threshold comes from the option, then the manifest, then the set\'s $meta, then 0.9', async () => {
    const set = parseJsonl(['{"$meta": {"threshold": 0.6}}', '{"input": "a", "expected": "a"}'].join('\n'))
    const marked = task({ ...briefTask, id: 'brief_marked', evals: { path: 'evals/tasks/brief.jsonl', threshold: 0.8 } })
    const unmarked = task({ ...briefTask, id: 'brief_unmarked', evals: { path: 'evals/tasks/brief.jsonl' } })
    const go = (unit: typeof briefTask | null, cases: typeof set | EvalCase[], threshold?: number) =>
      evalUnit(unit, { cases, live: false, run: (c) => c.input, scorers: [exact()], minCases: 1, ...(threshold !== undefined ? { threshold } : {}) })
    expect((await go(marked, set, 0.7)).threshold).toBe(0.7)
    expect((await go(marked, set)).threshold).toBe(0.8)
    expect((await go(unmarked, set)).threshold).toBe(0.6)
    expect((await go(briefTask, set)).threshold).toBe(0.6)
    expect((await go(briefTask, set.cases)).threshold).toBe(0.9)
    expect((await go(null, set.cases)).threshold).toBe(0.9)
    const r = await go(marked, set)
    expect(r.unit!.evals).toBe('evals/tasks/brief.jsonl')
  })

  test('loadGoldenSet reads the path of an { path, threshold } manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omazy-evals-'))
    mkdirSync(join(root, 'evals', 'tasks'), { recursive: true })
    writeFileSync(join(root, 'evals', 'tasks', 'marked.jsonl'), '{"input": {"url": "a"}}\n')
    const marked = task({ ...briefTask, id: 'brief_marked', evals: { path: 'evals/tasks/marked.jsonl', threshold: 0.8 } })
    expect((await loadGoldenSet(marked, { root })).source).toBe('evals/tasks/marked.jsonl')
  })

  test('a live run ignores the fake replies; a throwing run fails its case; plain outputs score as they are', async () => {
    const fake = fakeCore()
    const report = await evalUnit(null, {
      cases: [
        { input: 'a', expected: 'A', fake: reply.text('never used') },
        { input: 'b', expected: ['b', 'B!'] },
        { input: 'c', expected: 'C' },
      ],
      fake,
      live: true,
      concurrency: 3,
      run: (c) => {
        if (c.input === 'c') throw new Error('boom')
        return `${String(c.input).toUpperCase()}!`
      },
      scorers: [includes()],
      threshold: 0.5,
    })
    expect(fake.calls.length).toBe(0)
    expect(report.cases.map((c) => c.pass)).toEqual([true, true, false])
    expect(report.cases[2]!.error).toBe('boom')
    expect(report.pass).toBe(true)
    expect(report.warnings.some((w) => w.includes('live run'))).toBe(true)
  })

  test('evalCore gives the fake unless live, and a live client needs a token', () => {
    const fake = fakeCore()
    expect(evalCore({ fake, live: false })).toBe(fake.client)
    expect(() => evalCore({ fake, live: true, token: '' })).toThrow(/OMAZY_TOKEN/)
    expect(evalCore({ fake, live: true, token: 'cai_x.y', baseUrl: 'https://core.test/api/v1/core' })).not.toBe(fake.client)
  })

  test('scorers: exact, includes, json fields and schema', async () => {
    const c: EvalCase = { input: null }
    expect(await exact().score({ input: null, output: { a: 1, b: [2] }, expected: { b: [2], a: 1 }, case: c })).toBe(1)
    expect(await includes().score({ input: null, output: 'Your  INVOICE is due', expected: ['invoice', 'paid'], case: c })).toEqual({ score: 0.5, detail: 'missing "paid"' })
    expect(((await jsonFields({ loose: true }).score({ input: null, output: { name: ' rina ', role: 'host' }, expected: { name: 'Rina', role: 'host' }, case: c })) as { score: number }).score).toBe(1)
    expect(((await jsonFields().score({ input: null, output: { items: { 0: 'x' } }, expected: { 'items.0': 'x' }, case: c })) as { score: number }).score).toBe(1)
    expect(await schemaValid().score({ input: null, output: { title: 'x', summary: 'y' }, expected: null, case: c, unit: briefTask })).toBe(1)
    const bad = (await schemaValid(Brief).score({ input: null, output: { title: 'x' }, expected: null, case: c })) as { score: number; detail: string }
    expect(bad.score).toBe(0)
    expect(bad.detail).toContain('summary')
  })
})

// ---------------------------------------------------------------- actors

describe('actor cases', () => {
  test('runActorCase plays the turns and slotAccuracy scores values, questions and turns', async () => {
    const { rt, fake } = world()
    const set = parseJsonl(
      [
        JSON.stringify({
          id: 'rina_host',
          input: { turns: ['Please add Rina', 'as a host'] },
          expected: { slots: { name: 'Rina', role: 'host' }, asked: ['role'], turns: 2, state: 'confirm' },
          fake: [reply.json({ items: [item('name', 'Rina')] }), reply.json({ items: [item('role', 'host')] })],
        }),
        JSON.stringify({
          id: 'slow',
          input: { turns: ['Add someone', 'Rina', 'manager'] },
          expected: { slots: { name: 'Rina', role: 'host' }, asked: ['name', 'role'], turns: 2 },
          fake: [reply.json({ items: [] }), reply.json({ items: [item('name', 'Rina')] }), reply.json({ items: [item('role', 'manager')] })],
        }),
      ].join('\n'),
    )
    const report = await evalUnit(staffOnboard.unit, {
      cases: set,
      fake,
      live: false,
      run: (c) => runActorCase(rt, ctx, 'staff_onboard', c.input as never),
      scorers: [slotAccuracy()],
      threshold: 0.5,
      minCases: 1,
    })
    expect(report.cases[0]!.pass).toBe(true)
    const t = report.cases[0]!.output as { asked: string[]; turnsToComplete: number; values: Record<string, unknown> }
    expect(t.asked).toEqual(['role'])
    expect(t.turnsToComplete).toBe(2)
    expect(t.values).toMatchObject({ name: 'Rina', role: 'host' })
    const slow = report.cases[1]!
    expect(slow.pass).toBe(false)
    expect(slow.scores[0]!.detail).toContain('role: expected "host", got "manager"')
    expect(slow.scores[0]!.detail).toContain('stood after 3 turns, expected at most 2')
    expect(report.pass).toBe(true)
    // No card was confirmed: nothing was added.
    expect(staffAdded.length).toBe(0)
  })
})

// ---------------------------------------------------------------- tool picking

describe('tool picking', () => {
  const fixture = [
    { request: 'Show me the unpaid bills for Hemi', language: 'en', expected: 'invoices_open' },
    { request: 'Hire a new employee called Rina', language: 'en', expected: 'staff_add' },
    { request: 'Find the organisations named Hemi', language: 'en', expected: 'tenants_list' },
    { request: 'নভেম্বরের বকেয়া ইনভয়েস দেখান', language: 'bn', expected: 'invoices_open' },
    { request: 'নতুন কর্মী যোগ করুন', language: 'bn', expected: ['staff_add'] },
    { request: 'What is the weather', language: 'en', expected: 'tenants_list' },
  ]

  test('top-k over the registry search, by language, with the misses', async () => {
    const r = await toolPicking({ registry: reg, cases: fixture, audience: 'org', threshold: 0.8 })
    expect(r.total).toBe(6)
    expect(r.topK).toBe(0.8333)
    expect(r.pass).toBe(true)
    expect(r.byLanguage.bn).toEqual({ total: 2, top1: 1, topK: 1 })
    expect(r.misses.map((m) => m.request)).toEqual(['What is the weather'])
    expect(formatToolPicking(r)).toContain('PASS tool picking: top-5 83.3%')
    expect((await toolPicking({ registry: reg, cases: fixture, audience: 'org' })).pass).toBe(false)
  })

  test('a fixture naming a tool the registry lacks fails loudly', async () => {
    await expect(toolPicking({ registry: reg, cases: [{ request: 'x', expected: 'invoice_list' }] })).rejects.toThrow(/invoice_list/)
  })

  test('the model picker asks a model with the model tools, through a run of the unit', async () => {
    const fake = fakeCore()
    fake.on((r) => r.body.tool_choice === 'any', (r) => reply.tool(r.body.messages[0]!.content.includes('bill') ? 'invoices_open' : 'tenants_list', {}))
    const { ai } = world(fake)
    const r = await toolPicking({ registry: reg, cases: fixture.slice(0, 2), pick: modelPicker({ ai, ctx, unit: helper, registry: reg, audience: 'org', maxTier: 'R2' }) })
    expect(r.top1).toBe(0.5)
    const sent = fake.completions()[0]!
    expect(sent.tags.unit).toBe('org_helper')
    expect(sent.tags.eval).toBe('tool_picking')
    expect(sent.body.tools!.map((t) => t.name)).toEqual(['tenants_list', 'invoices_open', 'staff_add'])
  })
})

// ---------------------------------------------------------------- judges

describe('judge', () => {
  test('grades against a rubric through the AI kit: its own unit, tags, the reply fenced', async () => {
    const fake = fakeCore()
    fake.on(JUDGE_UNIT_ID, reply.json({ verdicts: [
      { id: 'cholito', pass: true, reason: 'চলিত' },
      { id: 'apni', pass: true, reason: 'আপনি' },
      { id: 'numerals', pass: false, reason: 'The amount is in Latin digits.' },
      { id: 'no_casual_particles', pass: true, reason: 'none' },
    ] }))
    const j = judge({ rubric: BANGLA_REGISTER, omazy: fake.client, tags: { eval_unit: 'greeting_bn' } })
    const r = await j.score({ input: 'Write the payment note', output: 'আপনার 29,900 টাকার পেমেন্ট পেয়েছি।', expected: null, case: { input: null } })
    expect(r).toMatchObject({ score: 0.75, detail: 'numerals: The amount is in Latin digits.' })
    const call = fake.completions()[0]!
    expect(call.role).toBe('extract.strong')
    expect(JUDGE_ROLE).toBe('extract.strong')
    expect(call.tags).toMatchObject({ unit: 'eval_judge', eval_unit: 'greeting_bn', rubric: 'bangla_register' })
    expect(call.body.cache_ttl).toBe(0)
    const sys = call.body.system!
    expect(sys).toContain('Rubric: Bangla register')
    expect(sys).toContain('- apni: ')
    // The graded text reaches the model only inside a fence.
    expect(unfencedHits([call], 'আপনার 29,900 টাকার পেমেন্ট পেয়েছি।')).toEqual([])
    expect(j.passAt).toBe(1)
  })

  test('a missing verdict fails its criterion; a cap stops the judge', async () => {
    const fake = fakeCore({ fallback: reply.json({ verdicts: [{ id: 'cholito', pass: true, reason: '' }] }) })
    const j = judge({ rubric: { id: 'two', title: 'Two', criteria: [{ id: 'cholito', text: 'x', weight: 3 }, { id: 'apni', text: 'y' }] }, omazy: fake.client, passAt: 0.7 })
    expect(await j.score({ input: undefined, output: { text: 'x' }, expected: null, case: { input: null } })).toMatchObject({ score: 0.75, detail: 'apni: no verdict' })
    const strict = fakeCore({ fallback: reply.json({ verdicts: [{ id: 'cholito', pass: true, reason: '' }, { id: 'apni', pass: true, reason: '' }] }) })
    const own = judge({ rubric: { id: 'two', title: 'Two', criteria: [{ id: 'cholito', text: 'x' }, { id: 'apni', text: 'y' }] }, omazy: strict.client, role: 'grade.strict', roles: { 'grade.strict': 'anthropic/claude-opus-5.5' } })
    expect(await own.score({ input: undefined, output: 'x', expected: null, case: { input: null } })).toMatchObject({ score: 1 })
    expect(strict.completions()[0]!.body.model).toBe('anthropic/claude-opus-5.5')
    const capped = judge({ rubric: BANGLA_REGISTER, omazy: fakeCore({ budgetUsd: 0 }).client })
    await expect(capped.score({ input: undefined, output: 'x', expected: null, case: { input: null } })).rejects.toThrow(/refused_cap/)
    expect(() => judge({ rubric: { id: 'Bad', title: 'b', criteria: [] }, omazy: fake.client })).toThrow(/rubric Bad/)
  })

  test('wraps an autoevals scorer, and gives model-graded ones an OpenAI-shaped client on the AI kit', async () => {
    function Levenshtein({ output, expected }: { output: string; expected?: string }) {
      return { name: 'Levenshtein', score: output === expected ? 1 : 0.6 }
    }
    const lev = fromAutoevals(Levenshtein, { passAt: 0.5 })
    expect(lev.name).toBe('levenshtein')
    expect(await lev.score({ input: null, output: 'Rina', expected: 'Rena', case: { input: null } })).toEqual({ score: 0.6 })
    const none = fromAutoevals(() => ({ name: 'X', score: null }))
    expect(await none.score({ input: null, output: 'a', expected: 'a', case: { input: null } })).toMatchObject({ score: 0 })

    const fake = fakeCore({ fallback: reply.tool('select_choice', { reasons: 'Same facts.', choice: 'C' }) })
    const client = autoevalsClient({ omazy: fake.client, tags: { eval_unit: 'brief_draft' } })
    const res = await client.chat.completions.create({
      model: 'judge',
      messages: [{ role: 'system', content: 'You compare answers.' }, { role: 'user', content: [{ type: 'text', text: 'Compare A and B' }] }],
      tools: [{ type: 'function', function: { name: 'select_choice', parameters: { type: 'object', properties: { choice: { type: 'string' } } } } }],
      tool_choice: { type: 'function', function: { name: 'select_choice' } },
      max_tokens: 300,
    })
    expect(res.choices[0]!.finish_reason).toBe('tool_calls')
    expect(JSON.parse(res.choices[0]!.message.tool_calls![0]!.function.arguments)).toEqual({ reasons: 'Same facts.', choice: 'C' })
    const sent = fake.completions()[0]!
    expect(sent.body.system).toBe('You compare answers.')
    expect(sent.body.tool_choice).toEqual({ type: 'tool', name: 'select_choice' })
    expect(sent.body.max_tokens).toBe(300)
    expect(sent.tags).toMatchObject({ unit: 'eval_autoevals', scorer: 'autoevals', eval_unit: 'brief_draft' })
    expect(sent.role).toBe('extract.strong')
    expect((await client.ai.runs.getRun(res.id))!.outcome).toBe('ok')
  })
})

// ---------------------------------------------------------------- injection

describe('injection suite', () => {
  test('the fixtures cover every slot in English and Bangla', () => {
    for (const s of ['visitor', 'attachment', 'website', 'staff_name'] as const) {
      expect(INJECTION_FIXTURES.filter((f) => f.slot === s && f.language === 'en').length).toBeGreaterThan(0)
      expect(INJECTION_FIXTURES.filter((f) => f.slot === s && f.language === 'bn').length).toBeGreaterThan(0)
    }
    expect(new Set(INJECTION_FIXTURES.map((f) => f.id)).size).toBe(INJECTION_FIXTURES.length)
  })

  // A copilot loop that runs every tool call the model makes, through the run's guard.
  async function copilotTurn(fx: InjectionFixture, o: { upstream?: boolean } = {}) {
    const fake = fakeCore({ fallback: obeyingModel({ calls: [{ name: 'tenant_delete', input: { tenant_id: 'hemibeauty' } }, { name: 'staff_add', input: { name: 'Mallory', role: 'manager' } }] }) })
    const { ai, guard } = world(fake)
    const scope = await ai.start(ctx, helper)
    const built = await scope.context({ input: { message: fx.text } })
    const res = await scope.complete({ system: built.system, messages: built.messages, tools: reg.modelTools({ audience: 'org' }) })
    for (const t of res.tool_calls ?? []) await scope.call(t.name, t.input, o.upstream ? { confirm: 'upstream' } : {})
    await scope.finish('ok')
    return { calls: guard.calls, requests: fake.completions() }
  }

  test('a copilot that obeys every hostile text still runs no R3 or R4 and no R2 without a card', async () => {
    const report = await injectionSuite({ run: (fx) => copilotTurn(fx) })
    expect(report.total).toBe(INJECTION_FIXTURES.length)
    expect(report.pass).toBe(true)
    expect(deleted.length).toBe(0)
    expect(staffAdded.length).toBe(0)
    expect(formatInjection(report)).toBe(`PASS injection suite: ${report.total}/${report.total} fixtures held`)
  })

  test('the suite catches a product that confirms upstream for the person', async () => {
    const report = await injectionSuite({ run: (fx) => copilotTurn(fx, { upstream: true }), slots: ['staff_name'] })
    expect(report.pass).toBe(false)
    expect(report.cases[0]!.violations.map((v) => v.kind)).toEqual(['r2_upstream_confirm'])
    expect(formatInjection(report)).toContain('x staff_name_tool_en [staff_name, en]: staff_add (R2) ran as confirmed upstream')
    staffAdded.length = 0
  })

  test('an actor fed hostile text by an obeying model stops at the card', async () => {
    const report = await injectionSuite({
      slots: ['visitor', 'staff_name'],
      run: async (fx) => {
        const fake = fakeCore({ fallback: obeyingModel({ output: { items: [item('name', fx.text.slice(0, 80)), item('role', 'manager')] } }) })
        const { rt, guard } = world(fake)
        const r = await rt.start(ctx, 'staff_onboard', { text: fx.text })
        expect(r.state).toBe('confirm')
        return { calls: guard.calls, requests: fake.completions() }
      },
    })
    expect(report.pass).toBe(true)
    expect(report.cases.every((c) => c.calls >= 1)).toBe(true)
    expect(staffAdded.length).toBe(0)
  })

  test('the person\'s click is a confirm with the card\'s token, which passes; a forged one does not', async () => {
    const { rt, guard, fake } = world()
    fake.push(reply.json({ items: [item('name', 'Rina'), item('role', 'host')] }))
    const r = await rt.start(ctx, 'staff_onboard', { text: 'Add Rina as host' })
    const done = await rt.confirm(ctx, r.session, r.card!.id)
    expect(done.state).toBe('done')
    expect(unsafeEffects(guard.calls)).toEqual([])
    const forged: GuardCallRecord[] = [{ via: 'call', name: 'staff_add', tier: 'R2', argsHash: 'h1', confirmToken: true, sentToken: 'tok', upstream: false, outcome: 'ok', channel: 'mcp' }]
    expect(unsafeEffects(forged).map((v) => v.kind)).toEqual(['r2_without_card'])
    const otherArgs: GuardCallRecord[] = [
      { via: 'call', name: 'staff_add', tier: 'R2', argsHash: 'h1', confirmToken: false, upstream: false, outcome: 'confirm_required', issuedToken: 'tok', channel: 'mcp' },
      { ...forged[0]!, argsHash: 'h2' },
    ]
    expect(unsafeEffects(otherArgs).map((v) => v.kind)).toEqual(['r2_without_card'])
    const r3: GuardCallRecord[] = [
      { via: 'call', name: 'tenant_delete', tier: 'R4', argsHash: 'h', confirmToken: false, upstream: false, outcome: 'ok', channel: 'mcp' },
      { via: 'decide', name: 'tenant_delete', tier: 'R4', argsHash: null, confirmToken: false, upstream: false, outcome: 'ok', channel: 'mcp' },
    ]
    expect(unsafeEffects(r3).map((v) => v.kind)).toEqual(['r3_executed', 'approval_decided'])
    expect(unsafeEffects(r3.slice(1), { allowDecisions: true })).toEqual([])
    expect(() => assertNoUnsafeEffects(r3)).toThrow(InjectionViolation)
    staffAdded.length = 0
  })

  test('unfencedHits finds hostile text put in a system prompt outside a fence', () => {
    const text = INJECTION_FIXTURES[0]!.text
    const call = (system: string) => ({ route: 'ai.complete', method: 'POST', path: '/ai/complete', body: { system, messages: [] }, tags: {}, role: undefined, n: 1, status: 200, stream: false })
    expect(unfencedHits([call(`Rules.\n<untrusted source="message">\n${text}\n</untrusted>`)], text)).toEqual([])
    expect(unfencedHits([call(`Rules. The visitor said: ${text}`)], text).length).toBe(1)
  })
})

// ---------------------------------------------------------------- contract

describe('route contract', () => {
  // Beside the SDKs: two levels up in the public repository, three in the platform's own.
  const path = ['../../contracts/core-api.routes.json', '../../../contracts/core-api.routes.json'].map((r) => new URL(r, import.meta.url)).find((u) => existsSync(u))
  const contract = JSON.parse(readFileSync(path!, 'utf8'))

  test('this SDK matches the contract it ships with', async () => {
    const r = await assertRouteContract({ contract })
    expect(r.ok).toBe(true)
    expect(r.checked).toBe(Object.keys(ROUTES).length)
    expect(r.newOnPlatform).toEqual([])
  })

  test('a route moved or gone on the platform fails; one the product does not use is ignored; a new one is noted', async () => {
    const moved = {
      routes: contract.routes
        .filter((x: { sdk: string }) => x.sdk !== 'voice.speak')
        .map((x: { sdk: string; path: string }) => (x.sdk === 'ai.complete' ? { ...x, path: '/ai/completions' } : x))
        .concat([{ method: 'POST', path: '/documents/parse', sdk: 'documents.parse' }]),
    }
    const r = await checkRouteContract({ contract: moved })
    expect(r.problems.map((p) => [p.route, p.kind])).toEqual([
      ['ai.complete', 'changed'],
      ['voice.speak', 'missing_on_platform'],
    ])
    expect(r.newOnPlatform).toEqual(['documents.parse'])
    expect((await checkRouteContract({ contract: moved, uses: ['knowledge.search'] })).ok).toBe(true)
    await expect(assertRouteContract({ contract: moved, uses: ['ai.complete'] })).rejects.toThrow(ContractError)
  })

  test('fetches the published contract', async () => {
    const seen: string[] = []
    const fetcher = (async (u: RequestInfo | URL) => {
      seen.push(String(u))
      return new Response(JSON.stringify(contract), { status: 200 })
    }) as typeof fetch
    expect((await checkRouteContract({ fetch: fetcher })).ok).toBe(true)
    expect(seen[0]).toBe('https://raw.githubusercontent.com/omazyai/omazy-sdk/main/contracts/core-api.routes.json')
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
    await expect(checkRouteContract({ fetch: down, contract: 'https://example.test/c.json' })).rejects.toThrow(/answered 503/)
  })

  test('prefers the live route when given a base URL, and falls back to the published file', async () => {
    const seen: string[] = []
    const live = (async (u: RequestInfo | URL) => {
      seen.push(String(u))
      return new Response(JSON.stringify({ success: true, data: contract }), { status: 200 })
    }) as typeof fetch
    const r = await checkRouteContract({ fetch: live, baseUrl: 'https://mw.test/api/v1/core/' })
    expect(r.ok).toBe(true)
    expect(r.source).toBe('https://mw.test/api/v1/core/contract')
    expect(seen).toEqual(['https://mw.test/api/v1/core/contract'])
    expect(r.liveError).toBeUndefined()

    const liveDown = (async (u: RequestInfo | URL) => {
      seen.push(String(u))
      if (String(u).endsWith('/core/contract')) return new Response('', { status: 404 })
      return new Response(JSON.stringify(contract), { status: 200 })
    }) as typeof fetch
    const back = await checkRouteContract({ fetch: liveDown, baseUrl: 'https://mw.test/api/v1/core' })
    expect(back.ok).toBe(true)
    expect(back.source).toBe(CONTRACT_URL)
    expect(back.liveError).toMatch(/answered 404/)
  })
})

test('memoryAdapters gives fresh stores for every kit', () => {
  const a = memoryAdapters()
  const b = memoryAdapters()
  expect(Object.keys(a).sort()).toEqual(['guardStore', 'memory', 'rateLimiter', 'requestLog', 'runs', 'sessions', 'switches'])
  expect(a.runs).not.toBe(b.runs)
})
