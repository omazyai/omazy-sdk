// The guard kit's types: what a call returns, what the product plugs in, and
// the rows the stores keep. Everything here is generic over the product's
// own ctx; the guard reads only the BaseCtx fields.

import type { AnyCapability, BaseCtx, Channel, Preview, Principal, Seat } from '../capabilities/capability.js'
import type { Registry } from '../capabilities/registry.js'
import type { Tier } from '../capabilities/tiers.js'

// ---------------------------------------------------------------- outcomes

/** Every way a call can end. The same strings are written to the request log. */
export type Outcome =
  | 'ok'
  | 'refused_permission'
  | 'refused_tier'
  | 'read_only'
  | 'pending_approval'
  | 'confirm_required'
  | 'stale'
  | 'rate_limited'
  | 'invalid'
  /** A lookup found nothing: the arguments were fine, the record is not there. */
  | 'not_found'
  | 'switched_off'
  | 'error'
  /** Only in the request log: a request refused before it had a principal (no token, or a token for another door). */
  | 'refused_auth'

export const OUTCOMES: readonly Outcome[] = [
  'ok',
  'refused_permission',
  'refused_tier',
  'read_only',
  'pending_approval',
  'confirm_required',
  'stale',
  'rate_limited',
  'invalid',
  'not_found',
  'switched_off',
  'error',
  'refused_auth',
]

interface OutcomeBase {
  requestId: string
  /** The tier of this call, when the tool was found. */
  tier?: Tier
}

export interface OkOutcome<O = unknown> extends OutcomeBase {
  outcome: 'ok'
  result: O
  /** Set when the call ran on a decided approval. */
  approvalId?: string
}

export interface ConfirmRequiredOutcome extends OutcomeBase {
  outcome: 'confirm_required'
  preview: Preview
  /** Send it back, with the same arguments, as `confirmToken`. Single use. */
  token: string
  /** ISO time the token stops working. */
  expiresAt: string
}

export interface PendingApprovalOutcome extends OutcomeBase {
  outcome: 'pending_approval'
  approval: {
    id: string
    policy: string
    /** Who may decide, in words, for the person or model reading the result. */
    decider: string
    expiresAt: string
    preview: Preview
    /** From `reviewUrl`, when the product gives one. */
    reviewUrl?: string
  }
}

/** Machine codes beside a refusal, for clients and the request log. */
export type RefusalCode =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'confirm_mismatch'
  | 'confirm_used'
  | 'confirm_expired'
  | 'confirm_bad'
  | 'cross_tenant'
  | 'no_permission'
  | 'tier_above_seat'
  | 'read_only'
  | 'state_changed'
  | 'rate_limited'
  | 'switched_off'
  | 'no_policy'
  | 'hook_failed'
  | 'run_failed'
  | (string & {})

export interface RefusedOutcome extends OutcomeBase {
  outcome: Exclude<Outcome, 'ok' | 'confirm_required' | 'pending_approval' | 'refused_auth'>
  code: RefusalCode
  /** One plain sentence a person or a model can act on. */
  message: string
  /** Validation issues, for `invalid`. */
  issues?: { message: string; path: string }[]
  /** Seconds, for `rate_limited`. */
  retryAfter?: number
  /** The switch that stopped the call, for `switched_off`. */
  switch?: { key: string; scope: SwitchScope; subject: string | null }
}

export type GuardOutcome<O = unknown> = OkOutcome<O> | ConfirmRequiredOutcome | PendingApprovalOutcome | RefusedOutcome

/** What `guard.preview` found: the call would pass every check up to running, and what it would do. */
export interface PreviewOkOutcome extends OutcomeBase {
  outcome: 'ok'
  tier: Tier
  /** The capability's preview, or its title when it has none. */
  preview: Preview
  /** What `guard.call` would do next: run it (R0, R1, or R2 confirmed upstream), ask for a confirm (R2) or hold it for an approval (R3, R4). */
  next: 'run' | 'confirm' | 'approval'
  /** For `approval`: the policy, and who may decide, in words. */
  approval?: { policy: string; decider: string }
}

export type PreviewOutcome = PreviewOkOutcome | RefusedOutcome

// ---------------------------------------------------------------- kill switches

