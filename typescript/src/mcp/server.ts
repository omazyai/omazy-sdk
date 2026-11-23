// An MCP server for one door, driven by the capabilities registry and the
// guard, on the official MCP TypeScript SDK v2. Spec revision 2026-07-28
// (no sessions, no handshake, `server/discover`, `input_required`) through the
// SDK's per-request handler; 2025-11-25, 2025-06-18 and 2025-03-26 clients are
// served statelessly, each request by a fresh server, answered as one JSON
// body, and 2024-11-05 clients the same way as 2025-03-26. Nothing is held
// between requests, so it runs on a Worker with no Durable Object.

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  type InputRequiredResult,
  inputRequired,
  isLegacyRequest,
  type McpHttpHandler,
  type McpRequestContext,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type ServerContext,
  type ServerEventBus,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker'
import type { AnyCapability, BaseCtx, Principal, Seat } from '../capabilities/capability.js'
import type { Registry } from '../capabilities/registry.js'
import { needsConfirm, type Tier, tierRank } from '../capabilities/tiers.js'
import { REQUEST_ID_HEADER, requestIdFrom } from '../guard/trace.js'
import type { ClientInfo, Guard, GuardOutcome, Outcome } from '../guard/types.js'
import {
  CONFIRM_ARGUMENT,
  CONFIRM_META_KEY,
  confirmResult,
  declinedResult,
  errorResult,
  GENERIC_ERROR,
  okResult,
  pendingResult,
  refusalResult,
  type ToolResult,
} from './outcomes.js'

/** The revisions a door serves, newest first. 2026-07-28 through `server/discover`, the rest through `initialize`. */
export const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const

/** Served like 2025-03-26 unless `accept2024: false`. */
export const MCP_VERSION_2024 = '2024-11-05'

/** Revisions that may send JSON-RPC batches. Later ones removed them. */
const BATCH_VERSIONS = new Set(['2025-03-26', MCP_VERSION_2024])

/** Who a bearer token is, as the product's `resolveSeat` finds it. */
export interface SeatGrant {
  principal: Principal
  /** `seat.door` must be this door, or the token is refused here. */
  seat: Seat
  /** The highest tier this token may see and call, such as R2 for a personal key. */
  maxTier?: Tier
  /** An allow list of tool names, for a service key. */
  tools?: readonly string[]
  /**
   * `upstream`: this seat confirms every change with the person before it
   * calls, as Omazy's agent does with `write_mode: 'confirm'`. Its R2 calls
   * run in one step (the guard still mints, checks and logs the confirm), and
   * its tools carry no `confirm_token` argument. R3 and above still wait for
   * an approval. Give it only to a caller you know confirms.
   */
  confirm?: 'upstream'
}

export interface McpResourceDef<C extends BaseCtx = BaseCtx> {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  /** Text, or `{ blob }` with base64 for binary content. */
  read: (ctx: C) => string | { text: string } | { blob: string } | Promise<string | { text: string } | { blob: string }>
}

export interface McpPromptDef<C extends BaseCtx = BaseCtx> {
  name: string
  title?: string
  description?: string
  arguments?: { name: string; description?: string; required?: boolean }[]
  /** One user message as text, or the messages. */
  get: (
    args: Record<string, string>,
    ctx: C,
  ) => string | { role: 'user' | 'assistant'; content: { type: 'text'; text: string } }[] | Promise<string | { role: 'user' | 'assistant'; content: { type: 'text'; text: string } }[]>
}

/** What the alert hook receives when a call fails in a way the model must not see. */
export interface McpFailure {
  door: string
  requestId: string
  method: string
  tool?: string
  error: unknown
}

