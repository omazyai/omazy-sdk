import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import {
  ENTERPRISE_REPEATABLE,
  ENTERPRISE_ROUTES,
  IDEMPOTENT,
  Omazy,
  OmazyEnterprise,
  OmazyError,
  ROUTES,
  RETRYABLE,
  WEBSOCKET,
  type RouteName,
  type TranscriptionEvent,
} from '../src/index'
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
    routes: { method: string; path: string; sdk: string; idempotency_key?: boolean; websocket?: boolean }[]
  }

  test('the WebSocket routes are the ones the contract marks, and none is retried', () => {
    const want = contract.routes.filter((r) => r.websocket).map((r) => r.sdk).sort()
    expect([...WEBSOCKET].sort()).toEqual(want)
    for (const name of WEBSOCKET) expect(RETRYABLE.has(name) || IDEMPOTENT.has(name)).toBe(false)
  })

  test('the routes that take an idempotency key are the ones the contract marks', () => {
    const want = contract.routes.filter((r) => r.idempotency_key).map((r) => r.sdk).sort()
    expect([...IDEMPOTENT].sort()).toEqual(want)
    for (const name of IDEMPOTENT) expect(RETRYABLE.has(name)).toBe(false)
  })

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
    await o.knowledge.documents.list()
    await o.knowledge.documents.create({ title: 't', content: 'c' })
    await o.knowledge.documents.get('c1')
    await o.knowledge.documents.update('c1', { title: 't2' })
    await o.knowledge.documents.delete('c1')
    await o.knowledge.importFile(new Uint8Array([1, 2]), { filename: 'a.pdf' })
    await o.knowledge.sources.list()
    await o.knowledge.sources.create({ root_url: 'https://x.test' })
    await o.knowledge.sources.crawl('c1')
    await o.knowledge.export()
    await o.agent.turn({ message: 'hi' })
    await o.agent.settings.get()
    await o.agent.settings.update({ loop: { stream: true } })
    await o.agent.mcpServers.list()
    await o.agent.mcpServers.create({ name: 'a', endpoint_url: 'https://a.test/mcp', auth_type: 'none' })
    await o.agent.mcpServers.get('c1')
    await o.agent.mcpServers.update('c1', { is_active: false })
    await o.agent.mcpServers.delete('c1')
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
    await o.usage.get()
    await o.mcp.listTools()

    const used = new Set(seen.map((s) => `${s.method} ${new URL(s.url).pathname.replace('/core', '')}`))
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      // A WebSocket route is opened by its own test below, on a real socket.
      if (WEBSOCKET.has(name as RouteName)) continue
      const filled = path.replace('{ref}', 'r1').replace('{id}', name.startsWith('voice.jobs') ? 'j1' : name.startsWith('conv') ? 's1' : 'c1').replace('{sid}', 's1').replace('{server}', 'erp')
      expect(used.has(`${method} ${filled}`), `${name} (${method} ${filled}) was never called`).toBe(true)
    }
  })

  test('nothing that changes the world is retried', () => {
    for (const name of ['voice.calls.place', 'conversations.post_message', 'channels.linkedin_publish', 'agent.turn', 'customers.update', 'voice.jobs.create', 'mcp', 'knowledge.documents.create', 'knowledge.documents.update', 'knowledge.documents.delete', 'knowledge.import_file', 'knowledge.sources.create', 'knowledge.sources.crawl'] as RouteName[]) {
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
    expect(o.last).toEqual({ requestId: 'req_9', rateLimit: { limit: 600, remaining: 12, resetSeconds: 3 }, tokenExpiresAt: '2026-12-01T00:00:00Z', tokenIsPrevious: true, replayed: false })
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

describe('idempotency keys', () => {
  const call = { to: '+8801712345678', purpose: 'reminder', consent_basis: 'customer' }

  test('a call placed with a key is sent again with the same key', async () => {
    const { fetcher, seen } = mock(fail(503, 'UPSTREAM_UNAVAILABLE', 'busy', { 'retry-after': '0' }), ok({ ref: 'r1', status: 'pending' }, { 'idempotent-replayed': 'true' }))
    const o = client(fetcher)
    const res = await o.voice.calls.place(call, { idempotencyKey: 'visit-77' })
    expect(res.ref).toBe('r1')
    expect(seen).toHaveLength(2)
    expect(seen.map((s) => s.headers.get('idempotency-key'))).toEqual(['visit-77', 'visit-77'])
    expect(o.last.replayed).toBe(true)
  })

  test('a repeat that arrives while the first still runs waits and asks again', async () => {
    const { fetcher, seen } = mock(fail(409, 'IDEMPOTENCY_IN_PROGRESS', 'still running', { 'retry-after': '0' }), ok({ session_id: 's', text: 'hi' }))
    const res = await client(fetcher).agent.turn({ message: 'hi' }, { idempotencyKey: 'turn-1' })
    expect(res.text).toBe('hi')
    expect(seen).toHaveLength(2)
  })

  test('a key used with another request is reported, not retried', async () => {
    const { fetcher, seen } = mock(fail(422, 'IDEMPOTENCY_KEY_REUSED', 'used with a different request'))
    const err = await client(fetcher).voice.calls.place(call, { idempotencyKey: 'visit-77' }).catch((e) => e)
    expect(err).toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(seen).toHaveLength(1)
  })

  test('without a key nothing is added and nothing is repeated', async () => {
    const { fetcher, seen } = mock(fail(409, 'IDEMPOTENCY_IN_PROGRESS', 'still running', { 'retry-after': '0' }))
    await client(fetcher).conversations.postMessage('s1', [{ type: 'text', markdown: 'hi' }]).catch(() => {})
    expect(seen).toHaveLength(1)
    expect(seen[0]!.headers.has('idempotency-key')).toBe(false)
  })

  test('every route that takes a key sends it', async () => {
    const { fetcher, seen } = mock(() => ok({}))
    const o = client(fetcher)
    const k = { idempotencyKey: 'k1' }
    await o.knowledge.documents.create({ title: 't', content: 'c' }, k)
    await o.knowledge.importFile(new Uint8Array([1]), { filename: 'a.pdf', ...k })
    await o.knowledge.sources.create({ root_url: 'https://x.test' }, k)
    await o.knowledge.sources.crawl('c1', k)
    await o.agent.turn({ message: 'hi' }, k)
    await o.agent.mcpServers.create({ name: 'a', endpoint_url: 'https://a.test/mcp', auth_type: 'none' }, k)
    await o.voice.calls.place(call, k)
    await o.voice.jobs.create({ kind: 'transcribe', source_url: 'https://x.test/a.mp3' }, k)
    await o.conversations.postMessage('s1', [{ type: 'text', markdown: 'hi' }], k)
    await o.channels.linkedinPublish({ text: 'hi' }, k)
    expect(seen).toHaveLength(IDEMPOTENT.size)
    for (const s of seen) expect(s.headers.get('idempotency-key')).toBe('k1')
  })

  test('an agent turn still takes a bare AbortSignal', async () => {
    const { fetcher, seen } = mock(ok({ session_id: 's', text: 'hi' }))
    await client(fetcher).agent.turn({ message: 'hi' }, new AbortController().signal)
    expect(seen[0]!.headers.has('idempotency-key')).toBe(false)
  })

  test('a voice job names its app in the query, where the route reads it', async () => {
    const { fetcher, seen } = mock(ok({ id: 'j1' }))
    await client(fetcher, { app: 'nordwell' }).voice.jobs.create({ kind: 'transcribe', source_url: 'https://x.test/a.mp3' })
    expect(new URL(seen[0]!.url).searchParams.get('app')).toBe('nordwell')
    expect(JSON.parse(seen[0]!.body)).toEqual({ kind: 'transcribe', source_url: 'https://x.test/a.mp3' })
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

  test('an agent turn streams on the same route and ends with the whole turn', async () => {
    const { fetcher, seen } = mock(sse([bytes('event: delta\ndata: {"text":"Good "}\n\nevent: delta\ndata: {"text":"morning."}\n\nevent: done\ndata: {"session_id":"s1","text":"Good morning.","sources":0,"usage":{"input_tokens":1,"output_tokens":2,"cached_input_tokens":0}}\n\n')]))
    const out: string[] = []
    let turn = { session_id: '', text: '' }
    for await (const ev of client(fetcher).agent.stream({ message: 'hello', context: { interaction: 'voice' } })) {
      if (ev.type === 'delta') out.push(ev.text)
      else turn = ev.result
    }
    expect(out).toEqual(['Good ', 'morning.'])
    expect(turn).toMatchObject({ session_id: 's1', text: 'Good morning.' })
    expect(seen[0]!.url).toEndWith('/agent/turn')
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ stream: true, message: 'hello', context: { interaction: 'voice' } })
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

describe('knowledge documents', () => {
  test('a document is created in the default app and comes back with its index status', async () => {
    const doc = { id: '01A', title: 'Hours', index: { status: 'queued', chunks: 0, tokens: 0, indexed_at: null }, version: 0 }
    const { fetcher, seen } = mock(ok(doc))
    const out = await client(fetcher, { app: 'desk' }).knowledge.documents.create({ title: 'Hours', content: '9 to 5' })
    expect(out.index.status).toBe('queued')
    expect(seen[0]!.method).toBe('POST')
    expect(new URL(seen[0]!.url).pathname).toBe('/core/knowledge/documents')
    expect(JSON.parse(seen[0]!.body)).toEqual({ title: 'Hours', content: '9 to 5', app: 'desk' })
  })

  test('a file is sent as the raw body with its name and type', async () => {
    const { fetcher, seen } = mock(ok({ id: '01F' }))
    await client(fetcher).knowledge.importFile(new Uint8Array([37, 80, 68, 70]), { filename: 'hand book.pdf', contentType: 'application/pdf' })
    const url = new URL(seen[0]!.url)
    expect(url.pathname).toBe('/core/knowledge/import')
    expect(url.searchParams.get('filename')).toBe('hand book.pdf')
    expect(seen[0]!.headers.get('content-type')).toBe('application/pdf')
    expect(seen[0]!.body).toBe('<binary>')
  })

  test('an export sends since even when it is 0, and the cursor of the page before', async () => {
    const { fetcher, seen } = mock(ok({ version: 12, documents: [], deleted: [], resync: false, next_cursor: '' }))
    const o = client(fetcher)
    const first = await o.knowledge.export()
    expect(first.version).toBe(12)
    expect(new URL(seen[0]!.url).search).toBe('')
    await o.knowledge.export({ since: 0, cursor: '12.4.01A', limit: 20 })
    const q = new URL(seen[1]!.url).searchParams
    expect([q.get('since'), q.get('cursor'), q.get('limit')]).toEqual(['0', '12.4.01A', '20'])
  })

  test('a write that is refused is not sent again', async () => {
    const { fetcher, seen } = mock(fail(503, 'UPSTREAM_UNAVAILABLE', 'try later'))
    await expect(client(fetcher).knowledge.documents.delete('01A')).rejects.toBeInstanceOf(OmazyError)
    expect(seen.length).toBe(1)
  })

  test('a rate-limited read is sent again', async () => {
    const { fetcher, seen } = mock(fail(429, 'RATE_LIMITED', 'slow down', { 'retry-after': '0' }), ok({ documents: [], next_cursor: '', version: 3 }))
    const page = await client(fetcher).knowledge.documents.list({ limit: 10 })
    expect(page.version).toBe(3)
    expect(seen.length).toBe(2)
  })
})

// The contract sits beside the SDKs: two levels up in the public repository,
// three in the platform's own.
describe('agent settings', () => {
  const settings = {
    app_id: 'a1',
    app: 'acme',
    model: { id: 'openai/gpt-4o', source: 'app', overridden: true, inherited_model: 'openai/gpt-4o-mini', max_tokens: 1200, temperature: null },
    models: [{ id: 'openai/gpt-4o', label: 'GPT-4o', vendor: 'openai', tier: 'premium', tools: true, source: 'managed' }],
    loop: { harness: true, stream: true, redact: false, overrides: { harness: true } },
  }

  test('get reads the settings of the default app', async () => {
    const { fetcher, seen } = mock(ok(settings))
    const got = await client(fetcher, { app: 'acme' }).agent.settings.get()
    expect(got.model.id).toBe('openai/gpt-4o')
    expect(got.model.temperature).toBeNull()
    expect(got.loop.overrides).toEqual({ harness: true })
    expect(seen[0]!.method).toBe('GET')
    expect(seen[0]!.url).toBe('https://api.test/core/agent/settings?app=acme')
  })

  test('update sends null as null and leaves out what was not named', async () => {
    const { fetcher, seen } = mock(ok(settings))
    const o = client(fetcher)
    await o.agent.settings.update({ model: 'openai/gpt-4o', max_tokens: null, loop: { stream: false, redact: null } })
    expect(seen[0]!.method).toBe('PATCH')
    expect(seen[0]!.url).toBe('https://api.test/core/agent/settings')
    // null means "back to what the agent inherits"; a missing key means "leave it".
    expect(seen[0]!.body).toBe('{"model":"openai/gpt-4o","max_tokens":null,"loop":{"stream":false,"redact":null}}')
    await o.agent.settings.update({ model: null })
    expect(seen[1]!.body).toBe('{"model":null}')
    await client(fetcher, { app: 'acme' }).agent.settings.update({ temperature: 0 })
    expect(JSON.parse(seen[2]!.body)).toEqual({ temperature: 0, app: 'acme' })
  })

  test('a change is sent again after a gateway error, because the same change leaves the same settings', async () => {
    const { fetcher, seen } = mock(fail(503, 'UPSTREAM_UNAVAILABLE', 'try again'), ok(settings))
    await client(fetcher).agent.settings.update({ loop: { harness: true } })
    expect(seen.length).toBe(2)
    expect(seen[1]!.body).toBe(seen[0]!.body)
  })

  test('a model that cannot be set is an error with its code, and is not retried', async () => {
    for (const [status, code] of [[403, 'MODEL_NOT_AVAILABLE'], [422, 'MODEL_NOT_SERVING']] as const) {
      const { fetcher, seen } = mock(fail(status, code, 'no'))
      const err = (await client(fetcher).agent.settings.update({ model: 'openai/o3' }).catch((e) => e)) as OmazyError
      expect(err).toBeInstanceOf(OmazyError)
      expect(err.code).toBe(code)
      expect(seen.length).toBe(1)
    }
  })
})

describe('the agent\'s MCP servers', () => {
  const server = {
    id: 's1',
    name: 'front-desk',
    endpoint_url: 'https://tools.test/mcp',
    auth_type: 'bearer',
    allowed_tools: [],
    is_active: true,
    write_mode: 'confirm',
    action_policy: {},
    has_credentials: true,
  }

  test('create sends the credential once and reads none back', async () => {
    const { fetcher, seen } = mock(ok(server))
    const made = await client(fetcher, { app: 'acme' }).agent.mcpServers.create(
      { name: 'front-desk', endpoint_url: 'https://tools.test/mcp', auth_type: 'bearer', credentials: 's3cret', allowed_tools: ['lookup'] },
      { idempotencyKey: 'tenant-42-front-desk' },
    )
    expect(made.has_credentials).toBe(true)
    expect('credentials' in made).toBe(false)
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.url).toBe('https://api.test/core/agent/mcp-servers')
    expect(seen[0]!.headers.get('idempotency-key')).toBe('tenant-42-front-desk')
    expect(JSON.parse(seen[0]!.body)).toEqual({
      name: 'front-desk',
      endpoint_url: 'https://tools.test/mcp',
      auth_type: 'bearer',
      credentials: 's3cret',
      allowed_tools: ['lookup'],
      app: 'acme',
    })
  })

  test('a create is sent again only with a key', async () => {
    const bare = mock(fail(503, 'UPSTREAM_UNAVAILABLE', 'try again'), ok(server))
    const err = await client(bare.fetcher).agent.mcpServers.create({ name: 'a', endpoint_url: 'https://a.test/mcp', auth_type: 'none' }).catch((e) => e)
    expect(err).toBeInstanceOf(OmazyError)
    expect(bare.seen.length).toBe(1)

    const keyed = mock(fail(503, 'UPSTREAM_UNAVAILABLE', 'try again'), ok(server))
    await client(keyed.fetcher).agent.mcpServers.create({ name: 'a', endpoint_url: 'https://a.test/mcp', auth_type: 'none' }, { idempotencyKey: 'k1' })
    expect(keyed.seen.length).toBe(2)
    expect(keyed.seen[1]!.headers.get('idempotency-key')).toBe('k1')
  })

  test('list, get and delete name the app in the query', async () => {
    const { fetcher, seen } = mock(new Response(JSON.stringify({ success: true, data: [server] })), ok(server), ok({ id: 's1', deleted: true }))
    const o = client(fetcher, { app: 'acme' })
    expect((await o.agent.mcpServers.list())[0]!.name).toBe('front-desk')
    await o.agent.mcpServers.get('s 1')
    expect((await o.agent.mcpServers.delete('s1')).deleted).toBe(true)
    expect(seen[0]!.url).toBe('https://api.test/core/agent/mcp-servers?app=acme')
    expect(seen[1]!.url).toBe('https://api.test/core/agent/mcp-servers/s%201?app=acme')
    expect(seen[2]!.method).toBe('DELETE')
    expect(seen[2]!.url).toBe('https://api.test/core/agent/mcp-servers/s1?app=acme')
  })

  test('update sends only what changes; an empty credential and an empty list are values', async () => {
    const { fetcher, seen } = mock(ok(server))
    await client(fetcher).agent.mcpServers.update('s1', { credentials: '', allowed_tools: [], is_active: false })
    expect(seen[0]!.method).toBe('PATCH')
    expect(seen[0]!.body).toBe('{"credentials":"","allowed_tools":[],"is_active":false}')
  })

  test('a change is sent again after a gateway error; a removal is not', async () => {
    const changed = mock(fail(503, 'UPSTREAM_UNAVAILABLE', 'try again'), ok(server))
    await client(changed.fetcher).agent.mcpServers.update('s1', { is_active: true })
    expect(changed.seen.length).toBe(2)

    // A second delete would answer 404 for a server the first one removed.
    const removed = mock(fail(503, 'UPSTREAM_UNAVAILABLE', 'try again'), ok({ id: 's1', deleted: true }))
    const err = await client(removed.fetcher).agent.mcpServers.delete('s1').catch((e) => e)
    expect(err).toBeInstanceOf(OmazyError)
    expect(removed.seen.length).toBe(1)
  })

  test('a name the app already uses is a conflict to branch on', async () => {
    const { fetcher } = mock(fail(409, 'CONFLICT', 'this app already has an MCP server named "front-desk"'))
    const err = (await client(fetcher).agent.mcpServers.create({ name: 'front-desk', endpoint_url: 'https://a.test/mcp', auth_type: 'none' }).catch((e) => e)) as OmazyError
    expect(err.status).toBe(409)
    expect(err.code).toBe('CONFLICT')
  })
})

describe('enterprise', () => {
  const account = (fetcher: typeof fetch, extra = {}) =>
    new OmazyEnterprise({ token: 'eak_abc.def', baseUrl: 'https://api.test/api/v1/enterprise', fetch: fetcher, ...extra })
  const workspace = { id: 'w1', external_id: 'cust-1', handle: 'acme', name: 'Acme', status: 'active', plan: 'enterprise_sovereign' }
  const contract = JSON.parse(readFileSync(contractPath('enterprise-api.routes.json'), 'utf8')) as {
    routes: { method: string; path: string; sdk: string; repeatable: boolean }[]
  }

  test('the route table and the repeatable set are the contract', () => {
    const want = Object.fromEntries(contract.routes.map((r) => [r.sdk, [r.method, r.path]]))
    expect(ENTERPRISE_ROUTES as Record<string, readonly [string, string]>).toEqual(want)
    expect([...ENTERPRISE_REPEATABLE].sort()).toEqual(contract.routes.filter((r) => r.repeatable).map((r) => r.sdk).sort())
  })

  test('every route is reachable through a client method', async () => {
    const { fetcher, seen } = mock(() => ok({ workspaces: [] }))
    const a = account(fetcher)
    await a.account()
    await a.workspaces.list()
    await a.workspaces.create({ external_id: 'cust-1', name: 'Acme' })
    await a.workspaces.get('w1')
    await a.workspaces.update('w1', { name: 'Acme Ltd' })
    await a.workspaces.close('w1')
    await a.workspaces.rotateInstall('w1')
    await a.usage()
    const called = new Set(seen.map((s) => `${s.method} ${new URL(s.url).pathname.replace('/api/v1/enterprise', '').replace('/w1', '/{id}')}`))
    for (const r of contract.routes) expect(called.has(`${r.method} ${r.path}`)).toBe(true)
  })

  test('requests carry the account key and the body', async () => {
    const { fetcher, seen } = mock(ok({ created: true, workspace, install: null, token: 'cai_x.y' }, { 'x-request-id': 'req_1', 'x-omazy-token-expires-at': '2027-01-01T00:00:00Z' }))
    const a = account(fetcher)
    const res = await a.workspaces.create({ external_id: 'cust-1', name: 'Acme', brand_color: '#0A3D62' })
    expect(res.created).toBe(true)
    expect(res.token).toBe('cai_x.y')
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.url).toBe('https://api.test/api/v1/enterprise/workspaces')
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer eak_abc.def')
    expect(JSON.parse(seen[0]!.body)).toEqual({ external_id: 'cust-1', name: 'Acme', brand_color: '#0A3D62' })
    expect(a.last.requestId).toBe('req_1')
    expect(a.last.tokenExpiresAt).toBe('2027-01-01T00:00:00Z')
  })

  test('creating a workspace is sent again after a dropped connection; rotating a token is not', async () => {
    const created = mock(new TypeError('socket hang up'), fail(503, 'UPSTREAM_UNAVAILABLE', 'try again'), ok({ created: false, workspace, install: null, token: null }))
    const res = await account(created.fetcher).workspaces.create({ external_id: 'cust-1', name: 'Acme' })
    expect(res.created).toBe(false)
    expect(created.seen.length).toBe(3)
    // The repeat is the same request: the customer's id is what makes it safe.
    expect(created.seen[2]!.body).toBe(created.seen[0]!.body)

    const rotated = mock(fail(503, 'UPSTREAM_UNAVAILABLE', 'try again'), ok({ install: {}, token: 'cai_n.new' }))
    const err = await account(rotated.fetcher).workspaces.rotateInstall('w1').catch((e) => e)
    expect(err).toBeInstanceOf(OmazyError)
    expect(rotated.seen.length).toBe(1)
  })

  test('list reads the page and its cursor, and all() walks every page', async () => {
    const page = (ids: string[], next?: string) =>
      new Response(JSON.stringify({ success: true, data: ids.map((id) => ({ ...workspace, id })), ...(next ? { meta: { next_cursor: next } } : {}) }))
    const { fetcher, seen } = mock(page(['w3', 'w2'], 'c1'), page(['w1']))
    const got: string[] = []
    for await (const w of account(fetcher).workspaces.all({ status: 'active', limit: 2 })) got.push(w.id)
    expect(got).toEqual(['w3', 'w2', 'w1'])
    expect(new URL(seen[0]!.url).searchParams.get('status')).toBe('active')
    expect(new URL(seen[0]!.url).searchParams.get('limit')).toBe('2')
    expect(new URL(seen[0]!.url).searchParams.has('cursor')).toBe(false)
    expect(new URL(seen[1]!.url).searchParams.get('cursor')).toBe('c1')
  })

  test('findByExternalId returns the workspace or null', async () => {
    const found = mock(new Response(JSON.stringify({ success: true, data: [workspace] })))
    expect((await account(found.fetcher).workspaces.findByExternalId('cust-1'))?.id).toBe('w1')
    expect(new URL(found.seen[0]!.url).searchParams.get('external_id')).toBe('cust-1')
    const none = mock(new Response(JSON.stringify({ success: true, data: [] })))
    expect(await account(none.fetcher).workspaces.findByExternalId('nobody')).toBeNull()
  })

  test('suspend, resume and rotate send what the API reads', async () => {
    const { fetcher, seen } = mock(() => ok(workspace))
    const a = account(fetcher)
    await a.workspaces.suspend('w 1')
    await a.workspaces.resume('w1')
    await a.workspaces.rotateInstall('w1', { overlap_hours: 0, expires_in_days: 90 })
    expect(seen[0]!.method).toBe('PATCH')
    expect(seen[0]!.url).toBe('https://api.test/api/v1/enterprise/workspaces/w%201')
    expect(JSON.parse(seen[0]!.body)).toEqual({ status: 'suspended' })
    expect(JSON.parse(seen[1]!.body)).toEqual({ status: 'active' })
    expect(seen[2]!.url).toBe('https://api.test/api/v1/enterprise/workspaces/w1/install/rotate')
    expect(JSON.parse(seen[2]!.body)).toEqual({ overlap_hours: 0, expires_in_days: 90 })
  })

  test('a refusal is an OmazyError with the code a product branches on', async () => {
    const { fetcher } = mock(fail(409, 'WORKSPACE_LIMIT_REACHED', 'the account has reached its limit of managed workspaces', { 'x-request-id': 'req_9' }))
    const err = (await account(fetcher).workspaces.create({ external_id: 'c', name: 'n' }).catch((e) => e)) as OmazyError
    expect(err).toBeInstanceOf(OmazyError)
    expect(err.status).toBe(409)
    expect(err.code).toBe('WORKSPACE_LIMIT_REACHED')
    expect(err.requestId).toBe('req_9')
  })

  test('core() gives a Core client for one customer on the same deployment', async () => {
    const { fetcher, seen } = mock(() => ok({ workspace_id: 'w1' }))
    const a = account(fetcher)
    await a.core('cai_tenant.secret').whoami()
    expect(seen[0]!.url).toBe('https://api.test/api/v1/core/whoami')
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer cai_tenant.secret')
    // The account key is never sent to the Core API.
    expect(seen.every((s) => !s.headers.get('authorization')!.includes('eak_'))).toBe(true)
    await a.core('cai_tenant.secret', { app: 'desk' }).knowledge.search('hours')
    expect(JSON.parse(seen[1]!.body).app).toBe('desk')
  })

  test('a key is required', () => {
    expect(() => new OmazyEnterprise({ token: '' })).toThrow('token is required')
  })
})

function contractPath(file = 'core-api.routes.json'): URL {
  for (const rel of [`../../contracts/${file}`, `../../../contracts/${file}`]) {
    const url = new URL(rel, import.meta.url)
    if (existsSync(url)) return url
  }
  throw new Error(`contracts/${file} not found`)
}

describe('usage', () => {
  const day = { model_calls: 2, cache_hits: 1, errors: 0, input_tokens: 10, output_tokens: 2, cached_input_tokens: 4, speech_sessions: 0, speech_seconds: 0, cost_micros: 1500, cost_usd: 0.0015, estimated_cost_micros: 0, unpriced_calls: 0, conversations: 1, ai_turns: 2, api_calls: 3, voice_minutes: 0 }
  const report = { workspace_id: 'w1', from: '2026-11-22', to: '2026-11-22', totals: day, days: [{ date: '2026-11-22', ...day }] }

  test('get sends the range and reads the report', async () => {
    const { fetcher, seen } = mock(ok(report))
    const got = await client(fetcher).usage.get({ from: '2026-11-22', to: '2026-11-22' })
    expect(got.days[0]!.cache_hits).toBe(1)
    expect(got.totals.cost_micros).toBe(1500)
    expect(seen[0]!.method).toBe('GET')
    expect(seen[0]!.url).toBe('https://api.test/core/usage?from=2026-11-22&to=2026-11-22')
    await client(fetcher).usage.get()
    expect(seen[1]!.url).toBe('https://api.test/core/usage')
  })
})

describe('account usage', () => {
  test('usage sends the range and the page and keeps the cursor', async () => {
    const totals = { model_calls: 9, cost_micros: 9000 }
    const { fetcher, seen } = mock(() =>
      new Response(JSON.stringify({ success: true, data: { from: '2026-11-21', to: '2026-11-23', totals, workspaces: [] }, meta: { next_cursor: 'c2' } })),
    )
    const a = new OmazyEnterprise({ token: 'eak_abc.def', baseUrl: 'https://api.test/api/v1/enterprise', fetch: fetcher })
    const got = await a.usage({ from: '2026-11-21', to: '2026-11-23', limit: 2 })
    expect(got.totals.model_calls).toBe(9)
    expect(got.next_cursor).toBe('c2')
    expect(seen[0]!.url).toBe('https://api.test/api/v1/enterprise/usage?from=2026-11-21&to=2026-11-23&limit=2')
  })
})

describe('live transcription', () => {
  type Seen = { auth: string | null; app: string | null; start?: any; audio: number[]; texts: any[] }

  /** A WebSocket server that plays the Core API's side of the stream. */
  function serve(script: (ws: any, msg: any, seen: Seen) => void) {
    const seen: Seen = { auth: null, app: null, audio: [], texts: [] }
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url)
        if (url.pathname !== '/core/voice/transcribe/stream') return new Response('no', { status: 404 })
        seen.auth = req.headers.get('authorization')
        seen.app = url.searchParams.get('app')
        if (seen.auth !== 'Bearer cai_abc.def') {
          return new Response(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'bad token' } }), { status: 401 })
        }
        return srv.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          if (typeof raw !== 'string') {
            seen.audio.push((raw as Uint8Array).byteLength)
            ws.send(JSON.stringify({ type: 'partial', text: 'hel', language: 'en' }))
            return
          }
          const msg = JSON.parse(raw)
          seen.texts.push(msg)
          if (msg.type === 'start') {
            seen.start = msg
            ws.send(JSON.stringify({ type: 'ready', request_id: 'req_1' }))
            return
          }
          script(ws, msg, seen)
        },
      },
    })
    return { seen, base: `http://127.0.0.1:${server.port}/core`, stop: () => server.stop(true) }
  }

  const ws = (url: string, headers: Record<string, string>) => new WebSocket(url, { headers } as any) as any

  test('opens with the token and app, sends the start frame, audio as binary, commit and end', async () => {
    const srv = serve((sock, msg) => {
      if (msg.type === 'commit') sock.send(JSON.stringify({ type: 'final', text: 'Rashed Karim', language: 'en', committed: true }))
      if (msg.type === 'end') {
        sock.send(JSON.stringify({ type: 'done', text: 'Rashed Karim', language: 'en', audio_ms: 1200, request_id: 'req_1' }))
        sock.close(1000, 'done')
      }
    })
    try {
      const events: TranscriptionEvent[] = []
      const o = new Omazy({ token: 'cai_abc.def', baseUrl: srv.base, app: 'kiosk', webSocket: ws })
      const s = await o.voice.transcribeStream({ language: 'bn', terms: ['Rashed Karim'], audioFormat: 'pcm_s16le', sampleRate: 16000, onEvent: (e) => events.push(e) })
      s.send(new Uint8Array(640))
      s.send(new Uint8Array(320))
      const fin = await s.commit()
      expect(fin).toMatchObject({ type: 'final', text: 'Rashed Karim', committed: true })
      s.keepalive()
      const done = await s.end()
      expect(done).toMatchObject({ text: 'Rashed Karim', language: 'en', audio_ms: 1200 })
      expect(srv.seen.auth).toBe('Bearer cai_abc.def')
      expect(srv.seen.app).toBe('kiosk')
      expect(srv.seen.start).toEqual({ type: 'start', language: 'bn', terms: ['Rashed Karim'], audio_format: 'pcm_s16le', sample_rate: 16000 })
      expect(srv.seen.audio).toEqual([640, 320])
      expect(srv.seen.texts.map((t) => t.type)).toEqual(['start', 'commit', 'keepalive', 'end'])
      expect(events.map((e) => e.type)).toEqual(['ready', 'partial', 'partial', 'final', 'done'])
      expect(s.requestId).toBe('req_1')
      const seenTypes: string[] = []
      for await (const e of s.events()) seenTypes.push(e.type)
      expect(seenTypes).toEqual(['ready', 'partial', 'partial', 'final', 'done'])
    } finally {
      srv.stop()
    }
  })

  test('an error frame becomes an OmazyError on the waiting call', async () => {
    const srv = serve((sock, msg) => {
      if (msg.type === 'end') {
        sock.send(JSON.stringify({ type: 'error', code: 'UPSTREAM_UNAVAILABLE', message: 'speech recognition stopped', request_id: 'req_9' }))
        sock.close(1011, 'speech recognition stopped')
      }
    })
    try {
      const o = new Omazy({ token: 'cai_abc.def', baseUrl: srv.base, webSocket: ws })
      const s = await o.voice.transcribeStream()
      const err = (await s.end().catch((e) => e)) as OmazyError
      expect(err).toBeInstanceOf(OmazyError)
      expect(err.code).toBe('UPSTREAM_UNAVAILABLE')
      expect(err.requestId).toBe('req_9')
      expect(srv.seen.start).toEqual({ type: 'start' })
    } finally {
      srv.stop()
    }
  })

  test('the default factory sends the token on the upgrade', async () => {
    const srv = serve((sock, msg) => {
      if (msg.type === 'end') sock.send(JSON.stringify({ type: 'done', text: '', language: '', audio_ms: 0 }))
    })
    try {
      const o = new Omazy({ token: 'cai_abc.def', baseUrl: srv.base })
      const s = await o.voice.transcribeStream({ audioFormat: 'auto' })
      expect((await s.end()).audio_ms).toBe(0)
      expect(srv.seen.auth).toBe('Bearer cai_abc.def')
      const bad = new Omazy({ token: 'cai_abc.bad', baseUrl: srv.base })
      expect(await bad.voice.transcribeStream().catch((e) => e)).toBeInstanceOf(OmazyError)
    } finally {
      srv.stop()
    }
  })

  test('transcribe sends terms as one comma-separated parameter', async () => {
    const { fetcher, seen } = mock(ok({ text: 'hi', language: 'en' }))
    await client(fetcher).voice.transcribe(new Uint8Array([1]), { lang: 'en', terms: ['Rashed Karim', 'Joya'] })
    expect(new URL(seen[0]!.url).searchParams.get('terms')).toBe('Rashed Karim,Joya')
  })
})