/** Global, then per tenant, then per person. */
export type SwitchScope = 'global' | 'tenant' | 'person'

/**
 * One switch value. `key` is the product's name for what it stops; the guard
 * asks for these keys on every call, in this order:
 *
 * - `all`: everything through the guard
 * - `door:<seat.door>`: one door, such as `door:platform`
 * - `unit:<ctx.channel>`: one kind of caller, such as `unit:copilot`
 * - `tool:<name>`: one capability
 * - whatever `switchKeys(ctx, name)` adds, such as `ai.off`
 *
 * Each key is read at global scope, then for the call's tenant, then for its
 * person. Only `on: false` matters: a switch that is on never overrides one
 * that is off, so a tenant cannot turn back on what is off globally.
 */
export interface SwitchRow {
  key: string
  scope: SwitchScope
  /** The tenant or person id; null at global scope. */
  subject: string | null
  on: boolean
  /** Shown in the refusal. */
  reason?: string | null
  updatedAt?: string
  updatedBy?: string | null
}

export interface SwitchQuery {
  keys: readonly string[]
  tenant: string | null
  person: string | null
}

/** Read once per guard call, all keys in one read. `d1Switches` can cache for `cacheMs`. */
export interface SwitchStore {
  /** Every row for these keys at global scope, for the tenant and for the person. */
  read(q: SwitchQuery): Promise<SwitchRow[]>
  set(row: SwitchRow): Promise<void>
  list(): Promise<SwitchRow[]>
}

// ---------------------------------------------------------------- rate limits

export interface RateRequest {
  seat: string
  tenant: string | null
  mode: 'read' | 'write'
  tool: string
}

export type RateDecision = { ok: true } | { ok: false; retryAfter?: number; limit: string }

export interface RateLimiter {
  check(req: RateRequest): Promise<RateDecision>
}

// ---------------------------------------------------------------- policies

/** Who may decide. Data, so a tenant's tighter policy can be joined to the base. */
export type ApproverRule =
  /** The request's author or a record owner (from `recordOwner`), optionally holding one of `roles`. */
  | { kind: 'author_or_record_owner'; roles?: readonly string[] }
  /** Anyone holding one of `roles` (from `rolesOf`). */
  | { kind: 'role'; roles: readonly string[] }
  /** Every rule must hold. What a tightened policy becomes. */
  | { kind: 'all'; rules: readonly ApproverRule[] }

export interface PolicyRule {
  approver: ApproverRule
  /** The decider must not be the requester. */
  fourEyes: boolean
  /**
   * Step-up methods that may prove the decider, in the product's names, such
   * as `code`, `two_channel`, `passkey`. Empty means none is asked; the kit's
   * policy helpers always ask for one.
   */
  stepUp: readonly string[]
  /** Milliseconds the request stays decidable. */
  expiresMs: number
  /** The decider types the target (the tenant id) to confirm it. */
  typedTarget: boolean
  /** Words for "who decides", shown on `pending_approval`. Defaults from the rule. */
  label?: string
}

export type PolicyTable = Record<string, PolicyRule>

// ---------------------------------------------------------------- approvals

/** `withdrawn`: its requester, or the system, took it back while it waited. It never runs. */
export type ApprovalStatus = 'waiting' | 'approved' | 'refused' | 'expired' | 'running' | 'executed' | 'failed' | 'stale' | 'withdrawn'

/** The principal kind that may withdraw any waiting approval in its tenant (or any tenant, with a null tenant): the product's own code, never a person. */
export const SYSTEM_PRINCIPAL_KIND = 'system'

export interface ApprovalRow {
  id: string
  /** The capability name. */
  action: string
  actionVersion: number
  tier: Tier
  requester: Principal
  seat: string | null
  door: string | null
  channel: string
  tenant: string | null
  /** What `typedTarget` compares against: the tenant, or the arguments' `tenant_id` or `id`. */
  target: string | null
  /** AES-GCM over the canonical arguments, bound to the approval id. */
  argsSealed: string
  /** SHA-256 of the canonical arguments, hex. */
  argsHash: string
  stateVersion: string | null
  preview: Preview
  policy: string
  /** The effective rule at request time, after any tenant tightening. */
  rule: PolicyRule
  status: ApprovalStatus
  requestId: string
  createdAt: string
  expiresAt: string
  decidedAt?: string | null
  decider?: Principal | null
  deciderSeat?: string | null
  /** The step-up method that proved the decider. */
  verification?: string | null
  /** Required on a refusal and on a withdrawal. */
  reason?: string | null
  executedAt?: string | null
  result?: unknown
  error?: string | null
  /** The product's audit row id, when `run` returns one through `auditId`. */
  auditId?: string | null
}

