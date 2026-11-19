import { OmazyError } from './errors.js'
import { McpClient } from './mcp.js'
import { RETRYABLE, ROUTES, type RouteName } from './routes.js'
import { readSse } from './sse.js'
import type {
  AgentTurnRequest,
  AgentTurnResult,
  Block,
  CallRequest,
  CallResult,
  CallStatus,
  CompleteRequest,
  CompleteResult,
  Json,
  KnowledgePassage,
  StreamEvent,
  VoiceJobRequest,
  Whoami,
} from './types.js'

export { OmazyError } from './errors.js'
export { McpClient, type McpTool, type McpToolResult } from './mcp.js'
export { ROUTES, RETRYABLE, type RouteName } from './routes.js'
export { readSse, type SseFrame } from './sse.js'
export type * from './types.js'

export const DEFAULT_BASE_URL = 'https://mw.omazy.ai/api/v1/core'
export const VERSION = '0.1.0'

export interface OmazyOptions {
  /** An install token, `cai_<prefix>.<secret>`. Server side only. */
  token: string
  baseUrl?: string
  /** Default app handle, for a workspace with more than one app. */
  app?: string
  /** Retries after a 429, 502, 503, 504 or a dropped connection, on routes that are safe to repeat. Default 2. */
  maxRetries?: number
  /** Give up on a request after this long. Default 130 s, just above the API's own limit. */
  timeoutMs?: number
  fetch?: typeof fetch
}

/** What the API said about limits and the token on the last response. */
export interface ResponseInfo {
  requestId?: string
  rateLimit?: { limit: number; remaining: number; resetSeconds: number }
  /** Set when the token has a deadline. */
  tokenExpiresAt?: string
  /** True while the caller is still on a token a rotation replaced. */
  tokenIsPrevious: boolean
}

interface CallInit {
  path?: Record<string, string>
  query?: Record<string, string | undefined>
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
  signal?: AbortSignal
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Client for the Omazy Core API: models, knowledge, your agent, speech and
 * calls, with one scoped token and spend recorded against your workspace.
 *
 * ```ts
 * const omazy = new Omazy({ token: process.env.OMAZY_CORE_TOKEN! })
 * const { text } = await omazy.ai.complete({ messages: [{ role: 'user', content: 'Hello' }] })
 * ```
 */
export class Omazy {
  private readonly token: string
  private readonly base: string
  private readonly app?: string
  private readonly maxRetries: number
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch
  /** Headers of the most recent response: request id, rate limit, token deadline. */
  last: ResponseInfo = { tokenIsPrevious: false }

  readonly mcp: McpClient

  constructor(opts: OmazyOptions) {
    if (!opts?.token) throw new Error('Omazy: token is required')
    this.token = opts.token
    this.base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.app = opts.app
    this.maxRetries = opts.maxRetries ?? 2
    this.timeoutMs = opts.timeoutMs ?? 130_000
    this.fetcher = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.mcp = new McpClient(
      async (body) => (await this.send('mcp', { json: body })).json(),
      this.base + ROUTES.mcp[1],
      this.token,
    )
  }

  /** The workspace this token belongs to, its scopes and its deadline. Needs no scope. */
  whoami = () => this.json<Whoami>('whoami')

