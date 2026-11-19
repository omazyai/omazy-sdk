import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { Omazy, OmazyError, ROUTES, RETRYABLE, type RouteName } from '../src/index'
import { READ, readSigned, serveMcp, sign, verifySignature, type Registry } from '../src/server'

// hmac-sha256('s3cret', '{"a":1}') in hex, computed with openssl.
const SIG_VECTOR = '5910e62016ef5034272c926c27071992a465c2335cecf41851bda071577f4f6d'

type Seen = { method: string; url: string; headers: Headers; body: string }

/** A fetch that answers from a queue of responses and records what it was sent. */
function mock(...answers: (Response | (() => Response) | Error)[]) {
  const seen: Seen[] = []
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : init?.body ? '<binary>' : ''
    seen.push({ method: init?.method ?? 'GET', url: String(url), headers: new Headers(init?.headers), body })
    const a = answers.length > 1 ? answers.shift()! : answers[0]!
    if (a instanceof Error) throw a
    return typeof a === 'function' ? a() : a.clone()
  }) as typeof fetch
  return { fetcher, seen }
}

const ok = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, error: { code, message } }), { status, headers })

const client = (fetcher: typeof fetch, extra = {}) =>
  new Omazy({ token: 'cai_abc.def', baseUrl: 'https://api.test/core', fetch: fetcher, ...extra })

describe('contract', () => {
  const contract = JSON.parse(readFileSync(contractPath(), 'utf8')) as {
    routes: { method: string; path: string; sdk: string }[]
  }

  test('the route table is the contract, route for route', () => {
    const want = Object.fromEntries(contract.routes.map((r) => [r.sdk, [r.method, r.path]]))
    expect(ROUTES as Record<string, readonly [string, string]>).toEqual(want)
  })

  test('every route in the table is reachable through a client method', async () => {
    const { fetcher: answer, seen } = mock(() => ok({ passages: [] }))
    // The MCP route speaks JSON-RPC, not the envelope.
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const res = await answer(url, init)
      return String(url).endsWith('/mcp') ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } })) : res
    }) as typeof fetch
    const o = client(fetcher)
    await o.whoami()
    await o.ai.complete({ messages: [{ role: 'user', content: 'hi' }] })
    await o.knowledge.search('q')
    await o.agent.turn({ message: 'hi' })
    await o.voice.speak('hi')
    await o.voice.transcribe(new Uint8Array([1, 2]))
    await o.voice.calls.place({ to: '+8801712345678', purpose: 'reminder', consent_basis: 'customer' })
    await o.voice.calls.get('r1')
    await o.voice.jobs.create({ kind: 'transcribe', source_url: 'https://x.test/a.mp3' })
    await o.voice.jobs.get('j1')
    await o.customers.get('c1')
    await o.customers.update('c1', { tier: 'gold' })
    await o.conversations.postMessage('s1', [{ type: 'text', markdown: 'hi' }])
    await o.channels.linkedinPublish({ text: 'hi' })
    await o.sessions.bindCredential('s1', 'erp', { token: 't', expires_at: '2027-01-01T00:00:00Z', subject: {} })
    await o.sessions.unbindCredential('s1', 'erp')
    await o.mcp.listTools()

    const used = new Set(seen.map((s) => `${s.method} ${new URL(s.url).pathname.replace('/core', '')}`))
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const filled = path.replace('{ref}', 'r1').replace('{id}', name.startsWith('voice.jobs') ? 'j1' : name.startsWith('conv') ? 's1' : 'c1').replace('{sid}', 's1').replace('{server}', 'erp')
      expect(used.has(`${method} ${filled}`), `${name} (${method} ${filled}) was never called`).toBe(true)
    }
  })

  test('nothing that changes the world is retried', () => {
    for (const name of ['voice.calls.place', 'conversations.post_message', 'channels.linkedin_publish', 'agent.turn', 'customers.update', 'voice.jobs.create', 'mcp'] as RouteName[]) {
      expect(RETRYABLE.has(name)).toBe(false)
    }
  })
})

