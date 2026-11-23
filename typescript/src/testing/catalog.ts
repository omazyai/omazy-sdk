// Contract tests a product runs on its own catalog in CI, a few lines each:
// the tier snapshot, the approval invariant, tenant isolation and parity.
// Each drives the product's real registry and guard, never a copy, and gives
// a report; the `assert` form throws `CatalogCheckFailure` with it.

import { checkUnits } from '../ai/check.js'
import type { AnyUnit } from '../ai/manifest.js'
import type { Prompts } from '../ai/prompts.js'
import type { BaseCtx } from '../capabilities/capability.js'
import { parityProblems, type Surface } from '../capabilities/parity.js'
import type { Registry } from '../capabilities/registry.js'
import { type Tier, tierRank } from '../capabilities/tiers.js'
import { type CatalogSnapshot, type Change, compareSnapshots, toolsChangelog } from '../capabilities/versioning.js'
import type { ApprovalRow, CallOptions, Guard, GuardOutcome, Outcome, StepUpProof } from '../guard/types.js'

// ---------------------------------------------------------------- reports

export type CatalogCheck = 'tier_snapshot' | 'approvals' | 'tenant_isolation' | 'parity'

export interface CatalogProblem {
  /** `violation`: the rule broke. `setup`: the check could not prove the rule, such as arguments missing or refused for another reason. */
  kind: 'violation' | 'setup'
  capability?: string
  /** The step that found it, such as `upstream_confirm` or `decide_without_proof`. */
  step: string
  message: string
}

export interface CatalogReport {
  check: CatalogCheck
  ok: boolean
  problems: CatalogProblem[]
  /** The capabilities the check drove or compared. */
  checked: string[]
}

/** One line for the verdict and one for each problem. */
export function formatCatalogReport(r: CatalogReport): string {
  const head = `${r.ok ? 'PASS' : 'FAIL'} ${r.check.replace('_', ' ')}: ${r.checked.length} capabilit${r.checked.length === 1 ? 'y' : 'ies'}, ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}`
  return [head, ...r.problems.map((p) => `  ${p.kind === 'violation' ? 'x' : '-'} ${p.capability ?? '(catalog)'} ${p.step}: ${p.message}`)].join('\n')
}

export class CatalogCheckFailure extends Error {
  override readonly name = 'CatalogCheckFailure'
  constructor(readonly report: CatalogReport) {
    super(formatCatalogReport(report))
  }
}

const done = <R extends CatalogReport>(r: Omit<R, 'ok'>): R => ({ ...r, ok: r.problems.length === 0 }) as R
const thrown = <R extends CatalogReport>(r: R): R => {
  if (!r.ok) throw new CatalogCheckFailure(r)
  return r
}
const env = () => (globalThis as { process?: { env?: Record<string, string | undefined>; cwd?(): string } }).process
const refusalText = (o: GuardOutcome) => ('code' in o ? `${o.outcome} (${o.code}): ${o.message}` : o.outcome)

// ---------------------------------------------------------------- tier snapshot

export interface TierMove {
  name: string
  /** Null when the capability is new. */
  from: Tier | null
  /** Null when it was removed. */
  to: Tier | null
}

export interface TierSnapshotOptions {
  registry: Registry<any, any, any>
  /** The committed snapshot, or the path of its JSON file. */
  snapshot: CatalogSnapshot | string
  /**
   * Write the current catalog to the path when it differs, and pass. Default
   * true when `OMAZY_UPDATE_SNAPSHOTS=1`. A breaking change still fails and is
   * never written.
   */
  update?: boolean
  /** YYYY-MM-DD, for deprecation dates. Default today in UTC. */
  today?: string
  /** The folder a relative path is under. Default the working directory. */
  root?: string
  /** File access. Default `node:fs/promises`. */
  read?: (path: string) => Promise<string | null>
  write?: (path: string, text: string) => Promise<void>
}

export interface TierSnapshotReport extends CatalogReport {
  check: 'tier_snapshot'
  /** Every change from the committed snapshot to the registry. */
  changes: Change[]
  /** Every capability whose tier moved, was added or was removed. */
  tiers: TierMove[]
  current: CatalogSnapshot
  /** True when the file was written. */
  written: boolean
  /** The tools changelog for the changes, empty when none. */
  changelog: string
}