  readonly ai = {
    /** One model call through the gateway. Needs `ai:complete`. */
    complete: (req: CompleteRequest, signal?: AbortSignal) =>
      this.json<CompleteResult>('ai.complete', { json: this.withApp({ ...req, stream: false }), signal }),

    /**
     * The same call as a stream: `delta` events as text arrives, then one
     * `done` with the full result. Throws OmazyError if the stream reports an
     * error or ends before `done`. A stream is not retried.
     */
    stream: (req: CompleteRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> => this.stream(req, signal),
  }

  readonly knowledge = {
    /** Passages from the agent's knowledge base. Needs `kb:search`. */
    search: async (query: string, opts: { top_k?: number; language?: string; app?: string } = {}) =>
      (await this.json<{ passages: KnowledgePassage[] }>('knowledge.search', { json: this.withApp({ query, ...opts }) }))
        .passages ?? [],
  }

  readonly agent = {
    /** One turn of the workspace's own agent. The caller keeps the conversation. Needs `agent:run`. */
    turn: (req: AgentTurnRequest, signal?: AbortSignal) =>
      this.json<AgentTurnResult>('agent.turn', { json: this.withApp(req), signal }),
  }

  readonly voice = {
    /** Text to speech in the agent's voice. Returns WAV audio. Needs `voice:speech`. */
    speak: async (text: string, opts: { lang?: string; app?: string } = {}) => {
      const res = await this.send('voice.speak', { json: this.withApp({ text, ...opts }) })
      return { audio: await res.arrayBuffer(), language: res.headers.get('x-omazy-speech-lang') ?? '' }
    },
    /** Speech to text. `audio` is the raw recording, at most 8 MB. Needs `voice:speech`. */
    transcribe: (audio: BodyInit, opts: { lang?: string; app?: string; contentType?: string } = {}) =>
      this.json<{ text: string; language: string }>('voice.transcribe', {
        body: audio,
        query: { lang: opts.lang, app: opts.app ?? this.app },
        headers: { 'content-type': opts.contentType ?? 'application/octet-stream' },
      }),
    calls: {
      /** Queue an outbound call answered by the agent. Never retried. Needs `voice:calls`. */
      place: (req: CallRequest) => this.json<CallResult>('voice.calls.place', { json: this.withApp(req) }),
      /** Where a call stands and what the person answered. */
      get: (ref: string, opts: { app?: string } = {}) =>
        this.json<CallStatus>('voice.calls.get', { path: { ref }, query: { app: opts.app ?? this.app } }),
    },
    jobs: {
      /** Transcribe a recording or write notes from one, in the background. Needs `voice:tasks`. */
      create: (req: VoiceJobRequest) => this.json<Json>('voice.jobs.create', { json: this.withApp(req) }),
      get: (id: string, opts: { app?: string } = {}) =>
        this.json<Json>('voice.jobs.get', { path: { id }, query: { app: opts.app ?? this.app } }),
    },
  }

  readonly customers = {
    /** One customer by id. Needs `core:read`. */
    get: (id: string) => this.json<Json>('customers.get', { path: { id } }),
    /** Merge keys into a customer's custom fields. Needs `memory:write`. */
    update: (id: string, customFields: Json) =>
      this.json<{ id: string; custom_fields: Json }>('customers.update', {
        path: { id },
        json: { custom_fields: customFields },
      }),
  }

  readonly conversations = {
    /** Post 1 to 12 blocks into an existing conversation as the app. Never retried. Needs `core:write`. */
    postMessage: (id: string, blocks: Block[]) =>
      this.json<Json>('conversations.post_message', { path: { id }, json: { blocks } }),
  }

  readonly channels = {
    /** Publish a post to the connected LinkedIn page. Never retried. Needs `channels:publish`. */
    linkedinPublish: (req: { text: string; app?: string; [key: string]: unknown }) =>
      this.json<Json>('channels.linkedin_publish', { json: this.withApp(req) }),
  }

  readonly sessions = {
    /** Bind a signed-in user's own tool credential to their chat session. Needs `sessions:credentials`. */
    bindCredential: (sessionId: string, server: string, body: { token: string; expires_at: string; subject: Json }) =>
      this.json<Json>('sessions.bind_credential', { path: { sid: sessionId, server }, json: body }),
    unbindCredential: (sessionId: string, server: string) =>
      this.json<Json>('sessions.unbind_credential', { path: { sid: sessionId, server } }),
  }

  private withApp<T extends object>(req: T): T {
    return this.app && (req as { app?: string }).app === undefined ? { ...req, app: this.app } : req
  }

  private async *stream(req: CompleteRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await this.send(
      'ai.complete',
      { json: this.withApp({ ...req, stream: true }), signal, headers: { accept: 'text/event-stream' } },
      0,
    )
    if (!res.body) throw new OmazyError('the stream had no body', res.status, 'STREAM_ERROR', this.last.requestId)
    for await (const frame of readSse(res.body)) {
      if (frame.event === 'delta') {
        yield { type: 'delta', text: (JSON.parse(frame.data) as { text: string }).text }
      } else if (frame.event === 'done') {
        yield { type: 'done', result: JSON.parse(frame.data) as CompleteResult }
        return
      } else if (frame.event === 'error') {
        const e = JSON.parse(frame.data) as { message?: string; code?: string }
        throw new OmazyError(e.message ?? 'the stream failed', res.status, e.code ?? 'STREAM_ERROR', this.last.requestId)
      }
    }
    throw new OmazyError('the stream ended before it was done', res.status, 'STREAM_ERROR', this.last.requestId)
  }

  /** Sends a request and unwraps `{ success, data }`. */
  private async json<T>(route: RouteName, init: CallInit = {}): Promise<T> {
    const res = await this.send(route, init)
    const body = (await res.json()) as { success?: boolean; data?: T }
    return body.data as T
  }

  /** Sends a request with retries. Resolves with a 2xx response; throws OmazyError otherwise. */
  private async send(route: RouteName, init: CallInit = {}, retries = this.maxRetries): Promise<Response> {
    const [method, template] = ROUTES[route]
    let path = template as string
    for (const [k, v] of Object.entries(init.path ?? {})) path = path.replace(`{${k}}`, encodeURIComponent(v))
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(init.query ?? {})) if (v) q.set(k, v)
    const url = this.base + path + (q.size ? `?${q}` : '')
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'user-agent': `omazy-sdk-typescript/${VERSION}`,
      ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    }
    const body = init.json !== undefined ? JSON.stringify(init.json) : init.body
    const attempts = RETRYABLE.has(route) ? retries : 0

    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs)
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
      let res: Response
      try {
        res = await this.fetcher(url, { method, headers, body, signal })
      } catch (err) {
        if (init.signal?.aborted) throw err
        if (attempt < attempts) {
          await sleep(backoff(attempt))
          continue
        }
        throw new OmazyError(`no response from the Core API: ${(err as Error).message}`, 0, 'NETWORK_ERROR')
      }
      this.last = readInfo(res.headers)
      if (res.ok) return res