export interface ApprovalQuery {
  tenant?: string | null
  status?: ApprovalStatus
  limit?: number
}

// ---------------------------------------------------------------- step-up

export interface StepUpProof {
  /** The method the decider used, such as `code` or `passkey`. */
  method: string
  /** For codes: channel name to code. */
  codes?: Record<string, string>
  /** For passkeys: the WebAuthn assertion, as the product's verifier reads it. */
  assertion?: unknown
  [extra: string]: unknown
}

/** What a step-up is bound to, so a proof for one approval cannot decide another. */
export interface StepUpBinding {
  approvalId: string
  action: string
  argsHash: string
  person: string
}

export type StepUpResult = { ok: true; method: string } | { ok: false; reason: string }

export interface StepUpVerifier<C extends BaseCtx = BaseCtx> {
  /** The method names this verifier proves. */
  readonly methods: readonly string[]
  verify(ctx: C, proof: StepUpProof, binding: StepUpBinding): Promise<StepUpResult>
}

/** One-time code challenge, as the code verifier stores it (only the hash of the code). */
export interface ChallengeRow {
  id: string
  approvalId: string
  person: string
  channel: string
  codeHash: string
  expiresAt: number
  attempts: number
}

// ---------------------------------------------------------------- store

/** Confirm nonces, approvals and step-up challenges. */
export interface GuardStore {
  /** Keeps a confirm nonce until `expiresAt` (epoch ms). */
  putNonce(nonce: string, expiresAt: number): Promise<void>
  /** Deletes the nonce and says whether it was there and unexpired. Atomic: true at most once. */
  takeNonce(nonce: string, now: number): Promise<boolean>

  insertApproval(row: ApprovalRow): Promise<void>
  getApproval(id: string): Promise<ApprovalRow | null>
  /** Compare-and-swap on status: applies `patch` only while the row is `from`. */
  updateApproval(id: string, from: ApprovalStatus, patch: Partial<ApprovalRow>): Promise<boolean>
  listApprovals(q?: ApprovalQuery): Promise<ApprovalRow[]>
  /** Marks every `waiting` row past its expiry `expired`, returns how many. */
  expireApprovals(now: number): Promise<number>

  putChallenge(row: ChallengeRow): Promise<void>
  getChallenge(id: string): Promise<ChallengeRow | null>
  /** Adds one attempt and returns the new count. */
  bumpChallenge(id: string): Promise<number>
  deleteChallenge(id: string): Promise<void>
}

// ---------------------------------------------------------------- request log

/** One row per request: RFC-0901's `mcp_requests`, for any door or channel. */
export interface RequestRecord {
  id: string
  at: string
  requestId: string
  door: string | null
  seat: string | null
  /** Null on a request refused before it had a principal (`logAnonymous`). */
  principalKind: string | null
  principalId: string | null
  tenant: string | null
  channel: string
  clientId: string | null
  clientName: string | null
  clientVersion: string | null
  /** `tools/call`, `tools/list`, `initialize`, or the product's own. */
  method: string
  tool: string | null
  tier: Tier | null
  /** Redacted through `registry.logArgs`, 4 KB cap. Null for R0 and for listings. */
  args: string | null
  argsHash: string | null
  outcome: Outcome
  errorCode: string | null
  approvalId: string | null
  ms: number
  country: string | null
  /** 1 for every row; 10 when one in ten was kept. Multiply counts by it. */
  sampleRate: number
}

export interface RequestLogSink {
  write(records: readonly RequestRecord[]): Promise<void>
}

// ---------------------------------------------------------------- guard options

export interface ClientInfo {
  id?: string | null
  name?: string | null
  version?: string | null
}

