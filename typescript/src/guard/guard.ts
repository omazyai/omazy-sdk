// The guard: one entry for every capability call. In order:
//
//   1. kill switches, deny first, no tenant value overrides a global off
//   2. rate limits
//   3. parse through the registry
//   4. tenant isolation, then the product's can()
//   5. the tier: the seat's ceiling and the product's read-only rules
//   6. R0 and R1 run; R1 results are masked
//   7. R2 needs a confirm token (minted and checked in one call when the
//      caller confirmed upstream)
//   8. R3 and R4 create an approval and return pending_approval
//   9. run
//  10. the request log, written after the response
//
// It never throws: every end is a typed outcome.

import type { AnyCapability, BaseCtx, Preview } from '../capabilities/capability.js'
import { modeOf, needsApproval, needsConfirm, type Tier, tierRank } from '../capabilities/tiers.js'
import { runAfter, type WaitUntil } from './background.js'
import { mintConfirmToken, readConfirmToken } from './confirm.js'
import { argsHash as hashArgs, canonicalJson, Keyring, randomToken } from './crypto.js'
import { memoryGuardStore } from './memory.js'
import { describePolicy, needsOwners, passesRule, tighten } from './policies.js'
import { firstOff, switchKeysFor } from './switches.js'
import { requestIdFrom, REQUEST_ID_HEADER } from './trace.js'
import type {
  AnonymousLogInput,
  ApprovalEvent,
  ApprovalRow,
  CallOptions,
  DecideInput,
  DecideOutcome,
  Guard,
  GuardOptions,
  GuardOutcome,
  GuardStore,
  HttpCallInit,
  HttpGuard,
  LogRequestInput,
  Outcome,
  PolicyRule,
  PreviewOkOutcome,
  PreviewOutcome,
  RefusalCode,
  RefusedOutcome,
  RequestRecord,
  StepUpVerifier,
  WithdrawOutcome,
} from './types.js'
import { SYSTEM_PRINCIPAL_KIND } from './types.js'

/**
 * Thrown by a capability's `preview` or `run` to end the call with a given
 * outcome, such as `stale` when a precondition no longer holds or
 * `read_only` when the target is frozen. Any other error ends as `error`.
 */
export class GuardRefusal extends Error {
  constructor(
    readonly outcome: RefusedOutcome['outcome'],
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message)
    this.name = 'GuardRefusal'
  }
}

const DEFAULT_SAMPLE: Record<string, number> = { 'tools/list': 10, initialize: 10 }

interface LogState {
  tool: string | null
  tier: Tier | null
  args: string | null
  argsHash: string | null
  approvalId: string | null
  /** Arguments dropped by `unknownFields: 'strip'`, written as the row's error code. */
  stripped: string[] | null
  /** Steps before the last one, each its own log row: the confirm of an upstream-confirmed write. */
  steps: { outcome: Outcome; at: number }[]
}

const HTTP_STATUS: Record<Outcome, number> = {
  ok: 200,
  confirm_required: 409,
  pending_approval: 202,
  refused_permission: 403,
  refused_tier: 403,
  read_only: 403,
  stale: 409,
  rate_limited: 429,
  invalid: 400,
  not_found: 404,
  switched_off: 503,
  error: 500,
  refused_auth: 401,
}

/** Values at a dotted path; `*` matches any key or index. */
function valuesAt(v: unknown, path: string[]): unknown[] {
  if (path.length === 0) return [v]
  if (v === null || typeof v !== 'object') return []
  const [head, ...rest] = path as [string, ...string[]]
  const o = v as Record<string, unknown>
  const keys = head === '*' ? Object.keys(o) : Object.prototype.hasOwnProperty.call(o, head) ? [head] : []
  return keys.flatMap((k) => valuesAt(o[k], rest))
}

