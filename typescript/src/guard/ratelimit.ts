// Rate limits per seat (reads and writes apart) and per tenant. The
// Cloudflare binding is approximate (per location, 10 or 60 second windows);
// a product that needs a strict count supplies its own RateLimiter.

import type { RateDecision, RateLimiter, RateRequest } from './types.js'

/** The shape of a Workers Rate Limiting binding (`[[unsafe.bindings]] type = "ratelimit"`). */
export interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>
}

/**
 * One binding per limit, since a binding carries its own limit and period
 * in wrangler config. Keys: `seat:<id>:read`, `seat:<id>:write`, `tenant:<id>`.
 */
export function rateLimitBindings(b: { read?: RateLimitBinding; write?: RateLimitBinding; tenant?: RateLimitBinding; retryAfter?: number }): RateLimiter {
  return {
    async check(req: RateRequest): Promise<RateDecision> {
      const seat = req.mode === 'read' ? b.read : b.write
      if (seat && !(await seat.limit({ key: `seat:${req.seat}:${req.mode}` })).success) return { ok: false, limit: `seat_${req.mode}`, retryAfter: b.retryAfter ?? 60 }
      if (b.tenant && req.tenant && !(await b.tenant.limit({ key: `tenant:${req.tenant}` })).success) return { ok: false, limit: 'tenant', retryAfter: b.retryAfter ?? 60 }
      return { ok: true }
    },
  }
}

export interface MemoryLimits {
  perSeat?: { read?: number; write?: number }
  perTenant?: number
  /** Default 60 seconds. */
  windowMs?: number
  now?: () => number
}

/** Fixed windows in memory, for tests and one-process runs. */
export function memoryRateLimiter(l: MemoryLimits = {}): RateLimiter & { reset(): void } {
  const windowMs = l.windowMs ?? 60_000
  const now = l.now ?? Date.now
  const counts = new Map<string, { start: number; n: number }>()
  const hit = (key: string, max: number | undefined): number | null => {
    if (max === undefined) return null
    const t = now()
    let c = counts.get(key)
    if (!c || t - c.start >= windowMs) counts.set(key, (c = { start: t, n: 0 }))
    if (c.n >= max) return Math.max(1, Math.ceil((c.start + windowMs - t) / 1000))
    c.n++
    return null
  }
  return {
    reset: () => counts.clear(),
    async check(req) {
      const s = hit(`seat:${req.seat}:${req.mode}`, l.perSeat?.[req.mode])
      if (s !== null) return { ok: false, limit: `seat_${req.mode}`, retryAfter: s }
      const t = req.tenant ? hit(`tenant:${req.tenant}`, l.perTenant) : null
      if (t !== null) return { ok: false, limit: 'tenant', retryAfter: t }
      return { ok: true }
    },
  }
}