async function nodeRead(path: string): Promise<string | null> {
  const fs = (await import('node:fs/promises' as string)) as { readFile(p: string, e: 'utf8'): Promise<string> }
  try {
    return await fs.readFile(path, 'utf8')
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null
    throw e
  }
}
async function nodeWrite(path: string, text: string): Promise<void> {
  const fs = (await import('node:fs/promises' as string)) as { writeFile(p: string, t: string): Promise<void>; mkdir(p: string, o: { recursive: true }): Promise<unknown> }
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (dir) await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path, text)
}

/**
 * Compares the registry with the committed catalog snapshot: every tier, door,
 * approval policy and schema. Any difference fails until the snapshot is
 * updated, so a tier change is always a reviewed change to a committed file.
 * A breaking change fails even then.
 *
 *     await assertTierSnapshot({ registry, snapshot: 'catalog.snapshot.json' })
 *     // OMAZY_UPDATE_SNAPSHOTS=1 bun test   writes it after a reviewed change
 */
export async function checkTierSnapshot(o: TierSnapshotOptions): Promise<TierSnapshotReport> {
  const current = o.registry.snapshot()
  const update = o.update ?? env()?.env?.OMAZY_UPDATE_SNAPSHOTS === '1'
  const problems: CatalogProblem[] = []
  let before: CatalogSnapshot | null
  let path: string | null = null
  if (typeof o.snapshot === 'string') {
    const root = o.root ?? env()?.cwd?.() ?? '.'
    path = o.snapshot.startsWith('/') ? o.snapshot : `${root.replace(/\/$/, '')}/${o.snapshot}`
    const text = await (o.read ?? nodeRead)(path)
    before = text === null ? null : (JSON.parse(text) as CatalogSnapshot)
    if (before && (before.format !== 1 || !Array.isArray(before.capabilities))) throw new Error(`${o.snapshot} is not a catalog snapshot`)
  } else before = o.snapshot

  const changes = before ? compareSnapshots(before, current, o.today ? { today: o.today } : {}) : []
  const was = new Map((before?.capabilities ?? []).map((c) => [c.name, c.risk]))
  const now = new Map(current.capabilities.map((c) => [c.name, c.risk]))
  const tiers: TierMove[] = []
  for (const [name, to] of now) if (was.get(name) !== to) tiers.push({ name, from: was.get(name) ?? null, to })
  for (const [name, from] of was) if (!now.has(name)) tiers.push({ name, from, to: null })

  for (const c of changes.filter((x) => x.breaking)) problems.push({ kind: 'violation', capability: c.name, step: 'breaking', message: c.detail })
  const differs = !before || JSON.stringify(before) !== JSON.stringify(current)
  let written = false
  if (differs && update && path && !problems.length) {
    await (o.write ?? nodeWrite)(path, `${JSON.stringify(current, null, 2)}\n`)
    written = true
  } else if (differs && !update) {
    if (!before) problems.push({ kind: 'setup', step: 'no_snapshot', message: `there is no snapshot${path ? ` at ${o.snapshot}` : ''}; write it with OMAZY_UPDATE_SNAPSHOTS=1 and commit it` })
    for (const t of tiers) {
      if (!t.from || !t.to) continue
      const lower = tierRank(t.to) < tierRank(t.from)
      const note = lower && tierRank(t.from) >= 3 && tierRank(t.to) < 3 ? '; it no longer waits for an approval' : lower && tierRank(t.from) >= 2 && tierRank(t.to) < 2 ? '; it no longer asks for a confirm' : ''
      problems.push({ kind: 'violation', capability: t.name, step: 'tier', message: `tier ${lower ? 'lowered' : 'raised'} from ${t.from} to ${t.to}${note}; update the snapshot once reviewed` })
    }
    for (const c of changes) if (!c.breaking && !/^tier /.test(c.detail)) problems.push({ kind: 'violation', capability: c.name, step: c.kind, message: `${c.detail}; update the snapshot once reviewed` })
    if (before && !changes.length) problems.push({ kind: 'violation', step: 'changed', message: 'the catalog differs from the snapshot (a title or description); update the snapshot once reviewed' })
  }
  return done<TierSnapshotReport>({
    check: 'tier_snapshot',
    problems,
    checked: current.capabilities.map((c) => c.name),
    changes,
    tiers,
    current,
    written,
    changelog: before ? toolsChangelog(before, current, o.today ? { today: o.today } : {}) : '',
  })
}

/** `checkTierSnapshot`, throwing `CatalogCheckFailure` when it does not pass. */
export async function assertTierSnapshot(o: TierSnapshotOptions): Promise<TierSnapshotReport> {
  return thrown(await checkTierSnapshot(o))
}

// ---------------------------------------------------------------- approvals

