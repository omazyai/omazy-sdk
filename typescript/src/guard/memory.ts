// The guard's stores in memory, for tests and local runs. Same semantics as
// the D1 adapter: nonces are taken once, approval updates are a
// compare-and-swap on status.

import type { ApprovalRow, ChallengeRow, GuardStore, RequestLogSink, RequestRecord } from './types.js'

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v))

export function memoryGuardStore(): GuardStore & { approvals: Map<string, ApprovalRow>; nonces: Map<string, number> } {
  const nonces = new Map<string, number>()
  const approvals = new Map<string, ApprovalRow>()
  const challenges = new Map<string, ChallengeRow>()
  return {
    nonces,
    approvals,
    async putNonce(n, exp) {
      nonces.set(n, exp)
    },
    async takeNonce(n, now) {
      const exp = nonces.get(n)
      nonces.delete(n)
      return exp !== undefined && exp > now
    },
    async insertApproval(row) {
      if (approvals.has(row.id)) throw new Error(`approval ${row.id} exists`)
      approvals.set(row.id, clone(row))
    },
    async getApproval(id) {
      return clone(approvals.get(id) ?? null)
    },
    async updateApproval(id, from, patch) {
      const row = approvals.get(id)
      if (!row || row.status !== from) return false
      approvals.set(id, { ...row, ...clone(patch), id })
      return true
    },
    async listApprovals(q = {}) {
      let rows = [...approvals.values()]
      if (q.tenant !== undefined) rows = rows.filter((r) => r.tenant === q.tenant)
      if (q.status) rows = rows.filter((r) => r.status === q.status)
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return clone(rows.slice(0, q.limit ?? 100))
    },
    async expireApprovals(now) {
      let n = 0
      for (const r of approvals.values()) {
        if (r.status === 'waiting' && Date.parse(r.expiresAt) <= now) {
          r.status = 'expired'
          n++
        }
      }
      return n
    },
    async putChallenge(row) {
      challenges.set(row.id, { ...row })
    },
    async getChallenge(id) {
      return clone(challenges.get(id) ?? null)
    },
    async bumpChallenge(id) {
      const c = challenges.get(id)
      if (!c) return 0
      c.attempts++
      return c.attempts
    },
    async deleteChallenge(id) {
      challenges.delete(id)
    },
  }
}

/** Keeps every record in `records`. */
export function memoryRequestLog(): RequestLogSink & { records: RequestRecord[] } {
  const records: RequestRecord[] = []
  return {
    records,
    async write(rs) {
      records.push(...rs.map((r) => ({ ...r })))
    },
  }
}