export interface McpServerOptions<C extends BaseCtx, A extends string> {
  registry: Registry<C, any, A>
  guard: Guard<C>
  /** The audience this server serves. Only the registry's capabilities for this door are listed or called. */
  door: A
  /** The resource path. Default `/<door>`, such as `/platform`. */
  path?: string
  /**
   * Turns a bearer token into a seat. Return null for a token that is not
   * valid. A seat for another door is refused here with 401 `invalid_token`.
   * OAuth lands in the `oauth` kit; until then this is the product's own key check.
   */
  resolveSeat: (token: string, req: Request) => SeatGrant | null | Promise<SeatGrant | null>
  /** Builds the product's ctx from the base one. Required when the product's ctx has more fields than BaseCtx. */
  ctx?: (base: BaseCtx, grant: SeatGrant, req: Request) => C | Promise<C>
  info: { name: string; version: string; title?: string; description?: string; websiteUrl?: string }
  instructions?: string | ((ctx: C) => string)
  resources?: readonly McpResourceDef<C>[]
  prompts?: readonly McpPromptDef<C>[]
  /** Tools per `tools/list` page. Default 50. */
  pageSize?: number
  /** How long a 2026-07-28 client may cache `tools/list`, in ms. Default 60000. */
  listTtlMs?: number
  /** What a model reads when a call fails inside. Default "That did not work. The team has been told." */
  errorMessage?: string
  /** Alert hook for failures: thrown errors and `error` outcomes. Default: console.error. */
  onError?: (failure: McpFailure) => void
  /** For the 401 challenge: the RFC 9728 metadata URL of this door, once the oauth kit serves one. */
  resourceMetadataUrl?: string
  /** Where `notifyToolsChanged` publishes. Default: in this isolate only. Pass a bus over a Durable Object to reach every isolate. */
  bus?: ServerEventBus
  /** Largest POST body read, in bytes. Default 4 MiB. */
  maxBodyBytes?: number
  /** Answer 2024-11-05 clients, served statelessly like 2025-03-26. Default true. */
  accept2024?: boolean
  /** What a 503 says while the door's switch is off and the switch gives no reason. Default "This door is switched off right now." */
  doorOffMessage?: string
}

export interface McpDoor {
  readonly door: string
  readonly path: string
  /** A Worker-shaped handler. Pass the execution context so the request log runs after the answer. */
  fetch(req: Request, env?: unknown, exec?: { waitUntil(p: Promise<unknown>): void }): Promise<Response>
  /** Sends `notifications/tools/list_changed` to 2026-07-28 clients listening on this isolate (or the bus). */
  notifyToolsChanged(): void
}

// Per-request state rides through the SDK in authInfo.extra, which it passes
// to the factory untouched.
interface Exchange<C> {
  ctx: C
  grant: SeatGrant
  waitUntil?: (p: Promise<unknown>) => void
  country: string | null
  started: number
  doorOff?: string
}
const EXCHANGE = 'ai.omazy/exchange'

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** The default sentence of a 503 while the door's switch is off. */
export const DOOR_OFF_MESSAGE = 'This door is switched off right now.'

/** The JSON-RPC method, for a log row: the 2026-07-28 header, or the body read from a copy. */
async function methodOf(req: Request): Promise<string> {
  return (await requestOf(req)).method
}

/** The method and, for `tools/call`, the tool name: from the 2026-07-28 headers, or the body read from a copy. */
async function requestOf(req: Request): Promise<{ method: string; tool: string | null }> {
  const h = req.headers.get('mcp-method')
  if (h) return { method: h, tool: h === 'tools/call' ? (req.headers.get('mcp-name')?.slice(0, 128) ?? null) : null }
  if (req.method !== 'POST') return { method: req.method, tool: null }
  try {
    const body = (await req.clone().json()) as { method?: unknown; params?: { name?: unknown } } | unknown[]
    if (Array.isArray(body)) return { method: 'batch', tool: null }
    const method = typeof body?.method === 'string' ? body.method.slice(0, 64) : 'unknown'
    const tool = method === 'tools/call' && typeof body?.params?.name === 'string' ? body.params.name.slice(0, 128) : null
    return { method, tool }
  } catch {
    return { method: 'unknown', tool: null }
  }
}

function bearerOf(req: Request): string {
  const h = req.headers.get('authorization') ?? ''
  return /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, '').trim() : ''
}

const encodeCursor = (offset: number) => btoa(`o:${offset}`).replace(/=+$/, '')
function decodeCursor(cursor: unknown, total: number): number {
  if (cursor === undefined || cursor === null) return 0
  let offset = Number.NaN
  try {
    const raw = atob(String(cursor))
    if (raw.startsWith('o:')) offset = Number(raw.slice(2))
  } catch {}
  if (!Number.isInteger(offset) || offset < 0 || offset > total) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid cursor')
  return offset
}

