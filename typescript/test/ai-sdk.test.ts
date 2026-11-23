import { describe, expect, test } from 'bun:test'
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { copilotUnit, createAi, memoryRunStore, promptTemplates } from '../src/ai/index'
import { aiSdkTools, omazyModel, toCoreMessages } from '../src/ai/ai-sdk'
import { type Ctx, defineCapabilities, registry, schema } from '../src/capabilities/index'
import { createGuard, memoryGuardStore } from '../src/guard/index'
import { Omazy } from '../src/index'

const ctx: Ctx = {
  principal: { kind: 'member', id: 'p_a' },
  seat: { id: 's1', door: 'org', tenant: 'tA' },
  tenant: 'tA',
  channel: 'copilot',
  approvalId: null,
  requestId: 'req_1',
}

const copilot = copilotUnit({
  id: 'joya_copilot',
  version: 4,
  owner: 'product',
  model: { use: 'converse', temperature: 0.3, maxOutputTokens: 800 },
  prompt: { template: 'copilot/main', version: 2, languages: ['en'] },
  context: { layers: ['unit'], budgetTokens: 8000, live: true },
  memory: { read: [], write: [] },
  evals: 'evals/copilot.jsonl',
  caps: { perRunUsd: 0.1, perDayUsd: 5 },
})
const prompts = promptTemplates({ 'copilot/main': { 2: { en: 'You are Joya.' } } })

const done = {
  text: 'Hello there',
  stop_reason: 'end_turn',
  model: 'anthropic/claude-sonnet-5.5',
  role: 'converse',
  usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60, cost_micros: 500 },
}

function fake() {
  const bodies: Record<string, unknown>[] = []
  const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    if (body.stream) {
      const sse = `event: delta\ndata: ${JSON.stringify({ text: 'Hello ' })}\n\nevent: delta\ndata: ${JSON.stringify({ text: 'there' })}\n\nevent: done\ndata: ${JSON.stringify(done)}\n\n`
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const data = body.tools
      ? { ...done, text: '', stop_reason: 'tool_use', tool_calls: [{ id: 'c1', name: 'tenants_list', input: { limit: 3 } }] }
      : done
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { client: new Omazy({ token: 'cai_abc.def', baseUrl: 'https://core.test/core', fetch: fetcher, maxRetries: 0 }), bodies }
}

async function setup() {
  const f = fake()
  const runs = memoryRunStore()
  const ai = createAi<Ctx>({ omazy: () => f.client, runs, prompts })
  const run = await ai.start(ctx, copilot)
  return { ...f, runs, run, model: omazyModel(run) }
}

const call = (over: Partial<LanguageModelV4CallOptions> = {}): LanguageModelV4CallOptions => ({
  prompt: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
  ],
  ...over,
})

describe('the AI SDK provider', () => {
  test('doGenerate is a call of the run: tags, role, unit settings, usage and cost', async () => {
    const { model, bodies, run, runs } = await setup()
    expect(model.specificationVersion).toBe('v4')
    expect(model.modelId).toBe('role:converse')
    const r = await model.doGenerate(call({ temperature: 1, topP: 0.5 }))
    expect(r.content).toEqual([{ type: 'text', text: 'Hello there' }])
    expect(r.finishReason).toEqual({ unified: 'stop', raw: 'end_turn' })
    expect(r.usage.inputTokens).toEqual({ total: 100, noCache: 40, cacheRead: 60, cacheWrite: undefined })
    expect(r.providerMetadata).toEqual({ omazy: { runId: run.id, unit: 'joya_copilot', model: 'anthropic/claude-sonnet-5.5', role: 'converse', cacheHit: false } })
    expect(r.warnings.map((w) => (w as { feature: string }).feature)).toEqual(['temperature', 'topP'])
    const b = bodies[0]!
    expect(b.metadata).toEqual({ unit: 'joya_copilot', unit_version: '4', prompt_version: '2', run_id: run.id })
    expect(b.model).toBe('role:converse')
    expect(b.temperature).toBe(0.3)
    expect(b.max_tokens).toBe(800)
    expect(b.cache_ttl).toBe(0)
    expect(b.system).toBe('Be brief.')
    expect((await runs.getRun(run.id))!.costMicros).toBe(500)
  })

  test('tools, a tool choice and a JSON schema reach the Core request; tool calls come back', async () => {
    const { model, bodies } = await setup()
    const r = await model.doGenerate(
      call({
        tools: [{ type: 'function', name: 'tenants_list', description: 'List tenants', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } }],
        toolChoice: { type: 'required' },
      }),
    )
    expect(bodies[0]!.tool_choice).toBe('any')
    expect(r.content).toEqual([{ type: 'tool-call', toolCallId: 'c1', toolName: 'tenants_list', input: '{"limit":3}' }])
    expect(r.finishReason.unified).toBe('tool-calls')
    await model.doGenerate(call({ responseFormat: { type: 'json', schema: { type: 'object' }, name: 'brief' } }))
    expect(bodies[1]!.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'brief', schema: { type: 'object' } } })
  })

  test('doStream streams through the run and sums its usage once', async () => {
    const { model, run } = await setup()
    const { stream } = await model.doStream(call())
    const parts: LanguageModelV4StreamPart[] = []
    for await (const p of stream as unknown as AsyncIterable<LanguageModelV4StreamPart>) parts.push(p)
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'text-start', 'text-delta', 'text-delta', 'text-end', 'response-metadata', 'finish'])
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => (p as { delta: string }).delta).join('')).toBe('Hello there')
    expect(run.usage).toMatchObject({ calls: 1, inputTokens: 100, costMicros: 500 })
  })

  test('the prompt maps to alternating Core turns, with tool results and images', () => {
    const warnings: never[] = []
    const out = toCoreMessages(
      [
        { role: 'user', content: [{ type: 'text', text: 'Read this slip' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array([1, 2, 3]) } }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'slip_read', input: { a: 1 } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'slip_read', output: { type: 'json', value: { amount: 500 } } }] },
        { role: 'user', content: [{ type: 'text', text: 'Thanks' }] },
      ],
      warnings,
    )
    expect(out.messages).toEqual([
      { role: 'user', content: 'Read this slip', images: [{ data: 'AQID', media_type: 'image/png' }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'slip_read', input: { a: 1 } }] },
      { role: 'user', content: 'Thanks', tool_results: [{ call_id: 't1', content: '{"amount":500}' }] },
    ])
    expect(warnings).toEqual([])
  })
})