      const retryAfter = Number(res.headers.get('retry-after')) || undefined
      const failed = await readError(res)
      const transient = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504
      // A long Retry-After means the window is full; waiting it out here would
      // hide a stalled caller. Hand that decision back.
      if (transient && attempt < attempts && (retryAfter ?? 0) <= 30) {
        await sleep(retryAfter ? retryAfter * 1000 : backoff(attempt))
        continue
      }
      throw new OmazyError(failed.message, res.status, failed.code, this.last.requestId, retryAfter)
    }
  }
}

const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2)

function readInfo(h: Headers): ResponseInfo {
  const limit = h.get('x-ratelimit-limit')
  return {
    requestId: h.get('x-request-id') ?? undefined,
    rateLimit: limit
      ? {
          limit: Number(limit),
          remaining: Number(h.get('x-ratelimit-remaining')),
          resetSeconds: Number(h.get('x-ratelimit-reset')),
        }
      : undefined,
    tokenExpiresAt: h.get('x-omazy-token-expires-at') ?? undefined,
    tokenIsPrevious: h.get('x-omazy-token-use') === 'previous',
  }
}

async function readError(res: Response): Promise<{ code: string; message: string }> {
  const text = await res.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string } | string }
    if (body.error && typeof body.error === 'object') {
      return { code: body.error.code ?? `HTTP_${res.status}`, message: body.error.message ?? res.statusText }
    }
    if (typeof body.error === 'string') return { code: `HTTP_${res.status}`, message: body.error }
  } catch {
    // not JSON
  }
  return { code: `HTTP_${res.status}`, message: text.slice(0, 300) || res.statusText || `HTTP ${res.status}` }
}