describe('requests', () => {
  test('sends the token, unwraps the envelope and applies the default app', async () => {
    const { fetcher, seen } = mock(ok({ text: 'pong', stop_reason: 'stop', model: 'openai/gpt-4o', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }))
    const res = await client(fetcher, { app: 'kiosk' }).ai.complete({ messages: [{ role: 'user', content: 'ping' }] })
    expect(res.text).toBe('pong')
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer cai_abc.def')
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ app: 'kiosk', stream: false })
  })

  test('path arguments are escaped into one segment', async () => {
    const { fetcher, seen } = mock(ok({}))
    await client(fetcher).voice.calls.get('a/../b', { app: 'kiosk' })
    expect(seen[0]!.url).toBe('https://api.test/core/voice/calls/a%2F..%2Fb?app=kiosk')
  })

  test('a refusal becomes an OmazyError carrying the code, status and request id', async () => {
    const { fetcher } = mock(fail(403, 'FORBIDDEN', 'missing scope: ai:complete', { 'x-request-id': 'req_1' }))
    const err = await client(fetcher).ai.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)
    expect(err).toBeInstanceOf(OmazyError)
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'missing scope: ai:complete', requestId: 'req_1' })
  })

  test('response headers are read into last', async () => {
    const { fetcher } = mock(ok({}, { 'x-request-id': 'req_9', 'x-ratelimit-limit': '600', 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '3', 'x-omazy-token-use': 'previous', 'x-omazy-token-expires-at': '2026-12-01T00:00:00Z' }))
    const o = client(fetcher)
    await o.whoami()
    expect(o.last).toEqual({ requestId: 'req_9', rateLimit: { limit: 600, remaining: 12, resetSeconds: 3 }, tokenExpiresAt: '2026-12-01T00:00:00Z', tokenIsPrevious: true })
  })
})

describe('retries', () => {
  test('a rate-limited read is sent again after Retry-After', async () => {
    const { fetcher, seen } = mock(fail(429, 'RATE_LIMIT_EXCEEDED', 'slow down', { 'retry-after': '0' }), fail(503, 'UPSTREAM_UNAVAILABLE', 'busy', { 'retry-after': '0' }), ok({ passages: [{ title: 't' }] }))
    const passages = await client(fetcher).knowledge.search('q')
    expect(passages).toHaveLength(1)
    expect(seen).toHaveLength(3)
  })

  test('placing a call is never sent twice', async () => {
    const { fetcher, seen } = mock(fail(503, 'UPSTREAM_UNAVAILABLE', 'busy', { 'retry-after': '0' }))
    const err = await client(fetcher).voice.calls.place({ to: '+8801712345678', purpose: 'reminder', consent_basis: 'customer' }).catch((e) => e)
    expect(err).toMatchObject({ status: 503, retryAfter: undefined })
    expect(seen).toHaveLength(1)
  })

  test('a full window is handed back to the caller instead of being waited out', async () => {
    const { fetcher, seen } = mock(fail(429, 'RATE_LIMIT_EXCEEDED', 'slow down', { 'retry-after': '540' }))
    const err = await client(fetcher).whoami().catch((e) => e)
    expect(err).toMatchObject({ status: 429, retryAfter: 540 })
    expect(seen).toHaveLength(1)
  })

  test('a 400 is not retried', async () => {
    const { fetcher, seen } = mock(fail(400, 'BAD_REQUEST', 'messages is required'))
    await client(fetcher).ai.complete({ messages: [] }).catch(() => {})
    expect(seen).toHaveLength(1)
  })

  test('a dropped connection is retried, then reported', async () => {
    const { fetcher, seen } = mock(new TypeError('socket hang up'))
    const err = await client(fetcher, { maxRetries: 1 }).whoami().catch((e) => e)
    expect(err).toMatchObject({ status: 0, code: 'NETWORK_ERROR' })
    expect(seen).toHaveLength(2)
  })
})

describe('streaming', () => {
  const sse = (chunks: Uint8Array[]) =>
    new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const bytes = (s: string) => new TextEncoder().encode(s)

  test('frames and characters split across chunks are put back together', async () => {
    const whole = bytes('event: delta\ndata: {"text":"নমস্কার"}\n\nevent: delta\ndata: {"text":" world"}\n\nevent: done\ndata: {"text":"নমস্কার world","stop_reason":"stop","model":"m","usage":{"input_tokens":1,"output_tokens":2,"cached_input_tokens":0}}\n\n')
    // Cut inside a multibyte character and inside a frame.
    const { fetcher, seen } = mock(sse([whole.slice(0, 31), whole.slice(31, 70), whole.slice(70)]))
    const out: string[] = []
    let final = ''
    for await (const ev of client(fetcher).ai.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (ev.type === 'delta') out.push(ev.text)
      else final = ev.result.text
    }
    expect(out).toEqual(['নমস্কার', ' world'])
    expect(final).toBe('নমস্কার world')
    expect(JSON.parse(seen[0]!.body).stream).toBe(true)
  })

  test('an error frame is thrown', async () => {
    const { fetcher } = mock(sse([bytes('event: delta\ndata: {"text":"a"}\n\nevent: error\ndata: {"message":"the workspace\'s AI budget is spent"}\n\n')]))
    const run = async () => { for await (const _ of client(fetcher).ai.stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ } }
    await expect(run()).rejects.toMatchObject({ code: 'STREAM_ERROR', message: "the workspace's AI budget is spent" })
  })

  test('a stream that stops before done is an error, not a short answer', async () => {
    const { fetcher } = mock(sse([bytes('event: delta\ndata: {"text":"half"}\n\n')]))
    const run = async () => { for await (const _ of client(fetcher).ai.stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ } }
    await expect(run()).rejects.toMatchObject({ code: 'STREAM_ERROR' })
  })
})