export interface CallOptions {
  /** From a `confirm_required` result, with the same arguments. */
  confirmToken?: string
  /** The request's `waitUntil`, so the log and notices run after the response. */
  waitUntil?: (p: Promise<unknown>) => void
  client?: ClientInfo
  country?: string | null
  /** Defaults to `tools/call`. */
  method?: string
  /**
   * `upstream`: the caller has already confirmed this change with the person
   * (Omazy's agent with `write_mode: 'confirm'`, a form the person
   * submitted). An R2 call then runs in one step: the guard still mints and
   * checks its confirm token, refuses a stale preview and logs both steps.
   * R3 and above are unchanged: they still wait for an approval.
   */
  confirm?: 'upstream'
}

export interface LogRequestInput {
  method: string
  outcome?: Outcome
  ms?: number
  tool?: string | null
  client?: ClientInfo
  country?: string | null
  errorCode?: string | null
}

/** A request with no principal or seat, such as a missing token or a token for another door. */
export interface AnonymousLogInput {
  door: string | null
  method: string
  /** Default `refused_auth`. */
  outcome?: Outcome
  requestId: string
  /** Default `mcp`. */
  channel?: string
  client?: ClientInfo
  country?: string | null
  errorCode?: string | null
  ms?: number
}

export type ApprovalEvent<C extends BaseCtx = BaseCtx> =
  | { type: 'requested'; approval: ApprovalRow; ctx: C }
  | { type: 'decided'; approval: ApprovalRow; ctx: C }
  | { type: 'executed'; approval: ApprovalRow }
  /** The approved change ran and failed, or a check at execution refused it (`approval.error` holds the code). Not retried. */
  | { type: 'failed'; approval: ApprovalRow }
  /** The target changed after the request, so the approved change did not run. */
  | { type: 'stale'; approval: ApprovalRow }
  | { type: 'expired'; approval: ApprovalRow }
  /** The requester, or the system, took it back before anyone decided. `ctx` is who withdrew it. */
  | { type: 'withdrawn'; approval: ApprovalRow; ctx: C }

/** A guard that keeps confirm nonces and approvals in a store, keyed by a secret. */
export interface PersistentGuardOptions {
  ephemeral?: false
  /**
   * HMAC and sealing secret, at least 32 characters. `previous` secrets are
   * still accepted for tokens and sealed arguments while a new one rolls out.
   */
  secret: string | { current: string; previous?: readonly string[] }
  store: GuardStore
}

/**
 * A guard for a stateless door: no store and no secret. Confirm nonces live
 * in memory for one call and the key is random, so only an R2 call confirmed
 * upstream (`confirm: 'upstream'`) can run. An R2 call confirmed by the
 * client, and anything at R3 or above, is refused `refused_tier`.
 */
export interface EphemeralGuardOptions {
  ephemeral: true
  secret?: undefined
  store?: undefined
}

export type GuardOptions<C extends BaseCtx = BaseCtx, P = unknown> = GuardBaseOptions<C, P> & (PersistentGuardOptions | EphemeralGuardOptions)

