// One request id across a product's Workers, carried in a header and
// written on every log and audit row.

import { randomToken } from './crypto.js'

export const REQUEST_ID_HEADER = 'X-Omazy-Request-Id'

const SAFE = /^[A-Za-z0-9._:-]{8,128}$/

/** A new request id. */
export const newRequestId = (): string => `req_${randomToken(12)}`

/** The id on an incoming request when it looks like one, a new one otherwise. */
export function requestIdFrom(from: Request | Headers | null | undefined): string {
  const h = from instanceof Request ? from.headers : from
  const v = h?.get(REQUEST_ID_HEADER)?.trim()
  return v && SAFE.test(v) ? v : newRequestId()
}

/** Headers for an outgoing call, with the request id set. */
export function withRequestId(init: HeadersInit | undefined, requestId: string): Headers {
  const h = new Headers(init)
  h.set(REQUEST_ID_HEADER, requestId)
  return h
}

/** A fetch that sends the request id on every call, for service bindings and outbound calls. */
export function tracedFetch(requestId: string, f: typeof fetch = fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => f(input, { ...init, headers: withRequestId(init?.headers ?? (input instanceof Request ? input.headers : undefined), requestId) })) as typeof fetch
}
