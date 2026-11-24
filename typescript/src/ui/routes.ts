// The server half of the ui kit: JSON routes over the kits the product
// already runs, for the approvals inbox, the connected apps page, the memory
// page and the standing grants section. The product builds the ctx from its
// own session, exactly as for any other route, and mounts one handler.
//
//   GET  <base>/approvals?status=waiting|all|<status>
//   GET  <base>/approvals/<id>
//   POST <base>/approvals/<id>/code     sends the decider a step-up code (with `approvals.codes`)
//   POST <base>/approvals/<id>/decide   { approve, reason?, typedTarget?, proof? }
//   GET  <base>/apps                    connected apps and keys
//   POST <base>/apps/<grantId>/revoke
//   POST <base>/keys/<id>/revoke
//   GET  <base>/memory
//   POST <base>/memory/<id>/confirm|reject|forget
//   GET  <base>/grants
//   POST <base>/grants                  { capability, days, dailyCap }
//   POST <base>/grants/<id>/revoke
//
// A POST must be JSON, so a plain form on another site cannot send one. An
// approval is listed only to its requester, its decider and whoever may
// decide it now (or whom `canSee` allows); the arguments stay sealed.

import type { BaseCtx } from '../capabilities/capability.js'
import type { Registry } from '../capabilities/registry.js'
import type { CodeStepUp } from '../guard/stepup.js'
import type { ApprovalRow, ApprovalStatus, Guard, GuardStore } from '../guard/types.js'
import { describePolicy } from '../guard/policies.js'
import type { Memory, MemoryRow } from '../ai/memory.js'
import { type Grants, MAX_GRANT_DAILY_CAP, MAX_GRANT_DAYS, type StandingGrant } from '../copilot/grants.js'
import type { AppItem, ApprovalItem, CodeSent, DecideResult, GrantItem, KeyItem, MemoryItem } from './types.js'

/** What the connected apps page needs from the oauth kit's server. `createOAuthServer` gives all three. */
export interface AppsSource {
  connectedApps(personId: string): Promise<{ apps: (AppItem & Record<string, unknown>)[]; keys: (KeyItem & Record<string, unknown>)[] }>
  revokeApp(personId: string, grantId: string): Promise<boolean>
  keys: { revoke(owner: string, id: string): Promise<boolean> }
}

export interface UiRoutesOptions<C extends BaseCtx> {
  /** Where the routes are mounted. Default `/ui`. */
  base?: string
  /** The approvals inbox: the guard decides, its store lists. */
  approvals?: {
    guard: Pick<Guard<C>, 'approval' | 'canDecide' | 'decide'>
    store: Pick<GuardStore, 'listApprovals'>
    /** The link to one approval's review page, as the guard's `reviewUrl`. */
    reviewUrl?: (a: ApprovalRow) => string | undefined
    /** Widens who may see a row, such as a tenant's owners seeing every request of the tenant. */
    canSee?: (ctx: C, a: ApprovalRow) => boolean | Promise<boolean>
    /**
     * The guard's `codeStepUp`, the same one given to `createGuard`'s
     * `stepUp`. With it, `POST …/approvals/<id>/code` sends a code to whoever
     * may decide the approval now, and `CodeStepUpForm` asks for it. Each
     * call sends a fresh code and the earlier one stops working; limit how
     * often a person may ask, as for any message you send.
     */
    codes?: Pick<CodeStepUp<C>, 'start' | 'methods'>
  }
  /** The connected apps page: `createOAuthServer(...)`. */
  apps?: AppsSource
  /** The memory page: `ai.memory` or `createMemory(...)`. */
  memory?: Memory<C>
  /** The standing grants section: `createGrants(...)`. */
  grants?: Grants<C>
  /** Capability titles, and the R2 capabilities a grant may name. */
  registry?: Registry<C, any, any>
  /** Narrows the capabilities a standing grant may name, such as to a copilot unit's tools. */
  grantable?: readonly string[]
  onError?: (err: unknown, where: string) => void
}

