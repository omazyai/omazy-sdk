// What a product needs on its own server when Omazy calls it: verifying the
// signature on a flow, tool, context or callback request, the shapes of those
// requests, block builders for a reply, and an MCP tool server an agent can
// call. This replaces the omazy-sdk.ts and mcp.ts files that were copied
// between repositories.
//
// Every request from the platform is signed:
//   X-Omazy-Signature: sha256=<hex hmac-sha256(secret, rawBody)>

export interface Identity {
  email?: string
  verified: boolean
}

export interface FlowRequest<S = Record<string, unknown>> {
  flow: string
  event: 'start' | 'message' | 'verified' | (string & {})
  app_id: string
  session_id: string
  customer_id?: string
  message?: { text: string }
  state?: S | null
  identity: Identity
}

export interface FlowResponse<S = Record<string, unknown>> {
  blocks: Block[]
  state: S | null
  done: boolean
  defer?: boolean
  require_verify?: { email: string }
}

export interface ContextRequest {
  app_id: string
  session_id: string
  customer_id?: string
  identity: Identity
  memory?: Record<string, unknown>
}

export interface ContextResponse {
  context: string
  required?: boolean
  section?: string
}

export type Block =
  | { type: 'text'; markdown: string }
  | { type: 'quick_replies'; options: { label: string; payload: string }[] }
  | { type: 'card'; title: string; subtitle?: string; image_url?: string; buttons?: { kind: 'url'; label: string; url: string }[] }
  | { type: 'kv'; title?: string; caption?: string; status?: string; rows: { label: string; value: string }[] }
  | { type: 'live_tracker'; kind: 'generic'; title: string; steps: { label: string; state: 'done' | 'active' | 'pending' }[] }
  | { type: 'divider'; label?: string }

export const text = (markdown: string): Block => ({ type: 'text', markdown })
export const chips = (...options: [label: string, payload?: string][]): Block => ({
  type: 'quick_replies',
  options: options.map(([label, payload]) => ({ label, payload: payload ?? label })),
})
export const kv = (title: string, rows: [string, string][], extra: { caption?: string; status?: string } = {}): Block => ({
  type: 'kv',
  title,
  ...extra,
  rows: rows.map(([label, value]) => ({ label, value })),
})
export const tracker = (title: string, steps: string[], active: number): Block => ({
  type: 'live_tracker',
  kind: 'generic',
  title,
  steps: steps.map((label, i) => ({ label, state: i < active ? 'done' : i === active ? 'active' : 'pending' })),
})

const enc = new TextEncoder()

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compares two strings without leaking where they differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

/** The signature header value for a body. */
export async function sign(secret: string, body: string): Promise<string> {
  return `sha256=${await hmacHex(secret, body)}`
}

/** True when `header` is the platform's signature over exactly `rawBody`. */
export async function verifySignature(secret: string, rawBody: string, header: string | null | undefined): Promise<boolean> {
  const got = (header ?? '').trim()
  return !!secret && !!got && timingSafeEqual(got, await sign(secret, rawBody))
}

export type Signed<T> = { ok: true; body: T } | { ok: false; status: 401 | 400 | 503 }

/** Verifies the signature over the raw body before parsing it. */
export async function readSigned<T>(req: Request, secret: string | undefined): Promise<Signed<T>> {
  if (!secret) return { ok: false, status: 503 }
  const raw = await req.text()
  if (!(await verifySignature(secret, raw, req.headers.get('x-omazy-signature')))) return { ok: false, status: 401 }
  try {
    return { ok: true, body: JSON.parse(raw) as T }
  } catch {
    return { ok: false, status: 400 }
  }
}

export const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

// ---------------------------------------------------------------------------
// An MCP tool server over Streamable HTTP, stateless, answering every POST
// with one JSON body. No session id: each request stands alone, which is what
// lets it run on a Worker with no affinity. Register it on an app in the
// console and the agent calls its tools.

export interface ToolDef {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface ToolResult {
  text: string
  structured?: Record<string, unknown>
  isError?: boolean
}

export interface Registry<C> {
  info: { name: string; title: string; version: string }
  instructions: (ctx: C) => string
  tools: ToolDef[]
  call: (name: string, args: Record<string, unknown>, ctx: C) => Promise<ToolResult>
}

export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

// Hints the platform reads to decide whether a call needs a confirm card. A
// tool with no annotations is treated as irreversible.
export const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

export interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } }

const err = (id: RpcRequest['id'], code: number, message: string): RpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
})

/** Answers one JSON-RPC message. Returns null for a notification (no id): those get a 202. */
export async function handleMessage<C>(msg: RpcRequest, ctx: C, reg: Registry<C>): Promise<RpcResponse | null> {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Invalid Request')
  if (msg.id === undefined) return null

  switch (msg.method) {
    case 'initialize': {
      const asked = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : ''
      return {
        jsonrpc: '2.0',
        id: msg.id ?? null,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: reg.info,
          instructions: reg.instructions(ctx),
        },
      }
    }
    case 'ping':
      return { jsonrpc: '2.0', id: msg.id ?? null, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id ?? null, result: { tools: reg.tools } }
    case 'tools/call': {
      const name = typeof msg.params?.name === 'string' ? msg.params.name : ''
      if (!reg.tools.some((t) => t.name === name)) return err(msg.id, -32602, `Unknown tool: ${name}`)
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      try {
        const r = await reg.call(name, args, ctx)
        return {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            content: [{ type: 'text', text: r.text }],
            ...(r.structured ? { structuredContent: r.structured } : {}),
            isError: r.isError === true,
          },
        }
      } catch (e) {
        // A tool that throws is a tool error the model can read, not a protocol error.
        return {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: { content: [{ type: 'text', text: `Tool failed: ${(e as Error).message}` }], isError: true },
        }
      }
    }
  }
  return err(msg.id, -32601, `Method not found: ${msg.method}`)
}

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } })

export function bearer(req: Request): string {
  const h = req.headers.get('authorization') ?? ''
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : ''
}

/**
 * The visitor's verified email, as the platform sends it. Believe it only on a
 * request that carried this server's bearer token, which only the platform holds.
 */
export function verifiedEmail(req: Request): string | null {
  const email = (req.headers.get('x-omazy-verified-email') ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

/**
 * The whole HTTP surface of an MCP Worker: /health public, /mcp behind the
 * bearer token the platform was given. `makeCtx` turns the request into the
 * context every tool receives.
 */
export async function serveMcp<C>(
  req: Request,
  token: string | undefined,
  reg: Registry<C>,
  makeCtx: (req: Request) => Promise<C> | C,
): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/'
  if (path === '/health' && req.method === 'GET') return json({ ok: true, server: reg.info.name, version: reg.info.version })
  if (!token) return json({ error: 'server not configured' }, 503)
  const got = bearer(req)
  if (!got || !timingSafeEqual(got, token)) return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' })
  if (path !== '/mcp') return json({ error: 'not found' }, 404)
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }
  const ctx = await makeCtx(req)
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMessage(m as RpcRequest, ctx, reg)))).filter((r) => r !== null)
    return out.length ? json(out) : new Response(null, { status: 202 })
  }
  const res = await handleMessage(body as RpcRequest, ctx, reg)
  return res ? json(res) : new Response(null, { status: 202 })
}
