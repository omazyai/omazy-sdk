// A fake Omazy Core API, in process. It is a `fetch` the real `Omazy` client
// sends to, so a product's units, actors and copilot run their real code path
// (the client, the run layer, the caps, the tags) with no network. Replies are
// scripted: in order, by a match on the request, or by a function. It records
// every request with its tags, prices each call, and refuses with 402 once a
// budget is spent, the way the platform does.

import { Omazy } from '../index.js'
import type { CompleteRequest, CompleteResult, ToolCall, Usage } from '../types.js'

/** A model's reply, as the fake should give it. */
export interface FakeReply {
  /** The reply text. With `output` and no text, the text is the output as JSON. */
  text?: string
  /**
   * The structured reply. On a request with `response_format` it is the
   * result's `output`; on a request that forces a tool, it is that tool's input.
   */
  output?: unknown
  /** Tool calls the model makes. Ids are filled in when left out. */
  toolCalls?: readonly { name: string; input: unknown; id?: string }[]
  /** Default 10 input and 10 output tokens per call. */
  usage?: Partial<Usage>
  /** The model the platform says answered. Default: the role's model from `models`, else `fake/model`. */
  model?: string
  stopReason?: string
  cacheHit?: boolean
  /** Streamed text is sent in pieces of this many characters. Default 16. */
  chunk?: number
}

/** A refusal or failure, as the platform answers it. */
export interface FakeError {
  error: { status: number; code: string; message?: string; retryAfter?: number }
}

/** Anything the script may give for one request. */
export type FakeAnswer = FakeReply | FakeError

/** What the fake knows of one request when it picks a reply. */
export interface FakeRequest {
  /** The route name, such as `ai.complete` or `whoami`. */
  route: string
  method: string
  path: string
  /** For `ai.complete`: the request as the client sent it. */
  body: CompleteRequest & { stream?: boolean }
  /** The `metadata` tags: `unit`, `unit_version`, `prompt_version`, `run_id` and the product's. */
  tags: Record<string, string>
  /** `role:<name>` turned into the role name, when the model was a role. */
  role: string | undefined
  /** 1 for the first request. */
  n: number
}

/** One request the fake answered, with what it answered. */
export interface FakeCall extends FakeRequest {
  status: number
  result?: CompleteResult
  error?: FakeError['error']
  stream: boolean
}

export type FakeResponder = (req: FakeRequest) => FakeAnswer | Promise<FakeAnswer>

/** US dollars per million tokens. */
export interface FakePrice {
  input: number
  output: number
  cachedInput?: number
}

export interface FakeCoreOptions {
  /** Replies used in order, one per `ai.complete` request that no `on` rule took. */
  script?: readonly (FakeAnswer | FakeResponder)[]
  /** Used once the script runs out. Default: a short text reply, `ok`. */
  fallback?: FakeAnswer | FakeResponder
  /** Role to the model the platform reports for it, such as `{ 'extract.fast': 'openai/gpt-5-mini' }`. */
  models?: Readonly<Record<string, string>>
  /** Rates by model or role, for `cost_micros`. Default: $1 in and $4 out per million tokens. */
  prices?: Readonly<Record<string, FakePrice>>
  /** false: leave `cost_micros` out, as an older platform does, so the kit prices calls itself. Default true. */
  reportCost?: boolean
  /** The account's spend cap in US dollars. Once spent, each call is a 402 `BUDGET_EXCEEDED`. */
  budgetUsd?: number
  /** Calls allowed before a 402 `AI_TURNS_EXCEEDED`. */
  maxCalls?: number
  /**
   * `unsupported`: every request with `response_format` is a 422
   * `MODEL_UNSUPPORTED`, so the kit falls back to a forced tool call.
   */
  structured?: 'supported' | 'unsupported'
  /** What `GET /whoami` answers. */
  whoami?: Record<string, unknown>
  /** The base URL the client is given. Default `https://core.test/api/v1/core`. */
  baseUrl?: string
}

export interface FakeCore {
  /** The fake as a `fetch`, for a client the product builds itself. */
  readonly fetch: typeof fetch
  /** An `Omazy` client on the fake, with retries off. It fits `CoreLike`. */
  readonly client: Omazy
  /** Every request, oldest first. */
  readonly calls: readonly FakeCall[]
  /** The `ai.complete` requests only. */
  completions(): FakeCall[]
  /** Micro dollars charged so far. */
  readonly spentMicros: number
  /** Adds replies to the end of the script. */
  push(...answers: (FakeAnswer | FakeResponder)[]): void
  /** Drops the replies left in the script. Rules and calls stay. */
  clear(): void
  /**
   * A reply for requests this rule matches, ahead of the script. A string
   * matches the `unit` tag.
   *
   * Without `times`, the rule answers every later request it matches, for
   * the rest of the test: a second `on()` for the same unit never fires,
   * because rules are tried in the order they were added and the first one
   * that matches and has answers left wins. To give one turn its reply and
   * the next turn another, pass `{ times: 1 }` to each:
   *
   *     fake.on('booking_intake', reply.json({ items: [first] }), { times: 1 })
   *     fake.on('booking_intake', reply.json({ items: [second] }), { times: 1 })
   *
   * A rule whose `times` are spent stops matching, and the request falls to
   * the next rule, then the script, then `fallback`.
   */
  on(match: string | ((req: FakeRequest) => boolean), answer: FakeAnswer | FakeResponder, opts?: { times?: number }): void
  /** Forgets calls, spend, rules and the script left. */
  reset(): void
}