describe('aiSdkTools', () => {
  const kit = defineCapabilities<Ctx, string, 'org'>()
  const D = (t: string) => `${t} This sentence pads the description so that it passes the eighty character minimum of the kit.`
  const list = kit.capability({
    name: 'tenants_list', audiences: ['org'], title: 'List tenants', description: D('Lists tenants.'), permission: 'x', risk: 'R0',
    input: schema.object({ limit: schema.integer({ min: 1, max: 9 }) }), version: 1, run: (_c, i) => ({ rows: ['tA'], limit: i.limit }),
  })
  const rename = kit.capability({
    name: 'tenant_rename', audiences: ['org'], title: 'Rename', description: D('Renames the tenant.'), permission: 'x', risk: 'R2',
    input: schema.object({ name: schema.text(80) }), version: 1, preview: (_c, i) => ({ summary: `Rename to ${i.name}`, stateVersion: 'v1' }), run: () => ({ ok: true }),
  })
  const reg = registry([list, rename])
  const unit = copilotUnit({
    id: 'tools_copilot', version: 1, owner: 'product', model: { use: 'converse' },
    prompt: { template: 'copilot/main', version: 2, languages: ['en'] }, context: { layers: ['unit'], budgetTokens: 2000 },
    memory: { read: [], write: [] }, tools: { allow: ['tenants_list', 'tenant_rename'], maxTier: 'R2' },
    evals: 'evals/x.jsonl', caps: { perRunUsd: 0.1, perDayUsd: 1 },
  })

  async function open() {
    const guard = createGuard<Ctx, string>({ registry: reg, can: () => true, secret: 'test-secret-test-secret-test-secret-0123', store: memoryGuardStore() })
    const runs = memoryRunStore()
    const ai = createAi<Ctx>({ omazy: () => fake().client, runs, prompts, guard, registry: reg })
    return { runs, run: await ai.start(ctx, unit) }
  }

  test('each tool describes its capability and runs through run.call into the ledger', async () => {
    const { run, runs } = await open()
    const seen: string[] = []
    const tools = aiSdkTools(run, reg, { onOutcome: (name, out, id) => void seen.push(`${name}:${out.outcome}:${id}`) })
    expect(Object.keys(tools)).toEqual(['tenants_list', 'tenant_rename'])
    expect(tools.tenants_list!.description).toBe(reg.describe('tenants_list'))
    expect(tools.tenants_list!.inputSchema['~standard'].jsonSchema.input({ target: 'draft-07' })).toEqual(list.inputJson)
    expect(await tools.tenants_list!.execute({ limit: 2 }, { toolCallId: 'c1' })).toEqual({ status: 'ok', result: { rows: ['tA'], limit: 2 } })

    // An R2 call comes back to the model as not done, with no token; the card gets the token.
    const answer = await tools.tenant_rename!.execute({ name: 'Hemi' }, { toolCallId: 'c2' })
    expect(answer).toMatchObject({ status: 'confirm_required', summary: 'Rename to Hemi' })
    expect(JSON.stringify(answer)).not.toContain('token')
    expect(await tools.tenants_list!.execute({ limit: 99 })).toMatchObject({ status: 'refused', outcome: 'invalid' })
    expect(seen).toEqual(['tenants_list:ok:c1', 'tenant_rename:confirm_required:c2', 'tenants_list:invalid:undefined'])
    expect((await runs.effects(run.id)).map((e) => `${e.capability}:${e.outcome}`)).toEqual(['tenants_list:ok', 'tenant_rename:confirm_required', 'tenants_list:invalid'])
  })

  test('names outside the unit are still refused by the run, and unknown names fail at once', async () => {
    const { run } = await open()
    const narrow = copilotUnit({ ...unit, id: 'narrow_copilot', tools: { allow: ['tenants_list'], maxTier: 'R0' } })
    const ai2 = createAi<Ctx>({ omazy: () => fake().client, runs: memoryRunStore(), prompts, guard: createGuard<Ctx, string>({ registry: reg, can: () => true, secret: 'test-secret-test-secret-test-secret-0123', store: memoryGuardStore() }), registry: reg })
    const r2 = await ai2.start(ctx, narrow)
    const tools = aiSdkTools(r2, reg, { names: ['tenant_rename'] })
    expect(await tools.tenant_rename!.execute({ name: 'x' })).toMatchObject({ status: 'refused', outcome: 'refused_unit' })
    expect(() => aiSdkTools(run, reg, { names: ['nope_list'] })).toThrow('not in the registry')
  })
})