describe('mcp', () => {
  const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })

  test('lists tools and calls one', async () => {
    const { fetcher, seen } = mock(rpc({ tools: [{ name: 'knowledge_search', inputSchema: {} }] }), rpc({ content: [{ type: 'text', text: '{"passages":[]}' }], structuredContent: { passages: [] }, isError: false }))
    const o = client(fetcher)
    expect((await o.mcp.listTools()).map((t) => t.name)).toEqual(['knowledge_search'])
    const res = await o.mcp.callTool('knowledge_search', { query: 'hours' })
    expect(res).toEqual({ text: '{"passages":[]}', data: { passages: [] }, isError: false })
    expect(JSON.parse(seen[1]!.body)).toMatchObject({ method: 'tools/call', params: { name: 'knowledge_search', arguments: { query: 'hours' } } })
    expect(seen[1]!.url).toBe('https://api.test/core/mcp')
  })

  test('a tool refusal is returned, an unknown tool is thrown', async () => {
    const { fetcher } = mock(rpc({ content: [{ type: 'text', text: 'BAD_REQUEST: query is required' }], isError: true }), new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Unknown tool: nope' } })))
    const o = client(fetcher)
    expect(await o.mcp.callTool('knowledge_search')).toMatchObject({ isError: true, text: 'BAD_REQUEST: query is required' })
    await expect(o.mcp.callTool('nope')).rejects.toMatchObject({ code: 'MCP_-32602' })
  })

  test('config hands the server to another MCP client', () => {
    const { fetcher } = mock(ok({}))
    expect(client(fetcher).mcp.config()).toEqual({ type: 'http', url: 'https://api.test/core/mcp', headers: { Authorization: 'Bearer cai_abc.def' } })
  })
})

describe('server helpers', () => {
  test('a signature verifies over the exact body and nothing else', async () => {
    const header = await sign('s3cret', '{"a":1}')
    // Fixed vector, so the three SDKs and the platform agree on the bytes.
    expect(header).toBe('sha256=' + SIG_VECTOR)
    expect(await verifySignature('s3cret', '{"a":1}', header)).toBe(true)
    expect(await verifySignature('s3cret', '{"a": 1}', header)).toBe(false)
    expect(await verifySignature('other', '{"a":1}', header)).toBe(false)
    expect(await verifySignature('s3cret', '{"a":1}', null)).toBe(false)
  })

  test('readSigned refuses before it parses', async () => {
    const body = '{"flow":"book"}'
    const good = new Request('https://app.test/flow', { method: 'POST', body, headers: { 'x-omazy-signature': await sign('k', body) } })
    expect(await readSigned(good, 'k')).toEqual({ ok: true, body: { flow: 'book' } })
    const bad = new Request('https://app.test/flow', { method: 'POST', body, headers: { 'x-omazy-signature': 'sha256=00' } })
    expect(await readSigned(bad, 'k')).toEqual({ ok: false, status: 401 })
    const unconfigured = new Request('https://app.test/flow', { method: 'POST', body })
    expect(await readSigned(unconfigured, undefined)).toEqual({ ok: false, status: 503 })
  })

  test('an MCP tool server answers the platform and nobody else', async () => {
    const reg: Registry<{ who: string }> = {
      info: { name: 'desk', title: 'Desk', version: '1.0.0' },
      instructions: () => 'Front desk tools.',
      tools: [{ name: 'find_staff', title: 'Find staff', description: 'Look a person up.', inputSchema: { type: 'object' }, annotations: READ }],
      call: async (_name, args, ctx) => ({ text: `${ctx.who}:${String(args.q)}`, structured: { hit: true } }),
    }
    const post = (body: unknown, token = 'tok') =>
      serveMcp(new Request('https://desk.test/mcp', { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }), 'tok', reg, () => ({ who: 'ctx' }))

    const called = (await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_staff', arguments: { q: 'imran' } } })).json()) as { result: { content: { text: string }[]; structuredContent: unknown; isError: boolean } }
    expect(called.result).toEqual({ content: [{ type: 'text', text: 'ctx:imran' }], structuredContent: { hit: true }, isError: false })
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong')).status).toBe(401)
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    expect((await serveMcp(new Request('https://desk.test/health'), 'tok', reg, () => ({ who: '' }))).status).toBe(200)
  })
})

// The contract sits beside the SDKs: two levels up in the public repository,
// three in the platform's own.
function contractPath(): URL {
  for (const rel of ['../../contracts/core-api.routes.json', '../../../contracts/core-api.routes.json']) {
    const url = new URL(rel, import.meta.url)
    if (existsSync(url)) return url
  }
  throw new Error('contracts/core-api.routes.json not found')
}