const DEFAULT_PRICE: FakePrice = { input: 1, output: 4 }
const DEFAULT_WHOAMI = { workspace: { id: 'ws_test', name: 'Test workspace' }, app: { handle: 'test' }, scopes: ['ai:complete'] }

/** Scripted replies and refusals, by name. */
export const reply = {
  text: (text: string, over: Omit<FakeReply, 'text'> = {}): FakeReply => ({ ...over, text }),
  /** A structured reply: the `output` of a `response_format` call, or the input of a forced tool. */
  json: (output: unknown, over: Omit<FakeReply, 'output'> = {}): FakeReply => ({ ...over, output }),
  /** One tool call. */
  tool: (name: string, input: unknown, over: Omit<FakeReply, 'toolCalls'> = {}): FakeReply => ({ ...over, toolCalls: [{ name, input }] }),
  /** Several tool calls in one reply. */
  tools: (calls: readonly { name: string; input: unknown }[], over: Omit<FakeReply, 'toolCalls'> = {}): FakeReply => ({ ...over, toolCalls: calls }),
  /** Any refusal. */
  error: (status: number, code: string, message?: string): FakeError => ({ error: { status, code, message } }),
  /** The platform's spend cap: 402 `BUDGET_EXCEEDED`. */
  cap: (message = 'The workspace AI budget is spent.'): FakeError => ({ error: { status: 402, code: 'BUDGET_EXCEEDED', message } }),
  /** A model that cannot take the request's shape: 422 `MODEL_UNSUPPORTED`. */
  unsupported: (message = 'This model cannot answer with a JSON Schema.'): FakeError => ({ error: { status: 422, code: 'MODEL_UNSUPPORTED', message } }),
  /** A provider failure, which lets a unit try its fallback role. */
  down: (message = 'The provider failed.'): FakeError => ({ error: { status: 502, code: 'PROVIDER_ERROR', message } }),
  rateLimited: (retryAfter = 1): FakeError => ({ error: { status: 429, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.', retryAfter } }),
}

const isError = (a: FakeAnswer): a is FakeError => typeof (a as FakeError).error === 'object' && (a as FakeError).error !== null

function routeOf(method: string, path: string): string {
  if (method === 'POST' && path.endsWith('/ai/complete')) return 'ai.complete'
  if (method === 'GET' && path.endsWith('/whoami')) return 'whoami'
  return `${method} ${path}`
}

const envelope = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', 'x-request-id': `req_fake`, ...headers } })

/**
 * A fake Core API. Give its `client` to `createAi({ omazy: () => fake.client })`
 * and script what the model says.
 *
 *     const fake = fakeCore({ script: [reply.json({ title: 'Hemi', summary: 'A salon.' })] })
 */
export function fakeCore(opts: FakeCoreOptions = {}): FakeCore {
  const calls: FakeCall[] = []
  let script: (FakeAnswer | FakeResponder)[] = [...(opts.script ?? [])]
  let rules: { match: (r: FakeRequest) => boolean; answer: FakeAnswer | FakeResponder; left: number }[] = []
  let spent = 0
  let completions = 0
  const reportCost = opts.reportCost ?? true

  const priceOf = (model: string, role: string | undefined): FakePrice => opts.prices?.[model] ?? (role ? opts.prices?.[role] : undefined) ?? DEFAULT_PRICE

  async function pick(req: FakeRequest): Promise<FakeAnswer> {
    for (const rule of rules) {
      if (rule.left > 0 && rule.match(req)) {
        rule.left--
        return typeof rule.answer === 'function' ? rule.answer(req) : rule.answer
      }
    }
    const next = script.shift() ?? opts.fallback ?? { text: 'ok' }
    return typeof next === 'function' ? next(req) : next
  }

  function build(req: FakeRequest, r: FakeReply): CompleteResult {
    const body = req.body
    const model = r.model ?? (req.role ? opts.models?.[req.role] : undefined) ?? (body.model && !body.model.startsWith('role:') ? body.model : 'fake/model')
    const forced = typeof body.tool_choice === 'object' && body.tool_choice?.type === 'tool' ? body.tool_choice.name : undefined
    let toolCalls: ToolCall[] | undefined = r.toolCalls?.map((t, i) => ({ id: t.id ?? `call_${req.n}_${i + 1}`, name: t.name, input: t.input }))
    let output: unknown
    let text = r.text
    if (r.output !== undefined) {
      if (body.response_format) {
        output = r.output
        text ??= JSON.stringify(r.output)
      } else if (forced && !toolCalls) {
        toolCalls = [{ id: `call_${req.n}_1`, name: forced, input: r.output }]
      } else text ??= JSON.stringify(r.output)
    }
    const u: Usage = { input_tokens: r.usage?.input_tokens ?? 10, output_tokens: r.usage?.output_tokens ?? 10, cached_input_tokens: r.usage?.cached_input_tokens ?? 0 }
    if (r.cacheHit) {
      if (reportCost) u.cost_micros = 0
    } else {
      const p = priceOf(model, req.role)
      const cached = u.cached_input_tokens
      const cost = r.usage?.cost_micros ?? Math.ceil((u.input_tokens - cached) * p.input + cached * (p.cachedInput ?? p.input) + u.output_tokens * p.output)
      spent += cost
      if (reportCost) u.cost_micros = cost
    }
    return {
      text: text ?? '',
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      stop_reason: r.stopReason ?? (toolCalls?.length ? 'tool_use' : 'stop'),
      model,
      usage: u,
      ...(r.cacheHit ? { cache_hit: true } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(req.role ? { role: req.role } : {}),
    }
  }

  function sse(result: CompleteResult, chunk: number): Response {
    const enc = new TextEncoder()
    const frames: string[] = []
    for (let i = 0; i < result.text.length; i += chunk) frames.push(`event: delta\ndata: ${JSON.stringify({ text: result.text.slice(i, i + chunk) })}\n\n`)
    frames.push(`event: done\ndata: ${JSON.stringify(result)}\n\n`)
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f))
        c.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_fake' } })
  }

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const route = routeOf(method, url.pathname)
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined)
    const body = (raw ? JSON.parse(String(raw)) : {}) as FakeRequest['body']
    const tags = Object.fromEntries(Object.entries(body.metadata ?? {}).map(([k, v]) => [k, String(v)]))
    const role = typeof body.model === 'string' && body.model.startsWith('role:') ? body.model.slice(5) : tags.role
    const req: FakeRequest = { route, method, path: url.pathname, body, tags, role, n: calls.length + 1 }
    const stream = body.stream === true

    const fail = (e: FakeError['error']) => {
      calls.push({ ...req, status: e.status, error: e, stream })
      return envelope(e.status, { success: false, error: { code: e.code, message: e.message ?? e.code } }, e.retryAfter !== undefined ? { 'retry-after': String(e.retryAfter) } : {})
    }

    if (route === 'whoami') {
      calls.push({ ...req, status: 200, stream: false })
      return envelope(200, { success: true, data: opts.whoami ?? DEFAULT_WHOAMI })
    }
    if (route !== 'ai.complete') return fail({ status: 404, code: 'NOT_FOUND', message: `the fake Core API does not serve ${route}` })

    if (opts.budgetUsd !== undefined && spent >= opts.budgetUsd * 1_000_000) return fail({ status: 402, code: 'BUDGET_EXCEEDED', message: 'The workspace AI budget is spent.' })
    if (opts.maxCalls !== undefined && completions >= opts.maxCalls) return fail({ status: 402, code: 'AI_TURNS_EXCEEDED', message: 'The plan has no AI turns left.' })
    if (opts.structured === 'unsupported' && body.response_format) return fail({ status: 422, code: 'MODEL_UNSUPPORTED', message: 'This model cannot answer with a JSON Schema.' })

    const answer = await pick(req)
    if (isError(answer)) return fail(answer.error)
    completions++
    const result = build(req, answer)
    calls.push({ ...req, status: 200, result, stream })
    return stream ? sse(result, Math.max(1, answer.chunk ?? 16)) : envelope(200, { success: true, data: result })
  }) as typeof fetch

  const baseUrl = opts.baseUrl ?? 'https://core.test/api/v1/core'
  const client = new Omazy({ token: 'cai_fake.fake', baseUrl, fetch: fetcher, maxRetries: 0 })

  return {
    fetch: fetcher,
    client,
    calls,
    completions: () => calls.filter((c) => c.route === 'ai.complete'),
    get spentMicros() {
      return spent
    },
    push: (...answers) => {
      script.push(...answers)
    },
    clear: () => {
      script = []
    },
    on(match, answer, o = {}) {
      const m = typeof match === 'string' ? (r: FakeRequest) => r.tags.unit === match : match
      rules.push({ match: m, answer, left: o.times ?? Number.POSITIVE_INFINITY })
    },
    reset() {
      calls.length = 0
      script = []
      rules = []
      spent = 0
      completions = 0
    },
  }
}