export interface ApprovalCheckOptions<C extends BaseCtx = BaseCtx> {
  registry: Registry<any, any, any>
  /** The product's guard, built as it is in production but on test stores. */
  guard: Guard<C>
  /** A seat that may ask for every action checked. */
  requester: C
  /** A seat that may decide. Without it only the asking side is checked. */
  decider?: C
  /** A valid step-up proof for `who` on this approval, as your verifier reads it. Needed with `decider`. */
  proof?: (approval: ApprovalRow, who: C) => StepUpProof | Promise<StepUpProof>
  /** A proof that must fail. Default `{ method }` with no codes or assertion, for the policy's first method. */
  badProof?: (approval: ApprovalRow) => StepUpProof
  /** Arguments for each action at R3 or R4. An action without arguments is a setup problem unless skipped. */
  args: Readonly<Record<string, unknown>>
  skip?: readonly string[]
  /** For a policy that asks for a typed target. Default the approval's target. */
  typedTarget?: (approval: ApprovalRow) => string
  /**
   * A count of the product's effects, such as rows written by the fakes the
   * capabilities call. When given, it may move only when an approved action
   * runs: a preview or a refused call that changes it is a violation.
   */
  effects?: () => number | Promise<number>
}

export interface ApprovalReport extends CatalogReport {
  check: 'approvals'
}

/**
 * Drives every R3 and R4 action through the guard the ways a caller could
 * try to skip the approval, and checks none of them ran: a plain call, an
 * upstream confirm, a forged confirm token, a forged approval id on the ctx,
 * executing a waiting approval. With a decider it then checks a decision
 * needs a step-up proof, a bad proof and a self-approval under four eyes are
 * refused, and the approval that runs is decided and step-up verified.
 */
export async function checkApprovals<C extends BaseCtx>(o: ApprovalCheckOptions<C>): Promise<ApprovalReport> {
  const problems: CatalogProblem[] = []
  const checked: string[] = []
  const count = async () => (o.effects ? await o.effects() : 0)
  for (const cap of o.registry.list()) {
    const name = cap.name
    const args = o.args[name]
    const tier = o.registry.tier(name, args)
    if (tierRank(cap.risk) < 3 && tierRank(tier) < 3) continue
    if (o.skip?.includes(name)) continue
    const add = (kind: CatalogProblem['kind'], step: string, message: string) => problems.push({ kind, capability: name, step, message })
    if (!(name in o.args)) {
      add('setup', 'arguments', `${cap.risk} with no arguments to drive it; add them to args or list it in skip`)
      continue
    }
    if (tierRank(tier) < 3) {
      add('setup', 'arguments', `these arguments lower it to ${tier}; give arguments at R3 or R4`)
      continue
    }
    checked.push(name)
    let effects = await count()
    const quiet = async (step: string) => {
      const n = await count()
      if (n !== effects) add('violation', step, `the product's effects changed (${effects} to ${n}) though nothing was approved`)
      effects = n
    }
    const notRun = async (step: string, out: GuardOutcome, what: string) => {
      if (out.outcome === 'ok') add('violation', step, `${what} ran it without a decided approval`)
      await quiet(step)
    }

    const first = await o.guard.call(o.requester, name, args)
    await quiet('call')
    if (first.outcome === 'ok') {
      add('violation', 'call', 'a plain call ran it without an approval')
      continue
    }
    if (first.outcome !== 'pending_approval') {
      add('setup', 'call', `the requester was refused, ${refusalText(first)}; give a requester that may ask`)
      continue
    }
    const pending = first.approval.id
    await notRun('upstream_confirm', await o.guard.call(o.requester, name, args, { confirm: 'upstream' } satisfies CallOptions), 'a call confirmed upstream')
    await notRun('forged_token', await o.guard.call(o.requester, name, args, { confirmToken: 'forged.token' }), 'a call with a forged confirm token')
    await notRun('forged_approval_id', await o.guard.call({ ...o.requester, approvalId: pending }, name, args), 'a call carrying the waiting approval id')
    await notRun('execute_waiting', await o.guard.execute(pending), 'executing the waiting approval')

    if (!o.decider) continue
    if (!o.proof) {
      add('setup', 'decide', 'a decider needs proof() to make a valid step-up proof')
      continue
    }
    const row = await o.guard.approval(pending)
    if (!row) {
      add('violation', 'approval_row', 'the guard returned an approval id it does not hold')
      continue
    }
    const rule = row.rule
    if (!rule.stepUp.length) add('violation', 'policy', `policy ${row.policy} asks for no step-up`)
    const typed = rule.typedTarget ? { typedTarget: o.typedTarget?.(row) ?? row.target ?? '' } : {}
    const approved = (d: { outcome: string }) => d.outcome === 'approved'

    if (approved(await o.guard.decide(pending, o.decider, { approve: true, ...typed }))) add('violation', 'decide_without_proof', 'approved without a step-up proof')
    await quiet('decide_without_proof')
    const bad = o.badProof?.(row) ?? { method: rule.stepUp[0] ?? 'code' }
    if (approved(await o.guard.decide(pending, o.decider, { approve: true, proof: bad, ...typed }))) add('violation', 'decide_bad_proof', 'approved with a proof that should fail')
    await quiet('decide_bad_proof')
    if (rule.fourEyes) {
      const self = await o.guard.decide(pending, o.requester, { approve: true, proof: await o.proof(row, o.requester), ...typed })
      if (approved(self)) add('violation', 'self_approval', `policy ${row.policy} is four eyes, but the requester approved their own request`)
      await quiet('self_approval')
    }

    const fresh = await o.guard.approval(pending)
    if (fresh?.status !== 'waiting') {
      if (fresh?.status === 'executed' || fresh?.status === 'running') continue // already reported above
      add('setup', 'decide', `the approval is ${fresh?.status ?? 'gone'} before the valid decision`)
      continue
    }
    const decided = await o.guard.decide(pending, o.decider, { approve: true, proof: await o.proof(row, o.decider), ...typed })
    effects = await count()
    if (decided.outcome !== 'approved') {
      add('setup', 'decide', `the decider could not approve: ${decided.outcome}${'message' in decided ? ` (${decided.message})` : ''}`)
      continue
    }
    const after = await o.guard.approval(pending)
    if (decided.execution.outcome === 'ok') {
      if (!after?.decidedAt || !after.decider) add('violation', 'decided', 'it ran on an approval with no decider or decision time')
      if (!after?.verification || !rule.stepUp.includes(after.verification)) add('violation', 'step_up', `it ran on an approval verified by ${after?.verification ?? 'nothing'}, not ${rule.stepUp.join(' or ')}`)
      if (rule.fourEyes && after?.decider?.id === row.requester.id) add('violation', 'four_eyes', 'it ran on an approval the requester decided')
    }
    await notRun('replay_approval_id', await o.guard.call({ ...o.requester, approvalId: pending }, name, args), 'a new call carrying the used approval id')
  }
  return done<ApprovalReport>({ check: 'approvals', problems, checked })
}

