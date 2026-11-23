import { describe, expect, test } from 'bun:test'
import { Omazy, type CompleteRequest } from '../src/index'

type Seen = { method: string; url: string; body: string }

function mock(data: unknown) {
  const seen: Seen[] = []
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ method: init?.method ?? 'GET', url: String(url), body: typeof init?.body === 'string' ? init.body : '' })
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetcher, seen }
}

const client = (fetcher: typeof fetch) => new Omazy({ token: 'cai_abc.def', baseUrl: 'https://api.test/core', fetch: fetcher })

describe('AL-10 on ai.complete', () => {
  test('response_format, a forced tool and images go out as the API reads them', async () => {
    const { fetcher, seen } = mock({ text: '{"title":"Hi"}', stop_reason: 'stop', model: 'openai/gpt-4o-mini', usage: {}, output: { title: 'Hi' } })
    const req: CompleteRequest = {
      messages: [{ role: 'user', content: 'read it', images: [{ url: 'https://a.b/slip.png' }, { data: 'AAAA', media_type: 'image/png' }] }],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'lookup' },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'brief', strict: true, schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } },
      },
    }
    const res = await client(fetcher).ai.complete(req)
    expect(res.output).toEqual({ title: 'Hi' })
    const sent = JSON.parse(seen[0]!.body)
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'lookup' })
    expect(sent.response_format.json_schema.strict).toBe(true)
    expect(sent.messages[0].images[1]).toEqual({ data: 'AAAA', media_type: 'image/png' })
  })
})

describe('embeddings and the model list', () => {
  test('embed takes a string, a list or a request, and models reads the default app', async () => {
    const { fetcher, seen } = mock({ model: '@cf/baai/bge-m3', dimensions: 2, embeddings: [{ index: 0, embedding: [0.1, 0.2] }], usage: { input_tokens: 1 } })
    const o = new Omazy({ token: 'cai_abc.def', baseUrl: 'https://api.test/core', fetch: fetcher, app: 'kiosk' })
    const res = await o.ai.embed(['a'])
    expect(res.embeddings[0]!.embedding).toEqual([0.1, 0.2])
    await o.ai.embed('b')
    await o.ai.embed({ input: ['c'], model: '@cf/baai/bge-m3' })
    expect(seen.map((s) => JSON.parse(s.body).input)).toEqual([['a'], 'b', ['c']])
    expect(seen[0]!.url).toBe('https://api.test/core/ai/embeddings')
    expect(JSON.parse(seen[0]!.body).app).toBe('kiosk')
    await o.ai.models()
    expect(seen[3]!).toMatchObject({ method: 'GET', url: 'https://api.test/core/ai/models?app=kiosk' })
  })
})

describe('model roles', () => {
  test('list, set and delete go to the role routes, and a role is named in model', async () => {
    const { fetcher, seen } = mock({ name: 'extract.fast', model: 'openai/gpt-4.1-mini', fallbacks: [], level: 'workspace', published: true })
    const o = client(fetcher)
    await o.ai.roles.list()
    const v = await o.ai.roles.set('extract.fast', { model: 'openai/gpt-4.1-mini', level: 'workspace' })
    expect(v.level).toBe('workspace')
    await o.ai.roles.delete('extract.fast', { level: 'workspace' })
    await o.ai.complete({ model: 'role:extract.fast', messages: [{ role: 'user', content: 'x' }] })
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET https://api.test/core/ai/roles',
      'PUT https://api.test/core/ai/roles/extract.fast',
      'DELETE https://api.test/core/ai/roles/extract.fast?level=workspace',
      'POST https://api.test/core/ai/complete',
    ])
    expect(JSON.parse(seen[1]!.body)).toEqual({ model: 'openai/gpt-4.1-mini', level: 'workspace' })
    expect(JSON.parse(seen[3]!.body).model).toBe('role:extract.fast')
  })
})

describe('tags and cost', () => {
  test('metadata goes out flat, cost_micros comes back, usage groups by a label', async () => {
    const { fetcher, seen } = mock({ text: 'hi', stop_reason: 'stop', model: 'm', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cost_micros: 42 } })
    const o = client(fetcher)
    const res = await o.ai.complete({ messages: [{ role: 'user', content: 'x' }], metadata: { unit: 'brief_draft', unit_version: '2', run_id: 'r1', tenant_tier: 'gold' } })
    expect(res.usage.cost_micros).toBe(42)
    expect(JSON.parse(seen[0]!.body).metadata).toEqual({ unit: 'brief_draft', unit_version: '2', run_id: 'r1', tenant_tier: 'gold' })
    await o.usage.get({ group_by: 'run_id', unit: 'brief_draft' })
    expect(seen[1]!.url).toBe('https://api.test/core/usage?group_by=run_id&unit=brief_draft')
  })
})

describe('spend caps', () => {
  test('set, list and delete go to /budgets; a capped call is an OmazyError with its code', async () => {
    const { fetcher, seen } = mock({ id: 'b1', label: 'unit', value: '*', period: 'day', limit_micros: 5000000, limit_usd: 5, spent_micros: 0, spent_usd: 0, resets_at: '2026-11-25T00:00:00Z' })
    const o = client(fetcher)
    const b = await o.budgets.set({ label: 'unit', value: '*', period: 'day', limit_usd: 5 })
    expect(b.limit_micros).toBe(5000000)
    await o.budgets.list()
    await o.budgets.delete('b1')
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'PUT https://api.test/core/budgets',
      'GET https://api.test/core/budgets',
      'DELETE https://api.test/core/budgets/b1',
    ])
    const refuse = (async () =>
      new Response(JSON.stringify({ success: false, error: { code: 'BUDGET_EXCEEDED', message: 'cap reached' } }), { status: 402 })) as typeof fetch
    const err = await client(refuse).ai.complete({ messages: [{ role: 'user', content: 'x' }], metadata: { unit: 'u' } }).catch((e) => e)
    expect(err).toMatchObject({ status: 402, code: 'BUDGET_EXCEEDED' })
  })
})