export function createGuard<C extends BaseCtx = BaseCtx, P = unknown>(o: GuardOptions<C, P>): Guard<C> {
  const ephemeral = o.ephemeral === true
  if (!ephemeral && (!o.store || !o.secret)) throw new TypeError('createGuard needs a store and a secret, or ephemeral: true for a stateless door')
  // An ephemeral guard's key is random: its tokens are never meant to leave the call that minted them.
  const keys = new Keyring(ephemeral ? randomToken(32) : (o.secret as NonNullable<typeof o.secret>))
  // Approvals and challenges. An ephemeral guard never writes one, so an empty memory store answers its lookups.
  const store: GuardStore = ephemeral ? memoryGuardStore() : (o.store as GuardStore)
  const reg = o.registry
  const now = o.now ?? Date.now
  const onError = o.onError ?? ((err: unknown, where: string) => console.error(`guard ${where}:`, err))
  const policies = o.policies ?? {}
  const sample = o.sample ?? DEFAULT_SAMPLE
  const tenantFields = (o.tenantFields ?? ['tenant_id']).map((p) => p.split('.'))
  const verifiers: readonly StepUpVerifier<C>[] = o.stepUp === undefined ? [] : Array.isArray(o.stepUp) ? o.stepUp : [o.stepUp as StepUpVerifier<C>]
  const iso = (ms: number) => new Date(ms).toISOString()
  const seatKey = (ctx: BaseCtx) => ctx.seat?.id ?? `principal:${ctx.principal.id}`
  const wait = (opts?: { waitUntil?: WaitUntil }) => opts?.waitUntil ?? o.waitUntil

  // ------------------------------------------------------------ logging

  type Rest = Omit<RequestRecord, 'id' | 'at' | 'requestId' | 'door' | 'seat' | 'principalKind' | 'principalId' | 'tenant' | 'channel'>
  type Who = Pick<RequestRecord, 'requestId' | 'door' | 'seat' | 'principalKind' | 'principalId' | 'tenant' | 'channel'>

  function writeRecord(who: Who, rec: Rest, w: WaitUntil | undefined, at: number) {
    const log = o.log
    if (!log) return
    const record: RequestRecord = { id: `rq_${randomToken(12)}`, at: iso(at), ...who, ...rec }
    runAfter(() => log.write([record]), w, onError, 'request log')
  }

  function writeLog(ctx: BaseCtx, rec: Rest, w: WaitUntil | undefined, at: number) {
    writeRecord(
      {
        requestId: ctx.requestId,
        door: ctx.seat?.door ?? null,
        seat: ctx.seat?.id ?? null,
        principalKind: ctx.principal.kind,
        principalId: ctx.principal.id,
        tenant: ctx.tenant ?? null,
        channel: ctx.channel,
      },
      rec,
      w,
      at,
    )
  }

  function notify(event: ApprovalEvent<C>, w: WaitUntil | undefined) {
    const hook = o.onApproval
    if (hook) runAfter(async () => hook(event), w, onError, `approval ${event.type}`)
  }

  // ------------------------------------------------------------ checks

  async function crossTenant(ctx: C, cap: AnyCapability, input: unknown): Promise<boolean> {
    if (ctx.seat && (ctx.seat.tenant ?? null) !== (ctx.tenant ?? null)) return true
    const mine = ctx.seat?.tenant ?? null
    if (mine === null) return false
    for (const path of tenantFields) {
      for (const v of valuesAt(input, path)) if (v !== undefined && v !== null && v !== mine) return true
    }
    if (o.tenantsOf) for (const t of await o.tenantsOf(ctx, cap, input)) if (t !== mine) return true
    return false
  }

  async function switchedOff(ctx: C, name: string) {
    if (!o.switches || o.switchExempt?.includes(name)) return null
    const q = { keys: switchKeysFor(ctx.seat?.door ?? null, ctx.channel, name, o.switchKeys?.(ctx, name) ?? []), tenant: ctx.tenant ?? null, person: ctx.principal.id }
    return firstOff(await o.switches.read(q), q)
  }

  async function doorSwitch(door: string, ctx?: C) {
    if (!o.switches) return null
    const q = { keys: ['all', `door:${door}`], tenant: ctx?.tenant ?? null, person: ctx?.principal.id ?? null }
    return firstOff(await o.switches.read(q), q)
  }

  async function effectiveRule(policy: string | undefined, tenant: string | null): Promise<PolicyRule | null> {
    if (!policy) return null
    const base = policies[policy]
    if (!base) return null
    return tenant && o.tenantPolicy ? tighten(base, await o.tenantPolicy(tenant, policy)) : base
  }

  /** Whether `decider` may decide `row` now. Expiry and status are the caller's. */
  async function deciderCheck(row: ApprovalRow, decider: C, input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
    const cap = reg.get(row.action)
    if (!cap) return { ok: false, message: `${row.action} is no longer offered.` }
    if (decider.seat && (decider.seat.tenant ?? null) !== (decider.tenant ?? null)) return { ok: false, message: 'This seat does not belong to that tenant.' }
    if (decider.tenant != null && decider.tenant !== row.tenant) return { ok: false, message: 'This request belongs to another tenant.' }
    if (row.rule.fourEyes && decider.principal.id === row.requester.id) return { ok: false, message: 'Someone other than the requester must decide this.' }
    let roles: readonly string[] | undefined
    let owners: readonly string[] | undefined
    const ok = await passesRule(row.rule.approver, {
      deciderId: decider.principal.id,
      requesterId: row.requester.id,
      roles: async () => (roles ??= o.rolesOf ? await o.rolesOf(decider) : []),
      owners: async () => (owners ??= needsOwners(row.rule.approver) && o.recordOwner ? await o.recordOwner(decider, cap, input) : []),
    })
    return ok ? { ok: true } : { ok: false, message: `Only ${describePolicy(row.rule)} may decide this.` }
  }

  function storedCtx(who: 'requester' | 'decider', row: ApprovalRow): C {
    const principal = who === 'requester' ? row.requester : (row.decider ?? row.requester)
    const seatId = who === 'requester' ? row.seat : (row.deciderSeat ?? null)
    return {
      principal,
      seat: seatId ? { id: seatId, door: row.door ?? '', tenant: row.tenant } : null,
      tenant: row.tenant,
      channel: row.channel,
      approvalId: row.id,
      requestId: row.requestId,
    } as BaseCtx as C
  }

  async function restore(who: 'requester' | 'decider', row: ApprovalRow): Promise<C | null> {
    return o.restoreCtx ? o.restoreCtx(who, row) : storedCtx(who, row)
  }

  // ------------------------------------------------------------ outcomes

  const refuse = (requestId: string, outcome: RefusedOutcome['outcome'], code: RefusalCode, message: string, extra: Partial<RefusedOutcome> = {}): RefusedOutcome => ({
    outcome,
    code,
    message,
    requestId,
    ...extra,
  })

  function fromError(requestId: string, err: unknown, tier: Tier | undefined): RefusedOutcome {
    if (err instanceof GuardRefusal) return refuse(requestId, err.outcome, err.code, err.message, tier ? { tier } : {})
    onError(err, 'run')
    return refuse(requestId, 'error', 'run_failed', 'The action failed. Nothing was retried; try again or ask for help.', tier ? { tier } : {})
  }

  async function previewOf(cap: AnyCapability, ctx: C, input: unknown): Promise<Preview> {
    if (!cap.preview) return { summary: cap.title }
    return cap.preview(ctx, input)
  }

  // ------------------------------------------------------------ call

  async function call<O>(ctx: C, name: string, args: unknown, opts: CallOptions = {}): Promise<GuardOutcome<O>> {
    return logged(ctx, name, args, opts, 'tools/call', (st) => {
      // An ephemeral guard's nonces live for this call only.
      const nonces = ephemeral ? memoryGuardStore() : store
      return decideCall<O>(ctx, name, args, opts, st, nonces, false) as Promise<GuardOutcome<O>>
    })
  }

  async function preview(ctx: C, name: string, args: unknown, opts: CallOptions = {}): Promise<PreviewOutcome> {
    const only: CallOptions = { ...opts, confirmToken: undefined }
    return logged(ctx, name, args, only, 'tools/preview', (st) => decideCall(ctx, name, args, only, st, store, true) as Promise<PreviewOutcome>)
  }

  /** Runs one decision and writes its request log rows after the response. */
  async function logged<T extends GuardOutcome<unknown> | PreviewOutcome>(ctx: C, name: string, _args: unknown, opts: CallOptions, method: string, fn: (st: LogState) => Promise<T>): Promise<T> {
    const started = now()
    const st: LogState = { tool: name, tier: null, args: null, argsHash: null, approvalId: null, stripped: null, steps: [] }
    const out = await fn(st).catch((err) => fromError(ctx.requestId, err, st.tier ?? undefined) as T)
    const row = (outcome: Outcome, errorCode: string | null, at: number): Rest => ({
      clientId: opts.client?.id ?? null,
      clientName: opts.client?.name ?? null,
      clientVersion: opts.client?.version ?? null,
      method: opts.method ?? method,
      tool: st.tool,
      tier: st.tier,
      args: st.args,
      argsHash: st.argsHash,
      outcome,
      errorCode,
      approvalId: st.approvalId,
      ms: Math.max(0, at - started),
      country: opts.country ?? null,
      sampleRate: 1,
    })
    const stripped = st.stripped ? `stripped:${st.stripped.join(',')}`.slice(0, 200) : null
    for (const step of st.steps) writeLog(ctx, row(step.outcome, stripped, step.at), wait(opts), started)
    writeLog(ctx, row(out.outcome, 'code' in out ? out.code : stripped, now()), wait(opts), started)
    return out
  }

  async function decideCall<O>(ctx: C, name: string, args: unknown, opts: CallOptions, st: LogState, nonces: GuardStore, previewOnly: boolean): Promise<GuardOutcome<O> | PreviewOutcome> {
    const rid = ctx.requestId

    // 1. kill switches
    let off
    try {
      off = await switchedOff(ctx, name)
    } catch (err) {
      onError(err, 'switches')
      return refuse(rid, 'error', 'hook_failed', 'The switches could not be read, so nothing ran.')
    }
    if (off) {
      return refuse(rid, 'switched_off', 'switched_off', off.reason || 'This is switched off right now.', {
        switch: { key: off.key, scope: off.scope, subject: off.subject ?? null },
      })
    }

    // 2. rate limits, by the declared mode (an unknown name counts as a write). A preview runs nothing, so it is not counted.
    if (o.rateLimit && !previewOnly) {
      const r = await o.rateLimit.check({ seat: seatKey(ctx), tenant: ctx.tenant ?? null, mode: reg.mode(name), tool: name })
      if (!r.ok) return refuse(rid, 'rate_limited', 'rate_limited', 'Too many requests. Wait a moment and try again.', r.retryAfter ? { retryAfter: r.retryAfter } : {})
    }

    // 3. parse
    const parsed = await reg.parse(name, args)
    if (!parsed.ok) {
      if (parsed.reason === 'unknown_tool') {
        st.tool = null
        return refuse(rid, 'invalid', 'unknown_tool', `There is no tool called ${name}.`, { issues: parsed.issues })
      }
      st.tier = reg.tier(name)
      let message = parsed.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')
      if (parsed.capability.invalidMessage) {
        try {
          message = parsed.capability.invalidMessage(parsed.issues) || message
        } catch (err) {
          onError(err, 'invalidMessage')
        }
      }
      return refuse(rid, 'invalid', 'invalid_arguments', message, { issues: parsed.issues, tier: st.tier })
    }
    if (parsed.stripped) st.stripped = parsed.stripped
    const cap = parsed.capability
    const input = parsed.input
    const tier = parsed.tier
    st.tier = tier
    st.argsHash = await hashArgs(input)
    st.args = tier === 'R0' ? null : reg.logArgs(name, input)

    // 4. tenant isolation and permission
    if (await crossTenant(ctx, cap, input)) return refuse(rid, 'refused_permission', 'cross_tenant', 'That record belongs to another tenant.', { tier })
    if (!(await o.can(ctx, cap.permission as P, cap))) return refuse(rid, 'refused_permission', 'no_permission', 'You do not have permission to do this.', { tier })

    // 5. the tier: the seat's ceiling and the product's reach rules
    const max = o.maxTier?.(ctx)
    if (max && tierRank(tier) > tierRank(max)) return refuse(rid, 'refused_tier', 'tier_above_seat', `This key may act up to ${max}; this action is ${tier}.`, { tier })
    if (modeOf(tier) === 'write' && o.readOnly) {
      const ro = await o.readOnly(ctx, cap, input)
      if (ro) return refuse(rid, 'read_only', 'read_only', typeof ro === 'string' ? ro : 'This is read only from here.', { tier })
    }

    // A preview stops here: what the call would do, and the capability's preview.
    if (previewOnly) return previewEnd(ctx, cap, input, tier, opts.confirm === 'upstream')

    // 6. reads
    if (!needsConfirm(tier)) {
      const result = await cap.run(ctx, input)
      const shown = tier === 'R1' ? (o.mask ? o.mask(ctx, cap, result) : reg.redact(name, result)) : result
      return { outcome: 'ok', result: shown as O, requestId: rid, tier }
    }

    // 7. R2: a confirm token bound to the seat, tool, arguments and state
    const upstream = opts.confirm === 'upstream'
    if (!needsApproval(tier)) {
      if (ephemeral && !upstream) {
        return refuse(rid, 'refused_tier', 'confirm_unavailable', 'This door keeps no state between requests, so it cannot hold a confirmation for a later call. Only a caller that confirms with the person itself may make this change here.', { tier })
      }
      let token = opts.confirmToken
      if (!token) {
        const preview = await previewOf(cap, ctx, input)
        const t = await mintConfirmToken(
          keys,
          nonces,
          { seat: seatKey(ctx), tool: name, argsHash: st.argsHash, stateVersion: preview.stateVersion ?? '' },
          now(),
          o.confirmTtlMs,
        )
        if (!upstream) return { outcome: 'confirm_required', preview, token: t.token, expiresAt: iso(t.expiresAt), requestId: rid, tier }
        // The caller confirmed with the person already: check the token it would have sent back, now.
        st.steps.push({ outcome: 'confirm_required', at: now() })
        token = t.token
      }
      const check = await readConfirmToken(keys, token, { seat: seatKey(ctx), tool: name, argsHash: st.argsHash }, now())
      if (!check.ok) {
        const msg = {
          confirm_bad: 'That confirm token is not valid.',
          confirm_expired: 'That confirm token has expired. Ask again for a fresh preview.',
          confirm_mismatch: 'That confirm token was given for other arguments. Ask again for a fresh preview.',
        }[check.code]
        return refuse(rid, 'invalid', check.code, msg, { tier })
      }
      if (!(await nonces.takeNonce(check.claims.nonce, now()))) return refuse(rid, 'invalid', 'confirm_used', 'That confirm token was already used.', { tier })
      const fresh = await previewOf(cap, ctx, input)
      if ((fresh.stateVersion ?? '') !== check.claims.stateVersion) {
        return refuse(rid, 'stale', 'state_changed', 'The target changed since the preview. Look at the new preview and confirm again.', { tier })
      }
      const result = await cap.run(ctx, input)
      return { outcome: 'ok', result: result as O, requestId: rid, tier }
    }

    // 8. R3 and R4: hold for a person
    if (ephemeral) {
      return refuse(rid, 'refused_tier', 'no_approvals', `This door keeps no approvals, so an action at ${tier} cannot run here. Use a door whose guard has a store.`, { tier })
    }
    const rule = await effectiveRule(cap.approval, ctx.tenant ?? null)
    if (!rule) return refuse(rid, 'error', 'no_policy', `No approval policy called ${cap.approval ?? '(none)'} is configured, so nothing ran.`, { tier })
    if (!rule.stepUp.length) return refuse(rid, 'error', 'no_policy', `Policy ${cap.approval} asks for no step-up, so nothing ran.`, { tier })
    const preview = await previewOf(cap, ctx, input)
    const id = `apr_${randomToken(12)}`
    const at = now()
    const inp = input as Record<string, unknown> | null
    const targetGuess = ctx.tenant ?? (typeof inp?.tenant_id === 'string' ? inp.tenant_id : typeof inp?.id === 'string' ? inp.id : null)
    const row: ApprovalRow = {
      id,
      action: name,
      actionVersion: cap.version,
      tier,
      requester: { ...ctx.principal },
      seat: ctx.seat?.id ?? null,
      door: ctx.seat?.door ?? null,
      channel: ctx.channel,
      tenant: ctx.tenant ?? null,
      target: targetGuess,
      argsSealed: await keys.seal(canonicalJson(input), id),
      argsHash: st.argsHash,
      stateVersion: preview.stateVersion ?? null,
      preview,
      policy: cap.approval as string,
      rule,
      status: 'waiting',
      requestId: rid,
      createdAt: iso(at),
      expiresAt: iso(at + rule.expiresMs),
    }
    await store.insertApproval(row)
    st.approvalId = id
    notify({ type: 'requested', approval: row, ctx }, wait(opts))
    const reviewUrl = o.reviewUrl?.(row)
    return {
      outcome: 'pending_approval',
      approval: { id, policy: row.policy, decider: describePolicy(rule), expiresAt: row.expiresAt, preview, ...(reviewUrl ? { reviewUrl } : {}) },
      requestId: rid,
      tier,
    }
  }

  /** The end of a preview: the refusals `call` would give past the checks, else what it would do next. */
  async function previewEnd(ctx: C, cap: AnyCapability, input: unknown, tier: Tier, upstream: boolean): Promise<PreviewOutcome> {
    const rid = ctx.requestId
    let next: PreviewOkOutcome['next'] = 'run'
    let approval: PreviewOkOutcome['approval']
    if (needsApproval(tier)) {
      if (ephemeral) return refuse(rid, 'refused_tier', 'no_approvals', `This door keeps no approvals, so an action at ${tier} cannot run here. Use a door whose guard has a store.`, { tier })
      const rule = await effectiveRule(cap.approval, ctx.tenant ?? null)
      if (!rule || !rule.stepUp.length) return refuse(rid, 'error', 'no_policy', `No usable approval policy called ${cap.approval ?? '(none)'} is configured, so nothing would run.`, { tier })
      next = 'approval'
      approval = { policy: cap.approval as string, decider: describePolicy(rule) }
    } else if (needsConfirm(tier) && !upstream) {
      if (ephemeral) return refuse(rid, 'refused_tier', 'confirm_unavailable', 'This door keeps no state between requests, so it cannot hold a confirmation for a later call. Only a caller that confirms with the person itself may make this change here.', { tier })
      next = 'confirm'
    }
    const preview = await previewOf(cap, ctx, input)
    return { outcome: 'ok', tier, preview, next, ...(approval ? { approval } : {}), requestId: rid }
  }

  // ------------------------------------------------------------ approvals

  async function openArgs(row: ApprovalRow): Promise<unknown> {
    const plain = await keys.unseal(row.argsSealed, row.id)
    if ((await hashArgs(JSON.parse(plain))) !== row.argsHash) throw new Error(`approval ${row.id}: sealed arguments do not match their hash`)
    return JSON.parse(plain)
  }

  async function decide<O>(id: string, decider: C, d: DecideInput, opts: { waitUntil?: WaitUntil } = {}): Promise<DecideOutcome<O>> {
    const row = await store.getApproval(id)
    if (!row) return { outcome: 'not_found' }
    if (row.status === 'expired') return { outcome: 'expired', approval: row }
    if (row.status !== 'waiting') return { outcome: 'already_decided', approval: row }
    if (Date.parse(row.expiresAt) <= now()) {
      if (await store.updateApproval(id, 'waiting', { status: 'expired' })) notify({ type: 'expired', approval: { ...row, status: 'expired' } }, wait(opts))
      return { outcome: 'expired', approval: { ...row, status: 'expired' } }
    }
    const input = await openArgs(row)
    const may = await deciderCheck(row, decider, input)
    if (!may.ok) return { outcome: 'not_allowed', message: may.message }

    const decided = { decidedAt: iso(now()), decider: { ...decider.principal }, deciderSeat: decider.seat?.id ?? null }
    if (!d.approve) {
      const reason = d.reason?.trim()
      if (!reason) return { outcome: 'reason_required' }
      if (!(await store.updateApproval(id, 'waiting', { ...decided, status: 'refused', reason }))) {
        return { outcome: 'already_decided', approval: (await store.getApproval(id)) as ApprovalRow }
      }
      const done = (await store.getApproval(id)) as ApprovalRow
      notify({ type: 'decided', approval: done, ctx: decider }, wait(opts))
      return { outcome: 'refused', approval: done }
    }

    if (row.rule.typedTarget && (!d.typedTarget || d.typedTarget.trim() !== (row.target ?? ''))) return { outcome: 'typed_target_mismatch' }
    if (!row.rule.stepUp.length) return { outcome: 'not_allowed', message: 'This policy asks for no step-up, so it cannot be decided here.' }
    if (!d.proof) return { outcome: 'step_up_required', methods: row.rule.stepUp }
    if (!row.rule.stepUp.includes(d.proof.method)) return { outcome: 'step_up_failed', message: `Use ${row.rule.stepUp.join(' or ')} to verify.` }
    const v = verifiers.find((x) => x.methods.includes(d.proof!.method))
    if (!v) return { outcome: 'step_up_failed', message: `No verifier for ${d.proof.method} is set up.` }
    const proved = await v.verify(decider, d.proof, { approvalId: id, action: row.action, argsHash: row.argsHash, person: decider.principal.id })
    if (!proved.ok) return { outcome: 'step_up_failed', message: proved.reason }
    if (!row.rule.stepUp.includes(proved.method)) return { outcome: 'step_up_failed', message: `Use ${row.rule.stepUp.join(' or ')} to verify.` }

    if (!(await store.updateApproval(id, 'waiting', { ...decided, status: 'approved', verification: proved.method }))) {
      return { outcome: 'already_decided', approval: (await store.getApproval(id)) as ApprovalRow }
    }
    const approved = (await store.getApproval(id)) as ApprovalRow
    notify({ type: 'decided', approval: approved, ctx: decider }, wait(opts))
    const execution = await runApproved<O>(id, decider, opts)
    return { outcome: 'approved', approval: ((await store.getApproval(id)) as ApprovalRow) ?? approved, execution }
  }

  async function withdraw(id: string, ctx: C, why: string, opts: { waitUntil?: WaitUntil } = {}): Promise<WithdrawOutcome> {
    const at = now()
    const row = await store.getApproval(id)
    const log = (outcome: Outcome, code: string | null) =>
      writeLog(
        ctx,
        {
          clientId: null,
          clientName: null,
          clientVersion: null,
          method: 'approval/withdraw',
          tool: row?.action ?? null,
          tier: row?.tier ?? null,
          args: null,
          argsHash: row?.argsHash ?? null,
          outcome,
          errorCode: code,
          approvalId: id,
          ms: Math.max(0, now() - at),
          country: null,
          sampleRate: 1,
        },
        wait(opts),
        at,
      )
    if (!row) {
      log('not_found', 'not_found')
      return { outcome: 'not_found' }
    }
    const system = ctx.principal.kind === SYSTEM_PRINCIPAL_KIND
    const sameTenant = (ctx.tenant ?? null) === row.tenant && (!ctx.seat || (ctx.seat.tenant ?? null) === (ctx.tenant ?? null))
    const requester = ctx.principal.id === row.requester.id && ctx.principal.kind === row.requester.kind
    if (!(system ? ctx.tenant == null || sameTenant : requester && sameTenant)) {
      log('refused_permission', 'not_requester')
      return { outcome: 'not_allowed', message: 'Only the person who asked for this, or the system, may withdraw it.' }
    }
    const reason = typeof why === 'string' ? why.trim().slice(0, 500) : ''
    if (!reason) {
      log('invalid', 'reason_required')
      return { outcome: 'reason_required' }
    }
    if (row.status === 'expired') {
      log('invalid', 'expired')
      return { outcome: 'expired', approval: row }
    }
    if (row.status !== 'waiting') {
      log('invalid', 'already_decided')
      return { outcome: 'already_decided', approval: row }
    }
    if (Date.parse(row.expiresAt) <= at) {
      if (await store.updateApproval(id, 'waiting', { status: 'expired' })) notify({ type: 'expired', approval: { ...row, status: 'expired' } }, wait(opts))
      log('invalid', 'expired')
      return { outcome: 'expired', approval: { ...row, status: 'expired' } }
    }
    if (!(await store.updateApproval(id, 'waiting', { status: 'withdrawn', reason, decidedAt: iso(at) }))) {
      const cur = (await store.getApproval(id)) as ApprovalRow
      log('invalid', 'already_decided')
      return cur.status === 'expired' ? { outcome: 'expired', approval: cur } : { outcome: 'already_decided', approval: cur }
    }
    const done = (await store.getApproval(id)) as ApprovalRow
    log('ok', null)
    notify({ type: 'withdrawn', approval: done, ctx }, wait(opts))
    return { outcome: 'withdrawn', approval: done }
  }

  async function execute<O>(id: string, opts: { waitUntil?: WaitUntil } = {}): Promise<GuardOutcome<O>> {
    return runApproved<O>(id, undefined, opts)
  }

  async function runApproved<O>(id: string, deciderNow: C | undefined, opts: { waitUntil?: WaitUntil }): Promise<GuardOutcome<O>> {
    const started = now()
    const row = await store.getApproval(id)
    const rid = deciderNow?.requestId ?? row?.requestId ?? `req_${randomToken(12)}`
    if (!row) return refuse(rid, 'error', 'not_found', 'There is no such approval.')
    const tier = row.tier
    const finish = (out: GuardOutcome<O>, ctx: BaseCtx): GuardOutcome<O> => {
      writeLog(
        ctx,
        {
          clientId: null,
          clientName: null,
          clientVersion: null,
          method: 'approval/execute',
          tool: row.action,
          tier,
          args: null,
          argsHash: row.argsHash,
          outcome: out.outcome,
          errorCode: 'code' in out ? out.code : null,
          approvalId: id,
          ms: Math.max(0, now() - started),
          country: null,
          sampleRate: 1,
        },
        wait(opts),
        started,
      )
      return out
    }
    const base = storedCtx('requester', row)
    switch (row.status) {
      case 'executed':
        return { outcome: 'ok', result: row.result as O, approvalId: id, requestId: rid, tier }
      case 'stale':
        return refuse(rid, 'stale', 'state_changed', 'The target changed after the request. Ask again with a fresh preview.', { tier })
      case 'failed':
        return refuse(rid, 'error', row.error ?? 'run_failed', 'This approved request failed when it ran and is not retried.', { tier })
      case 'running':
        return refuse(rid, 'error', 'in_progress', 'This approved request is running.', { tier })
      case 'approved':
        break
      default:
        return refuse(rid, 'refused_permission', 'not_approved', 'This request has not been approved.', { tier })
    }

    const cap = reg.get(row.action)
    const requester = await restore('requester', row)
    const decider = deciderNow ?? (await restore('decider', row))
    const runCtx = requester ? ({ ...requester, approvalId: id, requestId: rid } as C) : null
    if (runCtx) {
      try {
        const off = await switchedOff(runCtx, row.action)
        if (off) return finish(refuse(rid, 'switched_off', 'switched_off', off.reason || 'This is switched off right now; it stays approved.', { tier }), runCtx)
      } catch (err) {
        onError(err, 'switches')
        return finish(refuse(rid, 'error', 'hook_failed', 'The switches could not be read, so nothing ran.', { tier }), runCtx)
      }
    }
    if (!(await store.updateApproval(id, 'approved', { status: 'running' }))) return runApproved<O>(id, deciderNow, opts)

    const fail = async (status: 'failed' | 'stale', out: RefusedOutcome): Promise<GuardOutcome<O>> => {
      if (await store.updateApproval(id, 'running', { status, error: out.code, executedAt: iso(now()) })) {
        const ended = await store.getApproval(id)
        if (ended) notify({ type: status, approval: ended }, wait(opts))
      }
      return finish(out, runCtx ?? base)
    }
    try {
      if (!cap) return await fail('failed', refuse(rid, 'error', 'unknown_tool', `${row.action} is no longer offered.`, { tier }))
      if (!runCtx || !decider) return await fail('failed', refuse(rid, 'refused_permission', 'person_gone', 'The requester or the decider no longer has a seat.', { tier }))
      const input = await openArgs(row)
      // Both people, as of now.
      if (!(await o.can(runCtx, cap.permission as P, cap))) {
        return await fail('failed', refuse(rid, 'refused_permission', 'no_permission', 'The requester no longer has permission to do this.', { tier }))
      }
      const still = await deciderCheck(row, decider, input)
      if (!still.ok) return await fail('failed', refuse(rid, 'refused_permission', 'decider_not_allowed', still.message, { tier }))
      if (await crossTenant(runCtx, cap, input)) return await fail('failed', refuse(rid, 'refused_permission', 'cross_tenant', 'That record belongs to another tenant.', { tier }))
      if (o.readOnly) {
        const ro = await o.readOnly(runCtx, cap, input)
        if (ro) return await fail('failed', refuse(rid, 'read_only', 'read_only', typeof ro === 'string' ? ro : 'This is read only from here.', { tier }))
      }
      const fresh = await previewOf(cap, runCtx, input)
      if ((fresh.stateVersion ?? null) !== (row.stateVersion ?? null)) {
        return await fail('stale', refuse(rid, 'stale', 'state_changed', 'The target changed after the request, so the approved preview is out of date. Ask again.', { tier }))
      }
      // The stored arguments, and only those.
      const result = await cap.run(runCtx, input)
      const auditId = result && typeof result === 'object' && typeof (result as { auditId?: unknown }).auditId === 'string' ? (result as { auditId: string }).auditId : null
      await store.updateApproval(id, 'running', { status: 'executed', result: result ?? null, executedAt: iso(now()), auditId })
      const done = await store.getApproval(id)
      if (done) notify({ type: 'executed', approval: done }, wait(opts))
      return finish({ outcome: 'ok', result: result as O, approvalId: id, requestId: rid, tier }, runCtx)
    } catch (err) {
      const out = fromError(rid, err, tier)
      return await fail(out.outcome === 'stale' ? 'stale' : 'failed', out)
    }
  }

  // ------------------------------------------------------------ the rest

  function logRequest(ctx: C, input: LogRequestInput, opts: { waitUntil?: WaitUntil } = {}) {
    const outcome: Outcome = input.outcome ?? 'ok'
    const n = Math.max(1, Math.floor(sample[input.method] ?? 1))
    if (n > 1 && outcome === 'ok' && Math.random() * n >= 1) return
    const at = now()
    writeLog(
      ctx,
      {
        clientId: input.client?.id ?? null,
        clientName: input.client?.name ?? null,
        clientVersion: input.client?.version ?? null,
        method: input.method,
        tool: input.tool ?? null,
        tier: null,
        args: null,
        argsHash: null,
        outcome,
        errorCode: input.errorCode ?? null,
        approvalId: null,
        ms: Math.max(0, input.ms ?? 0),
        country: input.country ?? null,
        sampleRate: outcome === 'ok' ? n : 1,
      },
      wait(opts),
      at,
    )
  }

  function logAnonymous(input: AnonymousLogInput, opts: { waitUntil?: WaitUntil } = {}) {
    const at = now()
    writeRecord(
      { requestId: input.requestId, door: input.door ?? null, seat: null, principalKind: null, principalId: null, tenant: null, channel: input.channel ?? 'mcp' },
      {
        clientId: input.client?.id ?? null,
        clientName: input.client?.name ?? null,
        clientVersion: input.client?.version ?? null,
        method: input.method,
        tool: null,
        tier: null,
        args: null,
        argsHash: null,
        outcome: input.outcome ?? 'refused_auth',
        errorCode: input.errorCode ?? null,
        approvalId: null,
        ms: Math.max(0, input.ms ?? 0),
        country: input.country ?? null,
        sampleRate: 1,
      },
      wait(opts),
      at,
    )
  }

  function http(req: Request, init: HttpCallInit<C>): HttpGuard<C> {
    const requestId = requestIdFrom(req)
    const seat = init.seat ?? null
    const base: BaseCtx = {
      principal: init.principal,
      seat,
      tenant: init.tenant !== undefined ? init.tenant : (seat?.tenant ?? null),
      channel: init.channel ?? 'rest',
      approvalId: null,
      requestId,
    }
    const ctx = init.ctx ? init.ctx(base) : (base as C)
    const method = `${req.method} ${new URL(req.url).pathname}`.slice(0, 128)
    const country = ((req as unknown as { cf?: { country?: string } }).cf?.country ?? null) as string | null
    return {
      ctx,
      requestId,
      headers: { [REQUEST_ID_HEADER]: requestId },
      call: (name, args, opts = {}) =>
        call(ctx, name, args, {
          method,
          country,
          ...(init.waitUntil ? { waitUntil: init.waitUntil } : {}),
          ...(init.client ? { client: init.client } : {}),
          ...(init.confirm ? { confirm: init.confirm } : {}),
          ...opts,
        }),
      status: (out) => HTTP_STATUS[out.outcome] ?? 500,
    }
  }

  return {
    call,
    preview,
    http,
    logAnonymous,
    decide,
    withdraw,
    execute,
    approval: (id) => store.getApproval(id),
    async approvalArgs(id) {
      const row = await store.getApproval(id)
      if (!row) return null
      return openArgs(row)
    },
    async canDecide(id, decider) {
      const row = await store.getApproval(id)
      if (!row) return { ok: false, message: 'There is no such approval.' }
      if (row.status !== 'waiting') return { ok: false, message: `This request is ${row.status}.` }
      if (Date.parse(row.expiresAt) <= now()) return { ok: false, message: 'This request has expired.' }
      return deciderCheck(row, decider, await openArgs(row))
    },
    expireDue: () => store.expireApprovals(now()),
    logRequest,
    doorSwitch,
    policyFor: (policy, tenant) => effectiveRule(policy, tenant),
  }
}