/** `checkApprovals`, throwing `CatalogCheckFailure` when it does not pass. */
export async function assertApprovals<C extends BaseCtx>(o: ApprovalCheckOptions<C>): Promise<ApprovalReport> {
  return thrown(await checkApprovals(o))
}

// ---------------------------------------------------------------- tenant isolation

export interface TenantIsolationOptions<C extends BaseCtx = BaseCtx> {
  registry: Registry<any, any, any>
  guard: Guard<C>
  /** A seat in tenant A that holds every permission, so only the tenant can stop a call. */
  seat: C
  /** Arguments naming tenant B's records, for each capability. */
  args: Readonly<Record<string, unknown>>
  /** Tenant B's id. Also sent in `tenantFields` to every capability whose input takes one. */
  otherTenant?: string
  /** Top-level input fields that hold a tenant id. Default `['tenant_id']`. */
  tenantFields?: readonly string[]
  /** The door to check. Default the seat's door; every capability when neither is set. */
  audience?: string
  /** Capabilities that take no ids, such as `me_get`. */
  skip?: readonly string[]
  /** Outcomes that count as refused. Default `refused_permission` and `not_found`. */
  refusals?: readonly Outcome[]
  /** A count of the product's effects. It must not move. */
  effects?: () => number | Promise<number>
}

export interface TenantIsolationReport extends CatalogReport {
  check: 'tenant_isolation'
}

/**
 * Calls every capability the door offers with a tenant A seat and tenant B's
 * ids, and expects each refused. An `ok`, a confirm or an approval request is
 * a violation: the last two show a preview of B's record. Any other ending
 * (invalid arguments, a rate limit) is a setup problem, because it did not
 * reach the tenant check.
 */