describe('with the AI SDK itself (ai, a test-only dependency)', () => {
  test('generateText runs the tool loop through the guard into the ledger, Output.object parses, usage and cost add up', async () => {
    const { generateText, Output, stepCountIs } = await import('ai')
    const kit = defineCapabilities<Ctx, string, 'org'>()
    const D = (t: string) => `${t} This sentence pads the description so that it passes the eighty character minimum of the kit.`
    const list = kit.capability({
      name: 'tenants_list', audiences: ['org'], title: 'List tenants', description: D('Lists tenants.'), permission: 'x', risk: 'R0',
      input: schema.object({ limit: schema.integer({ min: 1, max: 9 }) }), version: 1, run: (_c, i) => ({ rows: ['tA'], limit: i.limit }),
    })
    const reg = registry([list])
    const guard = createGuard<Ctx, string>({ registry: reg, can: () => true, secret: 'test-secret-test-secret-test-secret-0123', store: memoryGuardStore() })
    const unit = copilotUnit({
      id: 'e2e_copilot', version: 1, owner: 'product', model: { use: 'converse' },
      prompt: { template: 'copilot/main', version: 2, languages: ['en'] }, context: { layers: ['unit'], budgetTokens: 2000 },
      memory: { read: [], write: [] }, tools: { allow: ['tenants_list'], maxTier: 'R0' },
      evals: 'evals/x.jsonl', caps: { perRunUsd: 0.1, perDayUsd: 1 },
    })
    const bodies: Record<string, any>[] = []
    const usage = { input_tokens: 5, output_tokens: 5, cached_input_tokens: 0, cost_micros: 10 }
    const fetcher = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body))
      bodies.push(b)
      const n = bodies.length
      const data =
        n === 1
          ? { text: '', stop_reason: 'tool_use', model: 'm', usage, tool_calls: [{ id: 'c1', name: 'tenants_list', input: { limit: 3 } }] }
          : { text: n === 3 ? '{"answer":"tA"}' : 'One tenant: tA', stop_reason: 'stop', model: 'm', usage }
      return new Response(JSON.stringify({ success: true, data }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const runs = memoryRunStore()
    const ai = createAi<Ctx>({ omazy: () => new Omazy({ token: 'cai_abc.def', baseUrl: 'https://core.test/core', fetch: fetcher, maxRetries: 0 }), runs, prompts, guard, registry: reg })
    const run = await ai.start(ctx, unit)

    const r = await generateText({ model: omazyModel(run), tools: aiSdkTools(run, reg), prompt: 'How many tenants?', stopWhen: stepCountIs(3) })
    expect(r.text).toBe('One tenant: tA')
    expect(r.steps).toHaveLength(2)
    expect(r.steps[0]!.toolResults[0]!.output).toEqual({ status: 'ok', result: { rows: ['tA'], limit: 3 } })
    expect(bodies[1]!.messages.at(-1).tool_results).toEqual([{ call_id: 'c1', content: '{"status":"ok","result":{"rows":["tA"],"limit":3}}' }])
    expect(bodies[0]!.tools[0].name).toBe('tenants_list')

    const o = await generateText({ model: omazyModel(run), output: Output.object({ schema: schema.object({ answer: schema.text(10) }) }), prompt: 'As JSON' })
    expect(o.output).toEqual({ answer: 'tA' })
    expect(bodies[2]!.response_format.type).toBe('json_schema')

    for (const b of bodies) expect(b.metadata).toEqual({ unit: 'e2e_copilot', unit_version: '1', prompt_version: '2', run_id: run.id })
    expect(run.usage).toMatchObject({ calls: 3, inputTokens: 15, outputTokens: 15, costMicros: 30, costEstimated: false })
    expect((await runs.effects(run.id)).map((e) => `${e.capability}:${e.outcome}`)).toEqual(['tenants_list:ok'])
    expect((await runs.getRun(run.id))!.costMicros).toBe(30)
  })
})