export interface GuardBaseOptions<C extends BaseCtx = BaseCtx, P = unknown> {
  registry: Registry<C, P, any>
  /** The product's permission check, live on every call and again at execution. */
  can: (ctx: C, permission: P, capability: AnyCapability) => boolean | Promise<boolean>
  /** Policy names used by capabilities, as `policies.single(...)` and `policies.fourEyes(...)` build them. */
  policies?: PolicyTable
  /**
   * A tenant's own rule for a policy. It is joined to the base so it can only
   * tighten: four eyes and typed target are or-ed, expiry is the shorter, the
   * step-up methods are those both accept, and the decider must pass both rules.
   */
  tenantPolicy?: (tenant: string, policy: string) => PolicyRule | null | undefined | Promise<PolicyRule | null | undefined>
  /** Principal ids that own the target record, for `author_or_record_owner`. */
  recordOwner?: (ctx: C, capability: AnyCapability, input: unknown) => readonly string[] | Promise<readonly string[]>
  /** The decider's roles, for `role` rules. Read in the decider's seat. */
  rolesOf?: (ctx: C) => readonly string[] | Promise<readonly string[]>
  /** Proves the decider. Needed for any policy that asks for step-up. */
  stepUp?: StepUpVerifier<C> | readonly StepUpVerifier<C>[]
  /**
   * Rebuilds a person's ctx from an approval row as of now, for execution
   * after the request is gone. Return null when the person or seat no longer
   * exists. Required when the product's ctx carries more than BaseCtx.
   */
  restoreCtx?: (who: 'requester' | 'decider', approval: ApprovalRow) => C | null | Promise<C | null>
  switches?: SwitchStore
  /** More switch keys for a call, such as `ai.off` for every AI channel. */
  switchKeys?: (ctx: C, name: string) => readonly string[]
  /** Capabilities switches never stop, so the switch tool itself can turn things back on. */
  switchExempt?: readonly string[]
  rateLimit?: RateLimiter
  /** The highest tier this seat may call, such as R2 for a personal key. */
  maxTier?: (ctx: C) => Tier | null | undefined
  /** The product's reach rules: a write here is refused `read_only` when this says so. */
  readOnly?: (ctx: C, capability: AnyCapability, input: unknown) => boolean | string | Promise<boolean | string>
  /** Argument paths that hold a tenant id. Default `['tenant_id']`. */
  tenantFields?: readonly string[]
  /** Tenants of the records the arguments name (device ids, staff ids). Any other than the seat's is refused. */
  tenantsOf?: (ctx: C, capability: AnyCapability, input: unknown) => readonly string[] | Promise<readonly string[]>
  /** Masks an R1 result. Default: `registry.redact`, the capability's `pii` fields. */
  mask?: (ctx: C, capability: AnyCapability, result: unknown) => unknown
  log?: RequestLogSink
  /** One in N kept for these methods. Default `{ 'tools/list': 10, initialize: 10 }`. */
  sample?: Record<string, number>
  onApproval?: (event: ApprovalEvent<C>) => void | Promise<void>
  /** A link a person opens to decide. */
  reviewUrl?: (approval: ApprovalRow) => string | undefined
  /** Used when a call gives no `waitUntil`. Without either, background work is started and not awaited. */
  waitUntil?: (p: Promise<unknown>) => void
  /** Milliseconds a confirm token lives. Default 10 minutes. */
  confirmTtlMs?: number
  /** For tests. */
  now?: () => number
  /** Called with errors from background work (log, notices). Default: console.error. */
  onError?: (err: unknown, where: string) => void
}

export interface DecideInput {
  approve: boolean
  /** Required when the policy asks for step-up. */
  proof?: StepUpProof
  /** Required on a refusal. */
  reason?: string
  /** Required when the policy asks for a typed target. */
  typedTarget?: string
}

export type DecideOutcome<O = unknown> =
  | { outcome: 'approved'; approval: ApprovalRow; execution: GuardOutcome<O> }
  | { outcome: 'refused'; approval: ApprovalRow }
  | { outcome: 'not_found' }
  | { outcome: 'expired'; approval: ApprovalRow }
  | { outcome: 'already_decided'; approval: ApprovalRow }
  | { outcome: 'not_allowed'; message: string }
  | { outcome: 'step_up_required'; methods: readonly string[] }
  | { outcome: 'step_up_failed'; message: string }
  | { outcome: 'reason_required' }
  | { outcome: 'typed_target_mismatch' }

export type WithdrawOutcome =
  | { outcome: 'withdrawn'; approval: ApprovalRow }
  | { outcome: 'not_found' }
  /** Only its requester, or a principal of kind `system`, may withdraw it. */
  | { outcome: 'not_allowed'; message: string }
  | { outcome: 'reason_required' }
  /** Decided, run, or withdrawn already: only a waiting approval is withdrawn. */
  | { outcome: 'already_decided'; approval: ApprovalRow }
  | { outcome: 'expired'; approval: ApprovalRow }

/** What a route that is not MCP gives `guard.http` to make its ctx. */
export interface HttpCallInit<C extends BaseCtx = BaseCtx> {
  principal: Principal
  seat?: Seat | null
  /** Default `rest`. */
  channel?: Channel
  /** Default: the seat's tenant, or null. */
  tenant?: string | null
  /** Every call through this helper is confirmed upstream (see `CallOptions.confirm`). */
  confirm?: 'upstream'
  waitUntil?: (p: Promise<unknown>) => void
  client?: ClientInfo
  /** Adds the product's own fields to the base ctx. Required when the product's ctx has more than BaseCtx. */
  ctx?: (base: BaseCtx) => C
}