export async function checkTenantIsolation<C extends BaseCtx>(o: TenantIsolationOptions<C>): Promise<TenantIsolationReport> {
  const problems: CatalogProblem[] = []
  const checked: string[] = []
  const refusals = o.refusals ?? ['refused_permission', 'not_found']
  const fields = o.tenantFields ?? ['tenant_id']
  const audience = o.audience ?? o.seat.seat?.door
  const count = async () => (o.effects ? await o.effects() : 0)
  for (const cap of o.registry.list(audience)) {
    const name = cap.name
    if (o.skip?.includes(name)) continue
    const add = (kind: CatalogProblem['kind'], step: string, message: string) => problems.push({ kind, capability: name, step, message })
    const props = (cap.inputJson.properties ?? {}) as Record<string, unknown>
    const probes: [string, unknown][] = []
    if (name in o.args) probes.push(['tenant_b_ids', o.args[name]])
    if (o.otherTenant) {
      const base = (name in o.args ? o.args[name] : {}) as Record<string, unknown> | null
      for (const f of fields) if (f in props && base && typeof base === 'object') probes.push([`tenant_b_${f}`, { ...base, [f]: o.otherTenant }])
    }
    if (!probes.length) {
      add('setup', 'arguments', 'no arguments naming tenant B; add them to args or list it in skip')
      continue
    }
    checked.push(name)
    for (const [step, args] of probes) {
      const before = await count()
      const out = await o.guard.call(o.seat, name, args)
      const after = await count()
      if (after !== before) add('violation', step, `the product's effects changed (${before} to ${after})`)
      if (out.outcome === 'ok') add('violation', step, 'answered ok for tenant B\'s records')
      else if (out.outcome === 'confirm_required') add('violation', step, 'reached a confirm with a preview of tenant B\'s record')
      else if (out.outcome === 'pending_approval') add('violation', step, 'opened an approval for tenant B\'s record')
      else if (!refusals.includes(out.outcome)) add('setup', step, `ended ${refusalText(out)}, before the tenant check; fix the arguments or the seat`)
    }
  }
  return done<TenantIsolationReport>({ check: 'tenant_isolation', problems, checked })
}

/** `checkTenantIsolation`, throwing `CatalogCheckFailure` when it does not pass. */
export async function assertTenantIsolation<C extends BaseCtx>(o: TenantIsolationOptions<C>): Promise<TenantIsolationReport> {
  return thrown(await checkTenantIsolation(o))
}

// ---------------------------------------------------------------- parity

export interface CatalogParityOptions {
  registry: Registry<any, any, any>
  /** Lists of tool names some part of the product uses, as `registry.parity` takes them. */
  surfaces?: Readonly<Record<string, readonly string[] | { audience?: string; tools: readonly string[] }>>
  /** The doors the product has. A capability on any other is a problem. */
  audiences?: readonly string[]
  /** The product's AI units: their tools and targets must be in the registry, within each unit's tier. */
  units?: readonly AnyUnit[]
  /** With `units`, every unit's prompt must be in it. */
  prompts?: Prompts
  /** With `units`, the retriever names `createAi` is given. */
  retrievers?: readonly string[]
}

export interface CatalogParityReport extends CatalogReport {
  check: 'parity'
}

/**
 * The registry's parity check and the AI kit's unit check as one report:
 * every capability is sound, names are unique, every surface names only tools
 * the registry has and its door may see, and every unit's tools and target
 * are in the registry within its tier.
 */
export function checkCatalogParity(o: CatalogParityOptions): CatalogParityReport {
  const surfaces: Surface[] = Object.entries(o.surfaces ?? {}).map(([name, s]) => (Array.isArray(s) ? { name, tools: s as readonly string[] } : { name, ...(s as { audience?: string; tools: readonly string[] }) }))
  const problems: CatalogProblem[] = parityProblems(o.registry, { surfaces, ...(o.audiences ? { audiences: o.audiences } : {}) }).map((p) => ({
    kind: 'violation',
    ...(p.capability ? { capability: p.capability } : {}),
    step: p.surface ? `surface ${p.surface}` : 'registry',
    message: p.problem,
  }))
  if (o.units) {
    for (const u of checkUnits(o.units, { registry: o.registry, ...(o.prompts ? { prompts: o.prompts } : {}), ...(o.retrievers ? { retrievers: o.retrievers } : {}) })) {
      problems.push({ kind: 'violation', step: `unit ${u.unit}`, message: u.problem })
    }
  }
  return done<CatalogParityReport>({ check: 'parity', problems, checked: o.registry.list().map((c) => c.name) })
}

/** `checkCatalogParity`, throwing `CatalogCheckFailure` when it does not pass. */
export function assertCatalogParity(o: CatalogParityOptions): CatalogParityReport {
  return thrown(checkCatalogParity(o))
}
