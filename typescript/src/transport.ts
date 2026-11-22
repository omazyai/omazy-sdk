import { OmazyError } from './errors.js'

/** What the API said about limits and the token on the last response. */
export interface ResponseInfo {
  requestId?: string
  rateLimit?: { limit: number; remaining: number; resetSeconds: number }
  /** Set when the token has a deadline. */
  tokenExpiresAt?: string
  /** True while the caller is still on a token a rotation replaced. */
  tokenIsPrevious: boolean
  /** True when the answer is the remembered answer of an earlier request with the same idempotency key. */
  replayed: boolean
}

/** How one client reaches its API. */
export interface Transport {
  token: string
  timeoutMs: number
  fetcher: typeof fetch
  userAgent: string
  /** The API's name in a network error, such as "the Core API". */
  api: string
  /** Called with the headers of every response, refused ones included. */
  onResponse: (info: ResponseInfo) => void
}

export interface Outgoing {
  method: string
  url: string
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
  signal?: AbortSignal
  /** How many times to send the request again after a failure that may pass. */
  retries: number
  /** Sent as Idempotency-Key. With it, a 409 IDEMPOTENCY_IN_PROGRESS is waited out. */
  idempotencyKey?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2)

/** Sends a request with retries. Resolves with a 2xx response; throws OmazyError otherwise. */
export async function request(t: Transport, out: Outgoing): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${t.token}`,
    'user-agent': t.userAgent,
    ...(out.json !== undefined ? { 'content-type': 'application/json' } : {}),
    ...out.headers,
  }
  const keyed = Boolean(out.idempotencyKey)
  if (keyed) headers['idempotency-key'] = out.idempotencyKey!
  const body = out.json !== undefined ? JSON.stringify(out.json) : out.body
  // A stream can be read once, so a request whose body is one is sent once.
  const once = typeof ReadableStream !== 'undefined' && body instanceof ReadableStream
  const attempts = once ? 0 : out.retries

  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(t.timeoutMs)
    const signal = out.signal ? AbortSignal.any([out.signal, timeout]) : timeout
    let res: Response
    try {
      res = await t.fetcher(out.url, { method: out.method, headers, body, signal })
    } catch (err) {
      if (out.signal?.aborted) throw err
      if (attempt < attempts) {
        await sleep(backoff(attempt))
        continue
      }
      throw new OmazyError(`no response from ${t.api}: ${(err as Error).message}`, 0, 'NETWORK_ERROR')
    }
    const info = readInfo(res.headers)
    t.onResponse(info)
    if (res.ok) return res

    const retryAfter = Number(res.headers.get('retry-after')) || undefined
    const failed = await readError(res)
    const transient =
      res.status === 429 ||
      res.status === 502 ||
      res.status === 503 ||
      res.status === 504 ||
      // The first request with this key is still running: wait and ask again.
      (keyed && res.status === 409 && failed.code === 'IDEMPOTENCY_IN_PROGRESS')
    // A long Retry-After means the window is full; waiting it out here would
    // hide a stalled caller. Hand that decision back.
    if (transient && attempt < attempts && (retryAfter ?? 0) <= 30) {
      await sleep(retryAfter ? retryAfter * 1000 : backoff(attempt))
      continue
    }
    throw new OmazyError(failed.message, res.status, failed.code, info.requestId, retryAfter)
  }
}

/** Fills `{name}` parts of a path and appends the query. Empty query values are left out. */
export function buildUrl(base: string, template: string, path: Record<string, string> = {}, query: Record<string, string | undefined> = {}): string {
  let p = template
  for (const [k, v] of Object.entries(path)) p = p.replace(`{${k}}`, encodeURIComponent(v))
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v)
  return base + p + (q.size ? `?${q}` : '')
}

export function readInfo(h: Headers): ResponseInfo {
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
    replayed: h.get('idempotent-replayed') === 'true',
  }
}

export async function readError(res: Response): Promise<{ code: string; message: string }> {
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