/** One HTTP request's way into the guard. */
export interface HttpGuard<C extends BaseCtx = BaseCtx> {
  ctx: C
  /** From `X-Omazy-Request-Id`, or a new one. */
  requestId: string
  /** `guard.call` with this request's ctx, method (`POST /path`), country and `waitUntil`. */
  call<O = unknown>(name: string, args: unknown, opts?: Pick<CallOptions, 'confirmToken' | 'confirm' | 'method'>): Promise<GuardOutcome<O>>
  /** An HTTP status for an outcome: 200, 202, 400, 403, 404, 409, 429, 500 or 503. */
  status(out: GuardOutcome): number
  /** `X-Omazy-Request-Id`, to put on the response. */
  headers: Record<string, string>
}

export interface Guard<C extends BaseCtx = BaseCtx> {
  /** Switches, rate limit, parse, permission, tier, then run, confirm or hold for approval. Never throws. */
  call<O = unknown>(ctx: C, name: string, args: unknown, opts?: CallOptions): Promise<GuardOutcome<O>>
  /**
   * The checks of `call` (switches, parse, tenant, permission, tier and the
   * product's read-only rules), then the capability's preview. Never runs
   * the capability, mints no token and asks for no approval. Not rate
   * limited. Logged with method `tools/preview`. For a dry run. Never throws.
   */
  preview(ctx: C, name: string, args: unknown, opts?: Pick<CallOptions, 'confirm' | 'waitUntil' | 'client' | 'country' | 'method'>): Promise<PreviewOutcome>
  /** Decides a waiting approval, and on approve runs it at once. */
  decide<O = unknown>(approvalId: string, decider: C, input: DecideInput, opts?: Pick<CallOptions, 'waitUntil'>): Promise<DecideOutcome<O>>
  /**
   * Takes back a waiting approval, so nobody can approve it and it never
   * runs: a compare-and-swap from `waiting` to `withdrawn`. Only its
   * requester (same principal, same tenant) or a principal of kind `system`
   * may. The reason is required and kept on the row. Logged with method
   * `approval/withdraw`, and `onApproval` gets a `withdrawn` event.
   */
  withdraw(approvalId: string, ctx: C, reason: string, opts?: Pick<CallOptions, 'waitUntil'>): Promise<WithdrawOutcome>
  /** Runs an approved request, or returns the stored result of one already run. Idempotent on the id. */
  execute<O = unknown>(approvalId: string, opts?: Pick<CallOptions, 'waitUntil'>): Promise<GuardOutcome<O>>
  /** The approval row, with the arguments still sealed. */
  approval(id: string): Promise<ApprovalRow | null>
  /** The stored arguments of an approval, for its review page. */
  approvalArgs(id: string): Promise<unknown>
  /** Who may decide this approval right now: checks the rule, without step-up. */
  canDecide(approvalId: string, decider: C): Promise<{ ok: true } | { ok: false; message: string }>
  /** Marks waiting approvals past expiry `expired`. For a cron. */
  expireDue(): Promise<number>
  /** A row for a request that is not a tool call (`tools/list`, `initialize`), sampled. */
  logRequest(ctx: C, input: LogRequestInput, opts?: Pick<CallOptions, 'waitUntil'>): void
  /** A row for a request refused before it had a principal: no token, a bad token, a token for another door. Never sampled. */
  logAnonymous(input: AnonymousLogInput, opts?: Pick<CallOptions, 'waitUntil'>): void
  /**
   * The first `all` or `door:<door>` switch that is off: at global scope, and
   * with a ctx also for its tenant and person. Null when the door is on or
   * there are no switches. Throws when the switches cannot be read. For a
   * door that answers every request, not only tool calls (the mcp kit).
   */
  doorSwitch(door: string, ctx?: C): Promise<SwitchRow | null>
  /** The effective policy for a capability in a tenant, after tightening. */
  policyFor(policy: string, tenant: string | null): Promise<PolicyRule | null>
  /** A ctx for a route that is not MCP, and `call` through the guard and its request log with it. */
  http(req: Request, init: HttpCallInit<C>): HttpGuard<C>
}