export interface UiRoutes<C extends BaseCtx> {
  /** Answers the routes above; null for any other request, so the product can route on. */
  handle(req: Request, ctx: C, opts?: { waitUntil?: (p: Promise<unknown>) => void }): Promise<Response | null>
}

const STATUSES: readonly ApprovalStatus[] = ['waiting', 'approved', 'refused', 'expired', 'running', 'executed', 'failed', 'stale', 'withdrawn']

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status)

const memoryItem = (r: MemoryRow): MemoryItem => ({
  id: r.id,
  scope: r.scope,
  text: r.text,
  status: r.status,
  unit: r.unit,
  runId: r.runId,
  proposedAt: r.proposedAt,
  decidedAt: r.decidedAt,
  decidedBy: r.decidedBy,
  lastUsedAt: r.lastUsedAt,
})

export function uiRoutes<C extends BaseCtx>(o: UiRoutesOptions<C>): UiRoutes<C> {
  const base = (o.base ?? '/ui').replace(/\/+$/, '')
  const onError = o.onError ?? ((e, where) => console.error(`ui routes ${where}:`, e))
  const titleOf = (name: string) => o.registry?.get(name)?.title ?? name

  // ------------------------------------------------------------ approvals

  async function approvalItem(ctx: C, row: ApprovalRow): Promise<ApprovalItem | null> {
    const a = o.approvals!
    if (ctx.tenant != null && row.tenant !== ctx.tenant) return null
    const me = ctx.principal.id
    const may = row.status === 'waiting' ? await a.guard.canDecide(row.id, ctx) : ({ ok: false, message: '' } as const)
    const visible = row.requester.id === me || row.decider?.id === me || may.ok || (a.canSee ? await a.canSee(ctx, row) : false)
    if (!visible) return null
    const reviewUrl = a.reviewUrl?.(row)
    return {
      id: row.id,
      action: row.action,
      title: titleOf(row.action),
      tier: row.tier,
      status: row.status,
      preview: row.preview,
      policy: row.policy,
      decider: describePolicy(row.rule),
      requester: { kind: row.requester.kind, id: row.requester.id, ...(row.requester.name ? { name: row.requester.name } : {}) },
      channel: row.channel,
      tenant: row.tenant,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      decidedAt: row.decidedAt ?? null,
      decidedBy: row.decider ? { kind: row.decider.kind, id: row.decider.id, ...(row.decider.name ? { name: row.decider.name } : {}) } : null,
      reason: row.reason ?? null,
      verification: row.verification ?? null,
      error: row.error ?? null,
      ...(reviewUrl ? { reviewUrl } : {}),
      canDecide: may.ok,
      ...(!may.ok && row.status === 'waiting' && may.message ? { why: may.message } : {}),
      needs: { stepUp: [...row.rule.stepUp], typedTarget: row.rule.typedTarget, fourEyes: row.rule.fourEyes },
    }
  }

  async function approvals(req: Request, ctx: C, rest: string[], opts: { waitUntil?: (p: Promise<unknown>) => void }): Promise<Response | null> {
    const a = o.approvals!
    if (req.method === 'GET' && rest.length === 0) {
      const q = new URL(req.url).searchParams.get('status') ?? 'waiting'
      if (q !== 'all' && !STATUSES.includes(q as ApprovalStatus)) return fail(400, 'bad_request', 'Unknown status.')
      const rows = await a.store.listApprovals({ ...(ctx.tenant != null ? { tenant: ctx.tenant } : {}), ...(q !== 'all' ? { status: q as ApprovalStatus } : {}), limit: 100 })
      const items = (await Promise.all(rows.map((r) => approvalItem(ctx, r)))).filter((x): x is ApprovalItem => !!x)
      return json({ approvals: items })
    }
    const id = rest[0]!
    if (req.method === 'GET' && rest.length === 1) {
      const row = await a.guard.approval(id)
      const item = row ? await approvalItem(ctx, row) : null
      return item ? json({ approval: item }) : json({ approval: null }, 404)
    }
    if (req.method === 'POST' && rest.length === 2 && rest[1] === 'code') {
      if (!a.codes) return null
      const row = await a.guard.approval(id)
      if (!row || !(await approvalItem(ctx, row))) return fail(404, 'not_found', 'There is no such request.')
      if (row.status !== 'waiting') return fail(409, 'already_decided', 'This request is no longer waiting.')
      const may = await a.guard.canDecide(row.id, ctx)
      if (!may.ok) return fail(403, 'not_allowed', may.message)
      const method = a.codes.methods.find((m) => row.rule.stepUp.includes(m))
      if (!method) return fail(400, 'no_code', `This request is verified with ${row.rule.stepUp.join(' or ')}, not a code.`)
      const sent = await a.codes.start(ctx, row)
      return json({ channels: [...sent.channels], method, expiresAt: new Date(sent.expiresAt).toISOString() } satisfies CodeSent)
    }
    if (req.method === 'POST' && rest.length === 2 && rest[1] === 'decide') {
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body.approve !== 'boolean') return fail(400, 'bad_request', 'Say approve: true or false.')
      const row = await a.guard.approval(id)
      if (!row || !(await approvalItem(ctx, row))) return json({ outcome: 'not_found' } satisfies DecideResult, 404)
      const proof = body.proof && typeof body.proof === 'object' && typeof (body.proof as { method?: unknown }).method === 'string' ? (body.proof as { method: string }) : undefined
      const out = await a.guard.decide(
        id,
        ctx,
        {
          approve: body.approve,
          ...(typeof body.reason === 'string' ? { reason: body.reason.slice(0, 1000) } : {}),
          ...(typeof body.typedTarget === 'string' ? { typedTarget: body.typedTarget.slice(0, 200) } : {}),
          ...(proof ? { proof } : {}),
        },
        opts,
      )
      const after = 'approval' in out ? await approvalItem(ctx, out.approval) : null
      const res: DecideResult = {
        outcome: out.outcome,
        ...(after ? { approval: after } : {}),
        ...('message' in out ? { message: out.message } : {}),
        ...('methods' in out ? { methods: [...out.methods] } : {}),
        ...(out.outcome === 'approved' ? { execution: { outcome: out.execution.outcome, ...('message' in out.execution ? { message: out.execution.message } : {}) } } : {}),
      }
      const status = { approved: 200, refused: 200, not_found: 404, not_allowed: 403, expired: 409, already_decided: 409 }[out.outcome as string] ?? 400
      return json(res, status)
    }
    return null
  }

  // ------------------------------------------------------------ apps, memory, grants

  async function apps(req: Request, ctx: C, kind: string, rest: string[]): Promise<Response | null> {
    const src = o.apps!
    const me = ctx.principal.id
    if (kind === 'apps' && req.method === 'GET' && rest.length === 0) {
      const c = await src.connectedApps(me)
      return json({
        apps: c.apps.map(({ grantId, clientId, clientName, status, door, tenant, createdAt, expiresAt, lastUsedAt }) => ({ grantId, clientId, clientName, status, door, tenant, createdAt, expiresAt, lastUsedAt })),
        keys: c.keys.map(({ id, kind, name, door, tenant, createdAt, expiresAt, lastUsedAt, maxTier, tools }) => ({
          id,
          kind,
          name,
          door,
          tenant,
          createdAt,
          expiresAt,
          lastUsedAt,
          ...(maxTier ? { maxTier } : {}),
          ...(tools ? { tools } : {}),
        })),
      })
    }
    if (req.method === 'POST' && rest.length === 2 && rest[1] === 'revoke') {
      const ok = kind === 'apps' ? await src.revokeApp(me, rest[0]!) : await src.keys.revoke(me, rest[0]!)
      return json({ ok }, ok ? 200 : 404)
    }
    return null
  }

  async function memory(req: Request, ctx: C, rest: string[]): Promise<Response | null> {
    const m = o.memory!
    if (req.method === 'GET' && rest.length === 0) return json({ memories: (await m.list(ctx, { limit: 200 })).map(memoryItem) })
    if (req.method !== 'POST' || rest.length !== 2) return null
    const [id, verb] = rest as [string, string]
    if (verb === 'forget') {
      const ok = await m.forget(ctx, id)
      return json({ ok }, ok ? 200 : 404)
    }
    if (verb !== 'confirm' && verb !== 'reject') return null
    const r = verb === 'confirm' ? await m.confirm(ctx, id) : await m.reject(ctx, id)
    if (r.ok) return json({ ok: true, item: memoryItem(r.row) })
    return json({ ok: false, reason: r.reason }, r.reason === 'not_found' ? 404 : r.reason === 'already_decided' ? 409 : 403)
  }

  async function grantItem(g: StandingGrant, now: number): Promise<GrantItem> {
    const active = !g.revokedAt && Date.parse(g.expiresAt) > now
    return {
      id: g.id,
      capability: g.capability,
      title: titleOf(g.capability),
      grantedAt: g.grantedAt,
      expiresAt: g.expiresAt,
      dailyCap: g.dailyCap,
      revokedAt: g.revokedAt,
      left: active ? await o.grants!.left(g) : null,
      active,
    }
  }

  async function grants(req: Request, ctx: C, rest: string[]): Promise<Response | null> {
    const g = o.grants!
    const now = Date.now()
    if (req.method === 'GET' && rest.length === 0) {
      const list = await g.list(ctx)
      const capabilities = (o.registry?.list() ?? [])
        .filter((c) => c.risk === 'R2' && (!o.grantable || o.grantable.includes(c.name)))
        .map((c) => ({ name: c.name, title: c.title ?? c.name }))
      return json({ grants: await Promise.all(list.map((x) => grantItem(x, now))), options: { capabilities, maxDays: MAX_GRANT_DAYS, maxDailyCap: MAX_GRANT_DAILY_CAP } })
    }
    if (req.method === 'POST' && rest.length === 0) {
      const b = (await req.json().catch(() => null)) as { capability?: unknown; days?: unknown; dailyCap?: unknown } | null
      if (!b || typeof b.capability !== 'string' || typeof b.days !== 'number' || typeof b.dailyCap !== 'number') {
        return json({ ok: false, reason: 'bad_request', message: 'Give the capability, the days and the times a day.' }, 400)
      }
      if (o.grantable && !o.grantable.includes(b.capability)) return json({ ok: false, reason: 'unknown_capability', message: 'That change cannot be allowed here.' }, 400)
      const r = await g.set(ctx, { capability: b.capability, days: b.days, dailyCap: b.dailyCap })
      if (r.ok) return json({ ok: true, grant: await grantItem(r.grant, now) })
      return json(r, r.reason === 'not_a_person' ? 403 : 400)
    }
    if (req.method === 'POST' && rest.length === 2 && rest[1] === 'revoke') {
      const ok = await g.revoke(ctx, rest[0]!)
      return json({ ok }, ok ? 200 : 404)
    }
    return null
  }

  return {
    async handle(req, ctx, opts = {}) {
      const path = new URL(req.url).pathname
      if (!path.startsWith(`${base}/`)) return null
      let parts: string[]
      try {
        parts = path.slice(base.length + 1).split('/').map(decodeURIComponent)
      } catch {
        return null
      }
      if (parts.some((p) => !p || p.length > 200)) return null
      const [kind, ...rest] = parts as [string, ...string[]]
      if (req.method !== 'GET' && req.method !== 'POST') return null
      if (req.method === 'POST' && !(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        return fail(415, 'unsupported_media_type', 'Send JSON.')
      }
      try {
        if (kind === 'approvals' && o.approvals) return await approvals(req, ctx, rest, opts)
        if ((kind === 'apps' || kind === 'keys') && o.apps) return await apps(req, ctx, kind, rest)
        if (kind === 'memory' && o.memory) return await memory(req, ctx, rest)
        if (kind === 'grants' && o.grants) return await grants(req, ctx, rest)
        return null
      } catch (e) {
        onError(e, `${req.method} ${kind}`)
        return fail(500, 'error', 'This could not be done. Try again in a moment.')
      }
    },
  }
}
