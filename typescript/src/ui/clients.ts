// Fetch clients for the copilot's routes (`copilot.handle`) and for the kit
// routes `uiRoutes` serves. Same origin by default; the product's session
// cookie or headers authenticate the person.

import type { ChatMessage } from './chat.js'
import type {
  AppsData,
  ApprovalItem,
  ApprovalStatusName,
  CardOutcomeData,
  CodeSent,
  ConsentCardData,
  DecideBody,
  DecideResult,
  GrantsData,
  MemoryDecision,
  MemoryItem,
  SetGrantData,
} from './types.js'

export interface HttpOptions {
  /** Where the routes are mounted, such as `/copilot` or `/ui`. No trailing slash needed. */
  base: string
  fetch?: typeof fetch
  headers?: Record<string, string> | (() => Record<string, string>)
}

/** A route answered with an error. `message` is the server's sentence when it gave one. */
export class UiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'UiHttpError'
  }
}

function http(o: HttpOptions) {
  const base = o.base.replace(/\/+$/, '')
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  return async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, accept: number[] = []): Promise<T> {
    const headers = { accept: 'application/json', ...(typeof o.headers === 'function' ? o.headers() : o.headers ?? {}) } as Record<string, string>
    if (method === 'POST') headers['content-type'] = 'application/json'
    const res = await doFetch(`${base}${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      // not JSON
    }
    if (res.ok || accept.includes(res.status)) return data as T
    const err = (data as { error?: { code?: string; message?: string } | string } | null)?.error
    const message = typeof err === 'string' ? err : err?.message ?? `HTTP ${res.status}`
    throw new UiHttpError(res.status, message, typeof err === 'object' ? err?.code : undefined)
  }
}

const seg = (s: string) => encodeURIComponent(s)

export interface CopilotClient {
  /** The chat route, for `createChat` or `useChat`'s transport. */
  readonly chatUrl: string
  history(thread: string): Promise<{ messages: ChatMessage[]; waiting: ConsentCardData[]; actor: { session: string; actor: string } | null }>
  confirm(thread: string, card: string): Promise<CardOutcomeData>
  decline(thread: string, card: string): Promise<CardOutcomeData>
}

/** The copilot's own routes: `POST …/chat`, `GET …/threads/<id>`, `POST …/cards/<id>/confirm|decline`. */
export function copilotClient(o: HttpOptions): CopilotClient {
  const call = http(o)
  return {
    chatUrl: `${o.base.replace(/\/+$/, '')}/chat`,
    history: (thread) => call('GET', `/threads/${seg(thread)}`),
    // A card that is gone (404) or a thread that is busy (409) is an outcome the card shows, not an error.
    confirm: (thread, card) => call('POST', `/cards/${seg(card)}/confirm`, { thread }, [404, 409]),
    decline: (thread, card) => call('POST', `/cards/${seg(card)}/decline`, { thread }, [404, 409]),
  }
}

export interface UiClient {
  approvals: {
    list(q?: { status?: ApprovalStatusName | 'all' }): Promise<ApprovalItem[]>
    get(id: string): Promise<ApprovalItem | null>
    decide(id: string, body: DecideBody): Promise<DecideResult>
    /** Sends the decider a step-up code for this approval. Needs `uiRoutes` with `approvals.codes`. */
    sendCode(id: string): Promise<CodeSent>
  }
  apps: {
    list(): Promise<AppsData>
    revoke(grantId: string): Promise<boolean>
    revokeKey(id: string): Promise<boolean>
  }
  memory: {
    list(): Promise<MemoryItem[]>
    confirm(id: string): Promise<MemoryDecision>
    reject(id: string): Promise<MemoryDecision>
    forget(id: string): Promise<boolean>
  }
  grants: {
    list(): Promise<GrantsData>
    set(input: { capability: string; days: number; dailyCap: number }): Promise<SetGrantData>
    revoke(id: string): Promise<boolean>
  }
}

/** The routes `uiRoutes` serves, mounted at `base` (default `/ui`). */
export function uiClient(o: Partial<HttpOptions> = {}): UiClient {
  const call = http({ base: '/ui', ...o })
  return {
    approvals: {
      list: async (q = {}) => (await call<{ approvals: ApprovalItem[] }>('GET', `/approvals${q.status ? `?status=${seg(q.status)}` : ''}`)).approvals,
      get: async (id) => (await call<{ approval: ApprovalItem | null }>('GET', `/approvals/${seg(id)}`, undefined, [404])).approval ?? null,
      // Every decide outcome is an answer the inbox shows, whatever its status.
      decide: (id, body) => call('POST', `/approvals/${seg(id)}/decide`, body, [400, 403, 404, 409]),
      sendCode: (id) => call('POST', `/approvals/${seg(id)}/code`, {}),
    },
    apps: {
      list: () => call('GET', '/apps'),
      revoke: async (grantId) => (await call<{ ok: boolean }>('POST', `/apps/${seg(grantId)}/revoke`, {}, [404])).ok,
      revokeKey: async (id) => (await call<{ ok: boolean }>('POST', `/keys/${seg(id)}/revoke`, {}, [404])).ok,
    },
    memory: {
      list: async () => (await call<{ memories: MemoryItem[] }>('GET', '/memory')).memories,
      confirm: (id) => call('POST', `/memory/${seg(id)}/confirm`, {}, [403, 404, 409]),
      reject: (id) => call('POST', `/memory/${seg(id)}/reject`, {}, [403, 404, 409]),
      forget: async (id) => (await call<{ ok: boolean }>('POST', `/memory/${seg(id)}/forget`, {}, [404])).ok,
    },
    grants: {
      list: () => call('GET', '/grants'),
      set: (input) => call('POST', '/grants', input, [400, 403]),
      revoke: async (id) => (await call<{ ok: boolean }>('POST', `/grants/${seg(id)}/revoke`, {}, [404])).ok,
    },
  }
}
