import { OmazyError } from './errors.js'
import { McpClient } from './mcp.js'
import { IDEMPOTENT, RETRYABLE, ROUTES, type RouteName } from './routes.js'
import { defaultWebSocket, openTranscription, type TranscriptionSession, type WebSocketFactory } from './stt.js'
import { readSse } from './sse.js'
import { buildUrl, readInfo, request, type ResponseInfo, type Transport } from './transport.js'
import type {
  AgentSettings,
  AgentSettingsUpdate,
  AgentTurnRequest,
  AgentTurnResult,
  Block,
  Budget,
  BudgetSetRequest,
  CallRequest,
  CallResult,
  CallStatus,
  CompleteRequest,
  CompleteResult,
  EmbedRequest,
  EmbedResult,
  ModelList,
  RoleDeleted,
  RoleList,
  RoleSetRequest,
  RoleView,
  DocumentInput,
  DocumentPage,
  DocumentPatch,
  Json,
  KnowledgeDocument,
  KnowledgeExport,
  KnowledgePassage,
  McpServer,
  McpServerInput,
  McpServerUpdate,
  StreamEvent,
  UsageGrouping,
  UsageRange,
  UsageReport,
  TranscriptionStreamOptions,
  VoiceJobRequest,
  Whoami,
  CoreRouteContract,
} from './types.js'

export { OmazyError } from './errors.js'
export { McpClient, type McpTool, type McpToolResult } from './mcp.js'
export { ROUTES, RETRYABLE, IDEMPOTENT, WEBSOCKET, type RouteName } from './routes.js'
export { TranscriptionSession, ANSWER_TIMEOUT_MS, type AnswerOptions, type SocketLike, type WebSocketFactory } from './stt.js'
export { readSse, type SseFrame } from './sse.js'
export type { ResponseInfo } from './transport.js'
export {
  OmazyEnterprise,
  DEFAULT_ENTERPRISE_BASE_URL,
  ENTERPRISE_ROUTES,
  ENTERPRISE_REPEATABLE,
  type EnterpriseRouteName,
  type OmazyEnterpriseOptions,
} from './enterprise.js'
export type * from './types.js'

export const DEFAULT_BASE_URL = 'https://mw.omazy.ai/api/v1/core'
export const VERSION = '0.5.1'

export interface OmazyOptions {
  /** An install token, `cai_<prefix>.<secret>`. Server side only. */
  token: string
  baseUrl?: string
  /** Default app handle, for a workspace with more than one app. */
  app?: string
  /**
   * Retries after a 429, 502, 503, 504 or a dropped connection, on routes that
   * are safe to repeat and on any request sent with an idempotency key. Default 2.
   */
  maxRetries?: number
  /** Give up on a request after this long. Default 130 s, just above the API's own limit. */
  timeoutMs?: number
  fetch?: typeof fetch
  /**
   * Opens the socket of a live transcription. The default works in a
   * Cloudflare Worker, Node 22 and later, Bun and Deno: each can send the
   * token on the upgrade. Pass one for another runtime or a WebSocket library.
   */
  webSocket?: WebSocketFactory
}

/**
 * For a request that changes something. With a key the platform runs the
 * request once: a repeat with the same key gets the first answer back, so the
 * client retries it like a read. Use a new key for each new request, for
 * example `crypto.randomUUID()`, and the same key when you send one again.
 */
export interface WriteOptions {
  idempotencyKey?: string
}