function page<T>(items: readonly T[], cursor: unknown, size: number): { items: T[]; nextCursor?: string } {
  const start = decodeCursor(cursor, items.length)
  const end = start + size
  return { items: items.slice(start, end), ...(end < items.length ? { nextCursor: encodeCursor(end) } : {}) }
}

/**
 * An MCP server for one door. Every `tools/call` goes through `guard.call`;
 * its outcome becomes the tool result.
 *
 *     const platform = mcpServer({ registry: reg, guard, door: 'platform', resolveSeat, info: { name: 'joya-platform', version: '1' } })
 *     export default { fetch: (req, env, exec) => platform.fetch(req, env, exec) }
 */
export function mcpServer<C extends BaseCtx, A extends string>(opts: McpServerOptions<C, A>): McpDoor {
  const door = opts.door as string
  const path = (opts.path ?? `/${door}`).replace(/\/+$/, '') || '/'
  const pageSize = Math.max(1, opts.pageSize ?? 50)
  const generic = opts.errorMessage ?? GENERIC_ERROR
  const alert = opts.onError ?? ((f: McpFailure) => console.error('mcp failure', f.door, f.method, f.tool ?? '', f.requestId, f.error))
  const validator = new CfWorkerJsonSchemaValidator()
  const outputCheck = new Map<string, ReturnType<typeof validator.getValidator>>()
  const resources = opts.resources ?? []
  const prompts = opts.prompts ?? []

  // The tools one seat sees, in registry order.
  const visible = (grant: SeatGrant): AnyCapability[] =>
    opts.registry
      .select({ audience: opts.door, ...(grant.maxTier ? { maxTier: grant.maxTier } : {}), ...(grant.tools ? { names: grant.tools } : {}) })
      .filter((c) => !(grant.maxTier && tierRank(c.risk) > tierRank(grant.maxTier)))

  const toolDef = (c: AnyCapability, grant: SeatGrant) => {
    const [t] = opts.registry.mcpTools(opts.door, { names: [c.name] })
    if (!t) throw new Error(`capability ${c.name} is not on door ${door}`)
    let inputSchema = t.inputSchema
    const props = (inputSchema.properties ?? {}) as Record<string, unknown>
    if (needsConfirm(c.risk) && grant.confirm !== 'upstream' && !(CONFIRM_ARGUMENT in props)) {
      inputSchema = {
        ...inputSchema,
        properties: {
          ...props,
          [CONFIRM_ARGUMENT]: { type: 'string', description: 'Only when a previous call asked for confirmation: the token it gave, after the person agreed.' },
        },
      }
    }
    return { ...t, inputSchema }
  }

  const checkOutput = (c: AnyCapability, value: unknown): boolean => {
    if (!c.outputJson) return true
    let check = outputCheck.get(c.name)
    if (!check) {
      check = validator.getValidator(c.outputJson as never)
      outputCheck.set(c.name, check)
    }
    return check(value).valid
  }

  const fail = (ex: Exchange<C>, method: string, tool: string | undefined, error: unknown): ToolResult => {
    try {
      alert({ door, requestId: ex.ctx.requestId, method, tool, error })
    } catch {}
    return errorResult(`${generic} (ref ${ex.ctx.requestId})`, { outcome: 'error', code: 'internal', status: 'error' })
  }

  async function callTool(server: Server, ex: Exchange<C>, era: 'legacy' | 'modern', params: Record<string, any>, sctx: ServerContext): Promise<ToolResult | InputRequiredResult> {
    const name = typeof params.name === 'string' ? params.name : ''
    const cap = visible(ex.grant).find((c) => c.name === name)
    if (!cap) {
      // The guard never sees this call, so the kit writes its row: outcome
      // `invalid` as the guard gives an unknown tool, and why in the code.
      const onDoor = opts.registry.get(name)?.audiences.includes(opts.door) ?? false
      const errorCode = !onDoor ? 'unknown_tool' : ex.grant.tools && !ex.grant.tools.includes(name) ? 'not_in_allow_list' : 'tier_above_seat'
      try {
        opts.guard.logRequest(
          ex.ctx,
          { method: 'tools/call', tool: name.slice(0, 128) || null, outcome: 'invalid', errorCode, ms: Date.now() - ex.started, country: ex.country, ...clientOf(sctx) },
          ex.waitUntil ? { waitUntil: ex.waitUntil } : {},
        )
      } catch {}
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`)
    }

    let args: Record<string, unknown> = params.arguments && typeof params.arguments === 'object' ? { ...params.arguments } : {}
    let confirmToken: string | undefined
    const inputProps = (cap.inputJson.properties ?? {}) as Record<string, unknown>
    if (CONFIRM_ARGUMENT in args && !(CONFIRM_ARGUMENT in inputProps)) {
      if (typeof args[CONFIRM_ARGUMENT] === 'string' && args[CONFIRM_ARGUMENT]) confirmToken = args[CONFIRM_ARGUMENT] as string
      delete args[CONFIRM_ARGUMENT]
    }
    const metaToken = (params._meta as Record<string, unknown> | undefined)?.[CONFIRM_META_KEY]
    if (!confirmToken && typeof metaToken === 'string' && metaToken) confirmToken = metaToken

    // A 2026-07-28 client answering our confirm elicitation.
    const envelope = sctx.mcpReq.envelope as Record<string, any> | undefined
    const responses = sctx.mcpReq.inputResponses as Record<string, any> | undefined
    if (era === 'modern' && responses && 'confirm' in responses) {
      const r = responses.confirm
      if (!(r?.action === 'accept' && r?.content?.confirm === true)) return declinedResult(cap)
      const state = sctx.mcpReq.requestState()
      if (typeof state !== 'string' || !state) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Missing requestState for the confirmation')
      confirmToken = state
    }

    const { client } = clientOf(sctx)

    let out: GuardOutcome
    try {
      out = await opts.guard.call(ex.ctx, name, args, {
        ...(confirmToken ? { confirmToken } : {}),
        ...(ex.grant.confirm === 'upstream' ? { confirm: 'upstream' as const } : {}),
        ...(ex.waitUntil ? { waitUntil: ex.waitUntil } : {}),
        ...(client ? { client } : {}),
        country: ex.country,
      })
    } catch (e) {
      return fail(ex, 'tools/call', name, e)
    }

    switch (out.outcome) {
      case 'ok': {
        if (!checkOutput(cap, out.result)) return fail(ex, 'tools/call', name, new Error(`${name} returned a result that does not match its output schema`))
        const result = okResult(out.result, out.approvalId, sayOf(ex, cap, out.result))
        return server.projectCallToolResult(result as never, cap.outputJson as never) as ToolResult
      }
      case 'confirm_required': {
        const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as Record<string, any> | undefined
        const elicit = caps?.elicitation
        const canForm = era === 'modern' && !!elicit && (Object.keys(elicit).length === 0 || 'form' in elicit)
        if (!canForm) return confirmResult(cap, name, out)
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `${out.preview.summary} Do you want to go ahead?`,
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean', title: 'Go ahead', description: out.preview.summary } },
                required: ['confirm'],
              },
            }),
          },
          // The guard's token is an HMAC bound to the seat, tool and arguments, so it needs no second seal.
          requestState: out.token,
        })
      }
      case 'pending_approval':
        return pendingResult(cap, out)
      case 'error':
        return fail(ex, 'tools/call', name, new Error(`${out.code}: ${out.message}`))
      default:
        if (out.outcome === 'switched_off' && out.switch && (out.switch.key === 'all' || out.switch.key === `door:${door}`)) ex.doorOff = out.message
        return refusalResult(out, { listIssues: !cap.invalidMessage })
    }
  }

  // The client's name and version, on a 2026-07-28 request.
  function clientOf(sctx: ServerContext): { client?: ClientInfo } {
    const envelope = sctx.mcpReq.envelope as Record<string, any> | undefined
    const info = envelope?.[CLIENT_INFO_META_KEY] as { name?: string; version?: string } | undefined
    return info ? { client: { name: info.name ?? null, version: info.version ?? null } } : {}
  }

  // The capability's own sentence for a result. A `say` that throws must not
  // turn a change that happened into an error, so the JSON text stands in.
  function sayOf(ex: Exchange<C>, cap: AnyCapability, result: unknown): string | undefined {
    if (!cap.say) return undefined
    try {
      const text = cap.say(result, ex.ctx)
      return typeof text === 'string' ? text : undefined
    } catch (e) {
      try {
        alert({ door, requestId: ex.ctx.requestId, method: 'tools/call', tool: cap.name, error: e })
      } catch {}
      return undefined
    }
  }

  const factory = async (rc: McpRequestContext): Promise<Server> => {
    const ex = rc.authInfo?.extra?.[EXCHANGE] as Exchange<C> | undefined
    if (!ex) throw new Error('mcp: request reached the server without a seat')
    const server = new Server(
      { name: opts.info.name, version: opts.info.version, ...(opts.info.title ? { title: opts.info.title } : {}) },
      {
        capabilities: {
          // Only a 2026-07-28 client has a stream to hear the notice on.
          tools: { listChanged: rc.era === 'modern' },
          ...(resources.length ? { resources: {} } : {}),
          ...(prompts.length ? { prompts: {} } : {}),
        },
        ...(opts.instructions ? { instructions: typeof opts.instructions === 'function' ? opts.instructions(ex.ctx) : opts.instructions } : {}),
        jsonSchemaValidator: validator,
        supportedProtocolVersions: rc.era === 'legacy' && accept2024 ? [...MCP_VERSIONS, MCP_VERSION_2024] : [...MCP_VERSIONS],
        cacheHints: { 'tools/list': { ttlMs: opts.listTtlMs ?? 60_000, cacheScope: 'private' } },
      },
    )
    server.setRequestHandler('tools/list', async (req) => {
      const { items, nextCursor } = page(visible(ex.grant), req.params?.cursor, pageSize)
      return { tools: items.map((c) => toolDef(c, ex.grant)) as never, ...(nextCursor ? { nextCursor } : {}) }
    })
    server.setRequestHandler('tools/call', (async (req: { params: Record<string, unknown> }, sctx: ServerContext) =>
      callTool(server, ex, rc.era, req.params, sctx)) as never)
    if (resources.length) {
      server.setRequestHandler('resources/list', async (req) => {
        const { items, nextCursor } = page(resources, req.params?.cursor, pageSize)
        return {
          resources: items.map(({ read: _r, ...r }) => r),
          ...(nextCursor ? { nextCursor } : {}),
        }
      })
      server.setRequestHandler('resources/read', async (req) => {
        const r = resources.find((x) => x.uri === req.params.uri)
        if (!r) throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Unknown resource: ${req.params.uri}`)
        const body = await r.read(ex.ctx)
        const content = typeof body === 'string' ? { text: body } : body
        return { contents: [{ uri: r.uri, ...(r.mimeType ? { mimeType: r.mimeType } : {}), ...content }] as never }
      })
    }
    if (prompts.length) {
      server.setRequestHandler('prompts/list', async (req) => {
        const { items, nextCursor } = page(prompts, req.params?.cursor, pageSize)
        return { prompts: items.map(({ get: _g, ...p }) => p), ...(nextCursor ? { nextCursor } : {}) }
      })
      server.setRequestHandler('prompts/get', async (req) => {
        const p = prompts.find((x) => x.name === req.params.name)
        if (!p) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: ${req.params.name}`)
        const args = (req.params.arguments ?? {}) as Record<string, string>
        for (const a of p.arguments ?? []) {
          if (a.required && !args[a.name]) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Missing argument: ${a.name}`)
        }
        const got = await p.get(args, ex.ctx)
        const messages = typeof got === 'string' ? [{ role: 'user' as const, content: { type: 'text' as const, text: got } }] : got
        return { ...(p.description ? { description: p.description } : {}), messages }
      })
    }
    return server
  }

  const maxBody = opts.maxBodyBytes ?? 4 * 1024 * 1024
  const accept2024 = opts.accept2024 !== false
  const modern: McpHttpHandler = createMcpHandler(factory, {
    legacy: 'reject',
    maxRequestBodySize: maxBody,
    ...(opts.bus ? { bus: opts.bus } : {}),
    onerror: () => {},
  })

  // 2025 and 2024 clients: a fresh server per POST, one JSON body back, no
  // session. This leg is the kit's own, so it is lenient where old clients
  // were: a missing Accept header and a body sent as text/plain or without a
  // content type are served. 2026-07-28 requests never come here.
  async function legacy(req: Request, authInfo: never, body: unknown): Promise<Response> {
    if (req.method !== 'POST') return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } }, 405, { allow: 'POST' })
    const v = req.headers.get('mcp-protocol-version')?.trim()
    if (Array.isArray(body) && v && !BATCH_VERSIONS.has(v)) {
      // Batches were removed after 2025-03-26.
      return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Batches are not allowed on ${v}` } }, 400)
    }
    const bad = badInitialize(body)
    if (bad) return json(bad, 200)
    const headers = new Headers(req.headers)
    const accept = (headers.get('accept') ?? '').toLowerCase()
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) headers.set('accept', 'application/json, text/event-stream')
    // The body already parsed as JSON, whatever the client called it.
    if (!(headers.get('content-type') ?? '').toLowerCase().includes('application/json')) headers.set('content-type', 'application/json')
    if (v === MCP_VERSION_2024 && !accept2024) headers.delete('mcp-protocol-version')
    const forward = new Request(req.url, { method: 'POST', headers })
    const server = await factory({ era: 'legacy', authInfo, requestInfo: forward })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: maxBody })
    await server.connect(transport)
    try {
      return await transport.handleRequest(forward, { authInfo, parsedBody: body })
    } finally {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    }
  }

  function challenge(error: string, description: string): Response {
    const meta = opts.resourceMetadataUrl ? `, resource_metadata="${opts.resourceMetadataUrl}"` : ''
    return json({ error, error_description: description }, 401, { 'www-authenticate': `Bearer error="${error}", error_description="${description}"${meta}` })
  }

  return {
    door,
    path,
    notifyToolsChanged: () => modern.notify.toolsChanged(),
    async fetch(req, _env, exec) {
      const started = Date.now()
      const url = new URL(req.url)
      if ((url.pathname.replace(/\/+$/, '') || '/') !== path) return json({ error: 'not_found' }, 404)

      const requestId = requestIdFrom(req)
      const waitUntil = exec ? (p: Promise<unknown>) => exec.waitUntil(p) : undefined
      const country = ((req as unknown as { cf?: { country?: string } }).cf?.country ?? null) as string | null
      // A refusal before there is a seat goes to the guard's anonymous log, never sampled.
      const refuse = async (errorCode: 'no_token' | 'bad_token' | 'wrong_door', error: string, description: string) => {
        try {
          opts.guard.logAnonymous(
            { door, method: await methodOf(req), requestId, outcome: 'refused_auth', channel: 'mcp', country, errorCode, ms: Date.now() - started },
            waitUntil ? { waitUntil } : {},
          )
        } catch {}
        const res = challenge(error, description)
        res.headers.set(REQUEST_ID_HEADER, requestId)
        return res
      }

      // The door's switch, read on every request before the token: `all` or
      // `door:<door>` off answers 503 for every method, not only tool calls.
      // Switches that cannot be read count as off.
      const switchedOff = async (ctx?: C): Promise<Response | null> => {
        let row: Awaited<ReturnType<Guard<C>['doorSwitch']>>
        let unreadable = false
        try {
          row = await opts.guard.doorSwitch(door, ctx)
        } catch (e) {
          alert({ door, requestId, method: 'switches', error: e })
          row = null
          unreadable = true
        }
        if (!row && !unreadable) return null
        const message = unreadable ? 'The switches could not be read, so nothing ran.' : row?.reason || opts.doorOffMessage || DOOR_OFF_MESSAGE
        const outcome: Outcome = unreadable ? 'error' : 'switched_off'
        const errorCode = unreadable ? 'hook_failed' : 'door_off'
        try {
          const { method, tool } = await requestOf(req)
          const w = waitUntil ? { waitUntil } : {}
          if (ctx) opts.guard.logRequest(ctx, { method, tool, outcome, errorCode, ms: Date.now() - started, country }, w)
          else opts.guard.logAnonymous({ door, method, requestId, outcome, channel: 'mcp', country, errorCode, ms: Date.now() - started }, w)
        } catch {}
        return json({ error: 'door_off', message }, 503, { [REQUEST_ID_HEADER]: requestId })
      }
      const offBefore = await switchedOff()
      if (offBefore) return offBefore

      const token = bearerOf(req)
      if (!token) return refuse('no_token', 'invalid_request', 'A bearer token is required')
      let grant: SeatGrant | null
      try {
        grant = await opts.resolveSeat(token, req)
      } catch (e) {
        alert({ door, requestId, method: 'auth', error: e })
        return json({ error: 'server_error' }, 500, { [REQUEST_ID_HEADER]: requestId })
      }
      if (!grant) return refuse('bad_token', 'invalid_token', 'The token is not valid')
      if (grant.seat.door !== door) return refuse('wrong_door', 'invalid_token', 'The token is for another door')

      const base: BaseCtx = {
        principal: grant.principal,
        seat: grant.seat,
        tenant: grant.seat.tenant,
        channel: 'mcp',
        approvalId: null,
        requestId,
      }
      const ctx = opts.ctx ? await opts.ctx(base, grant, req) : (base as C)
      // Again for this tenant and person, whose own switches may hold the door off.
      const offForSeat = await switchedOff(ctx)
      if (offForSeat) return offForSeat
      const ex: Exchange<C> = { ctx, grant, country, started, ...(waitUntil ? { waitUntil } : {}) }
      const authInfo = { token, clientId: grant.seat.id, scopes: [], extra: { [EXCHANGE]: ex } } as never

      let method = req.headers.get('mcp-method') ?? ''
      let res: Response
      try {
        if (req.method === 'POST' && (await isLegacyRequest(req, undefined, { maxRequestBodySize: maxBody }))) {
          let body: unknown
          try {
            body = await req.json()
          } catch {
            return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
          }
          if (!method) method = Array.isArray(body) ? 'batch' : String((body as { method?: unknown })?.method ?? '')
          res = await legacy(req, authInfo, body)
        } else if (req.method !== 'POST' && !req.headers.get('mcp-protocol-version')?.startsWith('2026')) {
          res = await legacy(req, authInfo, undefined)
        } else {
          res = await modern.fetch(req, { authInfo })
        }
      } catch (e) {
        alert({ door, requestId, method: method || 'unknown', error: e })
        return json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: generic } }, 500)
      }

      if (ex.doorOff) return json({ error: 'door_off', message: ex.doorOff }, 503, { [REQUEST_ID_HEADER]: requestId })
      if (method && method !== 'tools/call' && !method.startsWith('notifications/')) {
        const outcome: Outcome = res.status < 400 ? 'ok' : 'error'
        try {
          opts.guard.logRequest(ctx, { method, outcome, ms: Date.now() - started, country }, waitUntil ? { waitUntil } : {})
        } catch {}
      }
      const headers = new Headers(res.headers)
      headers.set(REQUEST_ID_HEADER, requestId)
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    },
  }
}

/**
 * An `initialize` without the fields the MCP SDK needs gets -32602 with one
 * plain sentence, not the SDK's validation dump.
 */
function badInitialize(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const m = body as { id?: unknown; method?: unknown; params?: unknown }
  if (m.method !== 'initialize' || m.id === undefined) return null
  const p = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>
  const isObj = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)
  const info = p.clientInfo as Record<string, unknown> | undefined
  const missing = [
    typeof p.protocolVersion !== 'string' && 'protocolVersion',
    !isObj(p.capabilities) && 'capabilities',
    !(isObj(info) && typeof info!.name === 'string' && typeof info!.version === 'string') && 'clientInfo',
  ].filter(Boolean) as string[]
  if (!missing.length) return null
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
  return {
    jsonrpc: '2.0',
    id: m.id,
    error: {
      code: -32602,
      message: `initialize needs ${list} in its params: protocolVersion as a string, capabilities as an object ({} for none), clientInfo as { name, version }.`,
    },
  }
}

/**
 * Several doors on one Worker, each at its own path. A request goes to the
 * door whose path it names; anything else is 404.
 */
export function mcpDoors(...doors: McpDoor[]): Pick<McpDoor, 'fetch'> & { doors: readonly McpDoor[] } {
  const byPath = new Map(doors.map((d) => [d.path, d]))
  if (byPath.size !== doors.length) throw new Error('mcpDoors: two doors share a path')
  return {
    doors,
    fetch(req, env, exec) {
      const p = new URL(req.url).pathname.replace(/\/+$/, '') || '/'
      const d = byPath.get(p)
      return d ? d.fetch(req, env, exec) : Promise.resolve(json({ error: 'not_found' }, 404))
    },
  }
}