interface CallInit {
  path?: Record<string, string>
  query?: Record<string, string | undefined>
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
  signal?: AbortSignal
  idempotencyKey?: string
}

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
  private readonly transport: Transport
  private readonly webSocket: WebSocketFactory
  private readonly opts: OmazyOptions
  /** Set on a client made by `withResponse`: hands each response on to its parent. */
  private forward?: (info: ResponseInfo) => void
  /**
   * Headers of the most recent response of this client, whichever call it
   * answered: request id, rate limit, token deadline. When one client serves
   * several requests at once (a Worker, a server), another call's response can
   * replace it between your call and your read. Use `withResponse` for the
   * headers of one call.
   */
  last: ResponseInfo = { tokenIsPrevious: false, replayed: false }

  readonly mcp: McpClient

  constructor(opts: OmazyOptions) {
    if (!opts?.token) throw new Error('Omazy: token is required')
    this.opts = opts
    this.token = opts.token
    this.base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.app = opts.app
    this.maxRetries = opts.maxRetries ?? 2
    this.transport = {
      token: this.token,
      timeoutMs: opts.timeoutMs ?? 130_000,
      fetcher: opts.fetch ?? globalThis.fetch.bind(globalThis),
      userAgent: `omazy-sdk-typescript/${VERSION}`,
      api: 'the Core API',
      onResponse: (info) => {
        this.last = info
        this.forward?.(info)
      },
    }
    this.webSocket = opts.webSocket ?? defaultWebSocket(this.transport.fetcher)
    this.mcp = new McpClient(
      async (body) => (await this.send('mcp', { json: body })).json(),
      this.base + ROUTES.mcp[1],
      this.token,
    )
  }

  /**
   * Runs `fn` with a client of its own and returns what `fn` returned with the
   * headers of the last response that client received. Nothing another call
   * does can change them, so this is the way to read a call's request id or
   * rate limit when one client serves several requests at once. The client
   * shares this one's settings, and `last` here still follows every response.
   *
   * ```ts
   * const { result, response } = await omazy.withResponse((o) => o.ai.complete(req))
   * log(response.requestId, response.rateLimit?.remaining)
   * ```
   */
  async withResponse<T>(fn: (client: Omazy) => Promise<T>): Promise<{ result: T; response: ResponseInfo }> {
    const child = new Omazy({ ...this.opts, webSocket: this.webSocket })
    child.forward = (info) => {
      this.last = info
      this.forward?.(info)
    }
    const result = await fn(child)
    return { result, response: child.last }
  }

  /** The workspace this token belongs to, its scopes and its deadline. Needs no scope. */
  whoami = () => this.json<Whoami>('whoami')

  /**
   * The route contract the live platform was built with, or with
   * `{ format: 'openapi' }` its OpenAPI document. The platform answers it
   * without a token.
   */
  contract = ((opts: { format?: 'routes' | 'openapi' } = {}) =>
    this.json('contract', { query: { format: opts.format } })) as {
    (opts?: { format?: 'routes' }): Promise<CoreRouteContract>
    (opts: { format: 'openapi' }): Promise<Record<string, unknown>>
  }

  readonly ai = {
    /** One model call through the gateway. Needs `ai:complete`. */
    complete: (req: CompleteRequest, signal?: AbortSignal) =>
      this.json<CompleteResult>('ai.complete', { json: this.withApp({ ...req, stream: false }), signal }),

    /**
     * The same call as a stream: `delta` events as text arrives, then one
     * `done` with the full result. Throws OmazyError if the stream reports an
     * error or ends before `done`. A stream is not retried.
     */
    stream: (req: CompleteRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> =>
      this.stream<CompleteResult>('ai.complete', req, signal),

    /**
     * Vectors for one text or up to 128, in the order given, with the
     * deployment's embedding model. Needs `ai:complete`.
     */
    embed: (req: EmbedRequest | string | string[], signal?: AbortSignal) => {
      const body = typeof req === 'string' || Array.isArray(req) ? { input: req } : req
      return this.json<EmbedResult>('ai.embed', { json: this.withApp(body), signal })
    },

    /**
     * The models this install may name, and what each can do: vision, JSON
     * Schema output, tools, context window. Needs `ai:complete`.
     */
    models: (opts: { app?: string } = {}) => this.json<ModelList>('ai.models', { query: { app: opts.app ?? this.app } }),

    /**
     * Model roles. A call names one with `model: 'role:extract.fast'`; these
     * say what each role runs on here and map one for this install or the
     * workspace.
     */
    roles: {
      /** Every role this install can name and what it runs on. Needs `ai:complete`. */
      list: (opts: { app?: string } = {}) => this.json<RoleList>('ai.roles.list', { query: { app: opts.app ?? this.app } }),
      /** Map a role to a model and up to three fallbacks, all on the plan. Needs `ai:configure`. */
      set: (name: string, req: RoleSetRequest) => this.json<RoleView>('ai.roles.set', { path: { name }, json: req }),
      /** Remove the install's (or the workspace's) mapping of a role. Needs `ai:configure`. */
      delete: (name: string, opts: { level?: 'install' | 'workspace' } = {}) =>
        this.json<RoleDeleted>('ai.roles.delete', { path: { name }, query: { level: opts.level } }),
    },
  }

  readonly knowledge = {
    /** Passages from the agent's knowledge base. Needs `kb:search`. */
    search: async (query: string, opts: { top_k?: number; language?: string; app?: string } = {}) =>
      (await this.json<{ passages: KnowledgePassage[] }>('knowledge.search', { json: this.withApp({ query, ...opts }) }))
        .passages ?? [],

    documents: {
      /** One page of the knowledge base, newest first, without content. Needs `kb:read`. */
      list: (opts: { cursor?: string; limit?: number; app?: string } = {}) =>
        this.json<DocumentPage>('knowledge.documents.list', {
          query: { cursor: opts.cursor, limit: opts.limit ? String(opts.limit) : undefined, app: opts.app ?? this.app },
        }),
      /** One document with its content and how its indexing stands. Needs `kb:read`. */
      get: (id: string, opts: { app?: string } = {}) =>
        this.json<KnowledgeDocument>('knowledge.documents.get', { path: { id }, query: { app: opts.app ?? this.app } }),
      /**
       * Add a document. It is indexed in the background: read it again, or wait
       * for `kb.updated`, to see `index.status` reach `ready`. Sending a document
       * that already exists in every field returns the existing one. Retried
       * only with an idempotency key. Needs `kb:write`.
       */
      create: (doc: DocumentInput, opts: WriteOptions = {}) =>
        this.json<KnowledgeDocument>('knowledge.documents.create', {
          json: this.withApp(doc),
          idempotencyKey: opts.idempotencyKey,
        }),
      /**
       * Change the fields given and index the document again. The same change
       * sent twice leaves the same document, so the client retries it like a
       * read. Needs `kb:write`.
       */
      update: (id: string, patch: DocumentPatch) =>
        this.json<KnowledgeDocument>('knowledge.documents.update', { path: { id }, json: this.withApp(patch) }),
      /**
       * Delete a document. The agent stops using it. Retried like a read: when
       * a retry answers `NOT_FOUND`, an earlier attempt deleted it. Needs `kb:write`.
       */
      delete: (id: string, opts: { app?: string } = {}) =>
        this.json<{ id: string; deleted: boolean }>('knowledge.documents.delete', {
          path: { id },
          query: { app: opts.app ?? this.app },
        }),
    },

    /**
     * Turn a file into a document: PDF, spreadsheet, image or text, at most
     * 20 MB. `file` is the raw bytes. Needs `kb:write`.
     */
    importFile: (file: BodyInit, opts: { filename: string; contentType?: string; app?: string } & WriteOptions) =>
      this.json<KnowledgeDocument>('knowledge.import_file', {
        body: file,
        query: { filename: opts.filename, app: opts.app ?? this.app },
        headers: { 'content-type': opts.contentType ?? 'application/octet-stream' },
        idempotencyKey: opts.idempotencyKey,
      }),

    sources: {
      /** The websites the knowledge base is crawled from. Needs `kb:read`. */
      list: async (opts: { app?: string } = {}) =>
        (await this.json<{ sources: Json[] }>('knowledge.sources.list', { query: { app: opts.app ?? this.app } })).sources ?? [],
      /** Add a website and start crawling it. Each page becomes a document. Needs `kb:write`. */
      create: (req: { root_url: string; max_pages?: number; max_depth?: number; app?: string }, opts: WriteOptions = {}) =>
        this.json<Json>('knowledge.sources.create', { json: this.withApp(req), idempotencyKey: opts.idempotencyKey }),
      /** Crawl a source again. Needs `kb:write`. */
      crawl: (id: string, opts: { app?: string } & WriteOptions = {}) =>
        this.json<{ id: string; queued: boolean }>('knowledge.sources.crawl', {
          path: { id },
          query: { app: opts.app ?? this.app },
          idempotencyKey: opts.idempotencyKey,
        }),
    },

    /**
     * What changed in the knowledge base after `since`, with the passages
     * search uses, for keeping your own copy. Without `since` it returns
     * everything indexed. Follow `next_cursor` until it is empty, then keep
     * `version` for the next call. Needs `kb:read`.
     */
    export: (opts: { since?: number; cursor?: string; limit?: number; app?: string } = {}) =>
      this.json<KnowledgeExport>('knowledge.export', {
        query: {
          since: opts.since !== undefined ? String(opts.since) : undefined,
          cursor: opts.cursor,
          limit: opts.limit ? String(opts.limit) : undefined,
          app: opts.app ?? this.app,
        },
      }),
  }

  readonly agent = {
    /**
     * One turn of the workspace's own agent. The caller keeps the conversation.
     * A turn may fire a tool, so it is retried only with an idempotency key.
     * The second argument is an AbortSignal, or options holding one. Needs `agent:run`.
     */
    turn: (req: AgentTurnRequest, opts?: AbortSignal | (WriteOptions & { signal?: AbortSignal })) => {
      const o = opts instanceof AbortSignal ? { signal: opts } : (opts ?? {})
      return this.json<AgentTurnResult>('agent.turn', {
        json: this.withApp(req),
        signal: o.signal,
        idempotencyKey: (o as WriteOptions).idempotencyKey,
      })
    },

    /**
     * The same turn as a stream: `delta` events as the reply is written, with
     * the agent's reply markup held back, then one `done` with the whole turn.
     * Keep the text from `done`. When the agent's settings turn streaming off
     * or redaction on, only `done` arrives. Throws OmazyError if the stream
     * reports an error or ends before `done`. A stream is not retried, and
     * an idempotency key does not replay it. Needs `agent:run`.
     */
    stream: (req: AgentTurnRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent<AgentTurnResult>> =>
      this.stream<AgentTurnResult>('agent.turn', req, signal),

    settings: {
      /**
       * How the agent runs: its model with the reply cap and temperature, the
       * models the plan allows, and the loop switches. Needs `agent:configure`.
       */
      get: (opts: { app?: string } = {}) =>
        this.json<AgentSettings>('agent.settings.get', { query: { app: opts.app ?? this.app } }),

      /**
       * Changes the model, the reply cap, the temperature or the loop
       * switches, and returns the settings after the change. A new model is
       * tested with one real call before it is saved, so allow up to 90
       * seconds. A model off the plan is `MODEL_NOT_AVAILABLE`; one that did
       * not answer is `MODEL_NOT_SERVING`, and nothing changes. The same
       * change sent twice leaves the same settings. Needs `agent:configure`.
       */
      update: (req: AgentSettingsUpdate) =>
        this.json<AgentSettings>('agent.settings.update', { json: this.withApp(req) }),
    },

    /**
     * The MCP tool servers the agent may call. Needs `agent:tools`.
     *
     * This is not `omazy.mcp`, which is Omazy as an MCP server for your own
     * agent. These are the servers Omazy's agent calls.
     */
    mcpServers: {
      /** The agent's servers, newest first. A credential is never returned. */
      list: (opts: { app?: string } = {}) =>
        this.json<McpServer[]>('agent.mcp_servers.list', { query: { app: opts.app ?? this.app } }),

      get: (id: string, opts: { app?: string } = {}) =>
        this.json<McpServer>('agent.mcp_servers.get', { path: { id }, query: { app: opts.app ?? this.app } }),

      /**
       * Connects a server. Its tools reach the model from the agent's next
       * turn as `mcp_<name>__<tool>`. The name is unique within the app: a
       * second server with it is `409 CONFLICT`. The endpoint must be https on
       * a public host. Retried only with an idempotency key.
       */
      create: (req: McpServerInput, opts: WriteOptions = {}) =>
        this.json<McpServer>('agent.mcp_servers.create', { json: this.withApp(req), idempotencyKey: opts.idempotencyKey }),

      /** Changes a server. Send only what changes. `credentials: ''` removes the stored credential. */
      update: (id: string, req: McpServerUpdate) =>
        this.json<McpServer>('agent.mcp_servers.update', { path: { id }, json: this.withApp(req) }),

      /**
       * Removes a server and its stored credential. Retried like a read: when a
       * retry answers `NOT_FOUND`, an earlier attempt removed it.
       */
      delete: (id: string, opts: { app?: string } = {}) =>
        this.json<{ id: string; deleted: true }>('agent.mcp_servers.delete', { path: { id }, query: { app: opts.app ?? this.app } }),
    },
  }

  readonly voice = {
    /** Text to speech in the agent's voice. Returns WAV audio. Needs `voice:speech`. */
    speak: async (text: string, opts: { lang?: string; app?: string } = {}) => {
      const res = await this.send('voice.speak', { json: this.withApp({ text, ...opts }) })
      return { audio: await res.arrayBuffer(), language: res.headers.get('x-omazy-speech-lang') ?? '' }
    },
    /**
     * Speech to text. `audio` is the raw recording, at most 8 MB. `terms` are
     * names and words to expect, so they come back spelled right. Needs `voice:speech`.
     */
    transcribe: (audio: BodyInit, opts: { lang?: string; app?: string; contentType?: string; terms?: string[] } = {}) =>
      this.json<{ text: string; language: string }>('voice.transcribe', {
        body: audio,
        query: { lang: opts.lang, app: opts.app ?? this.app, terms: opts.terms?.length ? opts.terms.join(',') : undefined },
        headers: { 'content-type': opts.contentType ?? 'application/octet-stream' },
      }),
    /**
     * Live speech to text over a WebSocket. Open it when the person starts
     * speaking (or once for a whole conversation), send audio as it is
     * captured, `commit()` after each utterance and `end()` to finish. The
     * text is ready a few hundred milliseconds after they stop. Server side
     * only: the token goes on the upgrade. Never retried. Needs `voice:speech`.
     */
    transcribeStream: (opts: TranscriptionStreamOptions = {}): Promise<TranscriptionSession> => {
      const url = buildUrl(this.base.replace(/^http/, 'ws'), ROUTES['voice.transcribe_stream'][1], {}, { app: opts.app ?? this.app })
      return openTranscription(
        this.webSocket,
        url,
        { authorization: `Bearer ${this.token}`, 'user-agent': this.transport.userAgent },
        opts,
      )
    },
    calls: {
      /**
       * Queue an outbound call answered by the agent. Retried only with an
       * idempotency key, so a phone never rings twice for one request. Needs `voice:calls`.
       */
      place: (req: CallRequest, opts: WriteOptions = {}) =>
        this.json<CallResult>('voice.calls.place', { json: this.withApp(req), idempotencyKey: opts.idempotencyKey }),
      /** Where a call stands and what the person answered. */
      get: (ref: string, opts: { app?: string } = {}) =>
        this.json<CallStatus>('voice.calls.get', { path: { ref }, query: { app: opts.app ?? this.app } }),
    },
    jobs: {
      /** Transcribe a recording or write notes from one, in the background. Needs `voice:tasks`. */
      create: (req: VoiceJobRequest, opts: WriteOptions = {}) => {
        // This route reads the app from the query string.
        const { app, ...body } = this.withApp(req)
        return this.json<Json>('voice.jobs.create', { json: body, query: { app }, idempotencyKey: opts.idempotencyKey })
      },
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
    /** Post 1 to 12 blocks into an existing conversation as the app. Retried only with an idempotency key. Needs `core:write`. */
    postMessage: (id: string, blocks: Block[], opts: WriteOptions = {}) =>
      this.json<Json>('conversations.post_message', { path: { id }, json: { blocks }, idempotencyKey: opts.idempotencyKey }),
  }

  readonly channels = {
    /** Publish a post to the connected LinkedIn page. Retried only with an idempotency key. Needs `channels:publish`. */
    linkedinPublish: (req: { text: string; app?: string; [key: string]: unknown }, opts: WriteOptions = {}) =>
      this.json<Json>('channels.linkedin_publish', { json: this.withApp(req), idempotencyKey: opts.idempotencyKey }),
  }

  readonly sessions = {
    /** Bind a signed-in user's own tool credential to their chat session. Needs `sessions:credentials`. */
    bindCredential: (sessionId: string, server: string, body: { token: string; expires_at: string; subject: Json }) =>
      this.json<Json>('sessions.bind_credential', { path: { sid: sessionId, server }, json: body }),
    unbindCredential: (sessionId: string, server: string) =>
      this.json<Json>('sessions.unbind_credential', { path: { sid: sessionId, server } }),
  }

  /**
   * Spend caps on this install, held before the call: a completion, an
   * embedding or an agent turn past a cap that covers it is refused with 402
   * `BUDGET_EXCEEDED` before any model runs.
   */
  readonly budgets = {
    /** The caps with this period's spend. Needs `usage:read`. */
    list: () => this.json<{ budgets: Budget[] }>('budgets.list'),
    /** Add a cap, or change the limit of the one with the same label, value and period. Needs `ai:configure`. */
    set: (req: BudgetSetRequest) => this.json<Budget>('budgets.set', { json: req }),
    /** Remove a cap. Needs `ai:configure`. */
    delete: (id: string) => this.json<{ id: string; deleted: true }>('budgets.delete', { path: { id } }),
  }

  readonly usage = {
    /**
     * What the workspace used and what it cost, per UTC day: model calls,
     * cache hits, tokens, speech, cost, and the plan's counters. The last 30
     * days by default, at most 90. Needs `usage:read`.
     */
    get: (range: UsageRange & UsageGrouping = {}) =>
      this.json<UsageReport>('usage.get', {
        query: { from: range.from, to: range.to, group_by: range.group_by, unit: range.unit, run_id: range.run_id },
      }),
  }

  private withApp<T extends object>(req: T): T {
    return this.app && (req as { app?: string }).app === undefined ? { ...req, app: this.app } : req
  }

  /** Reads a streamed route's server-sent events: `delta`, then `done` or `error`. */
  private async *stream<R>(route: RouteName, req: object, signal?: AbortSignal): AsyncGenerator<StreamEvent<R>> {
    const res = await this.send(
      route,
      { json: this.withApp({ ...req, stream: true }), signal, headers: { accept: 'text/event-stream' } },
      0,
    )
    // This response's own id: `last` may already belong to another call.
    const requestId = readInfo(res.headers).requestId
    if (!res.body) throw new OmazyError('the stream had no body', res.status, 'STREAM_ERROR', requestId)
    for await (const frame of readSse(res.body)) {
      if (frame.event === 'delta') {
        yield { type: 'delta', text: (JSON.parse(frame.data) as { text: string }).text }
      } else if (frame.event === 'done') {
        yield { type: 'done', result: JSON.parse(frame.data) as R }
        return
      } else if (frame.event === 'error') {
        const e = JSON.parse(frame.data) as { message?: string; code?: string }
        throw new OmazyError(e.message ?? 'the stream failed', res.status, e.code ?? 'STREAM_ERROR', requestId)
      }
    }
    throw new OmazyError('the stream ended before it was done', res.status, 'STREAM_ERROR', requestId)
  }

  /** Sends a request and unwraps `{ success, data }`. */
  private async json<T>(route: RouteName, init: CallInit = {}): Promise<T> {
    const res = await this.send(route, init)
    const body = (await res.json()) as { success?: boolean; data?: T }
    return body.data as T
  }

  /** Sends a request with retries. Resolves with a 2xx response; throws OmazyError otherwise. */
  private send(route: RouteName, init: CallInit = {}, retries = this.maxRetries): Promise<Response> {
    const [method, template] = ROUTES[route]
    // A key makes a request that changes something safe to send again.
    const keyed = Boolean(init.idempotencyKey) && IDEMPOTENT.has(route)
    return request(this.transport, {
      method,
      url: buildUrl(this.base, template, init.path, init.query),
      json: init.json,
      body: init.body,
      headers: init.headers,
      signal: init.signal,
      retries: RETRYABLE.has(route) || keyed ? retries : 0,
      idempotencyKey: keyed ? init.idempotencyKey : undefined,
    })
  }
}
