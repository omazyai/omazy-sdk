// The engine: runs one workflow through a runner's durable steps. Every
// capability call goes through the ai kit's `callInRun`, so the guard decides
// it and the effects ledger records it, tagged with the step. The ledger is
// the run's one record: what the guard did is its row, and what the run did
// itself (planned, skipped, waiting, failed, refused) goes in through
// `ai.recordInRun`. Writes never retry. R3 writes wait for their approval's
// event. A failed write goes to a person and the run waits for them. Dry run
// calls reads, and `guard.preview` for writes, so permission still applies.
//
// A runner replays the run from the results of earlier steps, so everything
// outside a `host.do` reads only `s` and those results.

import { FINAL_STATES } from '../actors/types.js'
import type { RunCallOutcome, RunPreviewOutcome } from '../ai/ai.js'
import type { EffectOutcome, RunRow } from '../ai/runs.js'
import type { BaseCtx } from '../capabilities/capability.js'
import type { Tier } from '../capabilities/tiers.js'
import { durationMs } from '../guard/policies.js'
import { firstOff } from '../guard/switches.js'
import {
  type ActorStep,
  type BulkStep,
  type CapabilityStep,
  FLOW_LIMITS,
  type FlowDeps,
  type FlowParams,
  type FlowResult,
  type FlowState,
  type FlowStatus,
  type Handoff,
  type NotifyStep,
  type RetryConfig,
  type StepHost,
  type StepKind,
  type StepStatus,
  type TaskStep,
} from './types.js'
import type { Workflow } from './workflow.js'

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 90)

/** The event types that wake a waiting run. Cloudflare allows letters, digits, `-` and `_`. */
export const flowEvents = {
  /** Sent when an approval a step waits on is decided, expires or runs. */
  approval: (approvalId: string) => `approval-${safe(approvalId)}`,
  /** Sent when an actor session a step waits on ends. */
  actor: (session: string) => `actor-${safe(session)}`,
  /** Sent by a person settling a failed write: `{ action: 'continue' | 'stop', output? }`. */
  resolve: (stepKey: string) => `resolve-${safe(stepKey)}`,
}

/** What a person sends to settle a failed step. */
export interface Resolution {
  action: 'continue' | 'stop'
  /** The step's output for later steps, when the person did the change by hand. */
  output?: unknown
  by?: string
}

const NO_RETRY: { retries: RetryConfig } = { retries: { limit: 0 } }
const DEFAULT_ACTOR_WAIT = 7 * 86_400_000
/** Times a step waits for its approval's events before it reads the approval as it stands. */
const APPROVAL_ROUNDS = 4

// What one durable step hands back. Plain JSON, kept by the runner.
type Out =
  | { t: 'done'; output?: unknown; code?: string; reported?: boolean }
  | { t: 'planned'; output?: unknown; line: string }
  | { t: 'skipped'; code: string }
  | { t: 'wait'; type: string; timeoutMs: number; approvalId?: string; ref?: string }
  /** `waits`: the person settles it and the run waits for them; otherwise the run goes on. `line`: a dry run's report line. */
  | { t: 'refused' | 'failed'; code: string; message: string; waits: boolean; line?: string }
  | { t: 'stop'; reason: string; status?: FlowStatus }
  | { t: 'threw'; message: string }
  /** The approval is not settled yet: wait for the next event. */
  | { t: 'again' }

type Next = { end: true; status: FlowStatus; reason: string } | { end: false }
const GO: Next = { end: false }

class StepCapError extends Error {}
/** A product function (when, args, stop, items...) threw. The run ends `failed` with its message. */
class ProductFnError extends Error {}

/** Calls a function the product gave, so its throw ends the run with a reason instead of leaving it running. */
function fx<T>(what: string, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw new ProductFnError(`${what} threw: ${(e as Error)?.message ?? String(e)}`)
  }
}

const monthStart = (ms: number) => {
  const d = new Date(ms)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

/** Runs a workflow to its end, or until it waits. Never throws for a step's failure; a runner's own errors pass through. */
export async function runFlow<C extends BaseCtx>(host: StepHost, wf: Workflow, deps: FlowDeps<C>, params: FlowParams): Promise<FlowResult> {
  const runId = params.key
  const now = () => deps.now?.() ?? Date.now()
  const iso = () => new Date(now()).toISOString()
  const dry = params.mode === 'dry_run'
  const auto = params.automation
  const channel = auto ? 'automation' : 'workflow'
  const maxSteps = wf.maxSteps ?? FLOW_LIMITS.maxSteps
  const store = deps.store
  const onError = deps.onError ?? ((e: unknown, where: string) => console.error(`flows ${where}:`, e))

  const ctxFor = async (key: string): Promise<C> => {
    const base: BaseCtx = { principal: params.as.principal, seat: params.as.seat, tenant: params.as.tenant, channel, approvalId: null, requestId: `${runId}:${key}` }
    return deps.ctx ? deps.ctx(base) : (base as C)
  }

  // ---------------------------------------------------------------- durable steps

  let used = 0
  const durable = async <T>(name: string, config: { retries?: RetryConfig } | undefined, fn: () => Promise<T>): Promise<T> => {
    if (++used > maxSteps) throw new StepCapError(`the run passed its cap of ${maxSteps} steps`)
    return host.do(name, config, fn)
  }
  const wait = async <T>(name: string, type: string, timeoutMs: number) => {
    if (++used > maxSteps) throw new StepCapError(`the run passed its cap of ${maxSteps} steps`)
    return host.waitForEvent<T>(name, { type, timeoutMs: Math.max(1000, Math.round(timeoutMs)) })
  }
  /** A durable step whose throw (after its retries) becomes a result, so the run can record it. */
  const tryDo = async (name: string, config: { retries?: RetryConfig } | undefined, fn: () => Promise<Out>): Promise<Out> => {
    try {
      return await durable(name, config, fn)
    } catch (e) {
      return { t: 'threw', message: (e as Error)?.message ?? String(e) }
    }
  }

  // ---------------------------------------------------------------- the ledger

  /** A step state the run decided itself, written to the ai kit's effects ledger. A guard call writes its own row. */
  const OUTCOME: Record<StepStatus, EffectOutcome> = { ok: 'ok', planned: 'planned', skipped: 'skipped', waiting: 'waiting', failed: 'failed', refused: 'refused' }
  type PutExtra = { tier?: Tier | null; code?: string | null; message?: string | null; approvalId?: string | null; ref?: string | null; mode?: 'read' | 'write' }
  const put = (key: string, kind: StepKind, target: string, status: StepStatus, extra: PutExtra = {}) =>
    deps.ai.recordInRun(runId, {
      capability: target,
      outcome: OUTCOME[status],
      step: { key, kind },
      requestId: `${runId}:${key}`,
      mode: extra.mode ?? (kind === 'read' ? 'read' : 'write'),
      tier: extra.tier ?? null,
      code: extra.code ?? null,
      message: extra.message ?? null,
      approvalId: extra.approvalId ?? null,
      ref: extra.ref ?? null,
    })
  const runStatus = (status: FlowStatus) => store.updateRun(runId, { status, updatedAt: iso() })
  const handoff = async (ctx: C, step: string, kind: Handoff['kind'], message: string, waits: boolean) => {
    if (!deps.handoff) return
    try {
      await deps.handoff(ctx, { runId, workflow: wf.id, step, kind, message, waits })
    } catch (e) {
      onError(e, 'handoff')
    }
  }

  /** Why an automation's run must stop now: its switch is off, or its owner lost the role. */
  const automationStop = async (ctx: C): Promise<string | null> => {
    if (!auto) return null
    const row = await store.getAutomation(auto.id, params.as.tenant)
    if (!row || !row.on) return 'switched_off'
    if (deps.switches) {
      const q = { keys: [`automation:${auto.id}`], tenant: params.as.tenant, person: params.as.principal.id }
      if (firstOff(await deps.switches.read(q), q)) return 'switched_off'
    }
    const roles = deps.roles ? await deps.roles(ctx) : []
    if (!roles.includes(auto.role)) {
      await store.putAutomation({ ...row, on: false, stoppedReason: 'owner_lost_role', updatedAt: iso() })
      return 'owner_lost_role'
    }
    return null
  }

  // ---------------------------------------------------------------- open

  const s: FlowState = { input: params.input }
  const report: string[] = []
  let reported = false

  try {
    await durable('open', undefined, async () => {
      const at = iso()
      await store.claimRun({
        id: runId,
        workflow: wf.id,
        workflowVersion: wf.version,
        mode: params.mode,
        status: 'running',
        automation: auto?.id ?? null,
        tenant: params.as.tenant,
        person: params.as.principal.id,
        reason: null,
        costMicros: 0,
        reported: false,
        report: [],
        startedAt: at,
        updatedAt: at,
        endedAt: null,
      })
      await runStatus('running')
      if (!(await deps.ai.runs.getRun(runId))) await deps.ai.runs.insertRun(aiRunRow(wf, params, channel, at))
      return true
    })
  } catch (e) {
    return { runId, status: 'failed', reason: `could not open the run: ${(e as Error).message}`, reported: false, report: [] }
  }

  // ---------------------------------------------------------------- settling a failure

  /** After a failed or refused step: a person settles it when it waits, else the run goes on. */
  const settle = async (key: string, id: string, out: Extract<Out, { t: 'refused' | 'failed' }>): Promise<Next> => {
    if (!out.waits) return GO
    const ev = await wait<Resolution>(`${key}:resolve`, flowEvents.resolve(key), wf.resolveTimeoutMs)
    const r = await durable(`${key}:resolved`, undefined, async () => {
      await runStatus('running')
      if ('timedOut' in ev) return { t: 'stop', reason: `${key} ${out.t}: ${out.message}; nobody settled it in time`, status: 'failed' } as Out
      const p = ev.payload ?? ({ action: 'stop' } as Resolution)
      return p.action === 'continue' ? ({ t: 'done', output: p.output } as Out) : ({ t: 'stop', reason: `${key} ${out.t}: stopped by ${p.by ?? 'a person'}`, status: 'stopped' } as Out)
    })
    if (r.t === 'stop') return { end: true, status: r.status ?? 'stopped', reason: r.reason }
    if (r.t === 'done' && r.output !== undefined) s[id] = r.output
    return GO
  }

  /** Records a step that threw after its retries, and hands it to a person. */
  const threw = async (key: string, kind: StepKind, target: string, message: string, waits: boolean): Promise<Out> => {
    const r = await tryDo(`${key}:failed`, NO_RETRY, async () => {
      await put(key, kind, target, 'failed', { code: 'error', message })
      if (waits) await runStatus('waiting')
      await handoff(await ctxFor(key), key, 'failed', message, waits)
      return { t: 'failed', code: 'error', message, waits }
    })
    return r.t === 'threw' ? { t: 'failed', code: 'error', message, waits: false } : r
  }

  const skip = async (key: string, kind: StepKind, target: string, code: string, message: string | null, todo: boolean) => {
    await durable(`${key}`, undefined, async () => {
      await put(key, kind, target, 'skipped', { code, message })
      if (todo && message) await handoff(await ctxFor(key), key, 'not_built', message, false)
      return { t: 'skipped', code } as Out
    })
  }

  // ---------------------------------------------------------------- capability steps

  /** Maps a guard outcome on a write to the step's end. */
  const writeEnd = (o: RunCallOutcome): Out => {
    switch (o.outcome) {
      case 'ok':
        return { t: 'done', output: o.result }
      case 'duplicate':
        return { t: 'done', code: 'duplicate' }
      case 'confirm_required':
        return { t: 'refused', code: 'confirm_required', message: 'This change needs a person to confirm it; a workflow cannot.', waits: true }
      case 'error':
        return { t: 'failed', code: 'code' in o ? String(o.code) : 'error', message: 'message' in o ? o.message : 'The write failed.', waits: true }
      default:
        return { t: 'refused', code: 'code' in o ? String(o.code) : o.outcome, message: 'message' in o ? o.message : o.outcome, waits: true }
    }
  }

  /** A dry run's write: the guard's checks and the capability's preview, recorded `planned` in the ledger. Never runs it. */
  const previewOf = (ctx: C, key: string, kind: StepKind, name: string, args: unknown, upstream: boolean): Promise<RunPreviewOutcome> =>
    deps.ai.previewInRun(ctx, wf.unit, runId, name, args, { step: { key, kind }, ...(upstream ? { confirm: 'upstream' as const } : {}) })
  const refusal = (p: Exclude<RunPreviewOutcome, { outcome: 'ok' }>) => ({ code: String(p.code), message: p.message })

  const capabilityStep = async (st: CapabilityStep): Promise<Next> => {
    const key = st.id
    if (st.when && !fx(`${st.id}.when`, () => st.when!(s))) return skip(key, st.kind, st.capability, 'condition', null, false).then(() => GO)
    if (st.skipIf === 'not_built' && !deps.registry.has(st.capability)) {
      return skip(key, st.kind, st.capability, 'not_built', (st.todo ? fx(`${key}.todo`, () => st.todo!(s)) : undefined) ?? `${st.capability} is not built yet; do it by hand.`, true).then(() => GO)
    }
    if (typeof st.skipIf === 'function') {
      const skipIf = st.skipIf
      const why = fx(`${key}.skipIf`, () => skipIf(s))
      if (why) return skip(key, st.kind, st.capability, 'skipped', why, false).then(() => GO)
    }
    const args = st.args ? fx(`${key}.args`, () => st.args!(s)) : s.input
    const tier = deps.registry.has(st.capability) ? deps.registry.tier(st.capability, args) : null
    const write = st.kind === 'write'

    const tag = { step: { key, kind: st.kind as StepKind } }
    let out = await tryDo(key, write ? NO_RETRY : st.retries ? { retries: st.retries } : undefined, async () => {
      const ctx = await ctxFor(key)
      const stop = await automationStop(ctx)
      if (stop) return { t: 'stop', reason: stop }
      if (write && dry) {
        const p = await previewOf(ctx, key, st.kind, st.capability, args, st.confirm === 'upstream')
        if (p.outcome !== 'ok') {
          const r = refusal(p)
          return { t: 'refused', code: r.code, message: r.message, waits: false, line: `${key}: would be refused (${r.code}): ${r.message}` }
        }
        // Live, an R2 write a person has not confirmed upstream goes to a person.
        const line = p.next === 'confirm' ? `${key}: would go to a person to confirm: ${p.preview.summary}` : `${key}: would ${p.preview.summary}`
        return { t: 'planned', output: { dryRun: true, preview: p.preview, next: p.next }, line }
      }
      // The guard's row in the ledger is the step's record: done, waiting for its approval, or refused.
      const o = await deps.ai.callInRun(ctx, wf.unit, runId, st.capability, args, write && st.confirm ? { ...tag, confirm: 'upstream' } : tag)
      if (!write) {
        // A read that failed or was limited throws, so the runner retries it.
        if (o.outcome === 'error' || o.outcome === 'rate_limited') throw new Error(`${st.capability}: ${(o as { message?: string }).message ?? o.outcome}`)
        if (o.outcome === 'ok') return { t: 'done', output: o.result }
        const message = 'message' in o ? o.message : o.outcome
        return { t: 'stop', reason: `${key}: ${message}` }
      }
      const end = writeEnd(o)
      if (end.t === 'done') return end
      if (o.outcome === 'pending_approval') {
        const type = flowEvents.approval(o.approval.id)
        await store.link('approval', o.approval.id, runId, type)
        await runStatus('waiting')
        const timeoutMs = Math.max(60_000, Date.parse(o.approval.expiresAt) - now() + 60_000)
        return { t: 'wait', type, timeoutMs, approvalId: o.approval.id }
      }
      if (end.t === 'failed' || end.t === 'refused') {
        // The guard asked for a confirm a workflow cannot give: say so in the ledger.
        if (end.code === 'confirm_required') await put(key, st.kind, st.capability, 'refused', { tier, code: end.code, message: end.message })
        await runStatus('waiting')
        await handoff(ctx, key, end.code === 'confirm_required' ? 'confirm' : end.code === 'state_changed' ? 'stale' : end.t, end.message, true)
      }
      return end
    })

    if (out.t === 'threw') {
      out = await threw(key, st.kind, st.capability, out.message, write)
      if (!write) return { end: true, status: 'failed', reason: `${key}: ${out.t === 'failed' ? out.message : 'failed'}` }
    }
    if (out.t === 'wait') out = await afterApproval(key, st, out)
    return after(key, st.id, out, st.stop)
  }

  /** Waits for the approval's event, then reads how it was decided. */
  const afterApproval = async (key: string, st: CapabilityStep, w: Extract<Out, { t: 'wait' }>): Promise<Out> => {
    // The approver's decision can wake the run while the approved change is
    // still running; the run then waits again for the next event.
    for (let round = 1; ; round++) {
      const sfx = round === 1 ? '' : `:${round}`
      const ev = await wait(`${key}:approval${sfx}`, w.type, w.timeoutMs)
      const last = round >= APPROVAL_ROUNDS || 'timedOut' in ev
      const r = await tryDo(`${key}:decided${sfx}`, NO_RETRY, async () => {
        const ctx = await ctxFor(key)
        const id = w.approvalId!
        const row = await deps.guard.approval(id)
        let end: Out
        const status = row?.status ?? 'expired'
        if (status === 'executed') end = { t: 'done', output: row!.result }
        else if (status === 'approved' || status === 'running') {
          const o = await deps.guard.execute(id)
          if (o.outcome === 'ok') end = { t: 'done', output: o.result }
          else if ('code' in o && o.code === 'in_progress' && !last) return { t: 'again' }
          else end = writeEnd(o)
        } else if (status === 'refused') end = { t: 'refused', code: 'approval_refused', message: row?.reason ?? 'The approver refused it.', waits: false }
        else if (status === 'withdrawn') end = { t: 'refused', code: 'approval_withdrawn', message: row?.reason ?? 'The approval was withdrawn.', waits: false }
        else if (status === 'stale') end = { t: 'refused', code: 'stale', message: 'The record changed after the approval was asked for.', waits: true }
        else if (status === 'failed') end = { t: 'failed', code: 'run_failed', message: row?.error ?? 'The approved change failed.', waits: true }
        else if (status === 'waiting' && !last) return { t: 'again' }
        else end = { t: 'refused', code: 'expired', message: 'timedOut' in ev ? 'Nobody decided the approval in time.' : 'The approval expired.', waits: true }
        const patch: PutExtra = { approvalId: id, tier: row?.tier ?? null }
        if (end.t === 'done') await put(key, st.kind, st.capability, 'ok', patch)
        else if (end.t === 'refused' || end.t === 'failed') {
          await put(key, st.kind, st.capability, end.t, { ...patch, code: end.code, message: end.message })
          if (end.waits) await handoff(ctx, key, end.code === 'expired' ? 'expired' : end.code === 'stale' ? 'stale' : end.t, end.message, true)
        }
        await runStatus(end.t === 'refused' || end.t === 'failed' ? (end.waits ? 'waiting' : 'running') : 'running')
        return end
      })
      if (r.t === 'again') continue
      return r.t === 'threw' ? threw(key, st.kind, st.capability, r.message, true) : r
    }
  }

  /** What a step's end means for the run. */
  const after = async (key: string, id: string, out: Out, stop?: CapabilityStep['stop']): Promise<Next> => {
    switch (out.t) {
      case 'done': {
        if (out.output !== undefined) s[id] = out.output
        if (out.reported) reported = true
        const why = stop ? fx(`${id}.stop`, () => stop(out.output, s)) : null
        if (why) return { end: true, status: 'stopped', reason: why }
        return GO
      }
      case 'planned':
        if (out.output !== undefined) s[id] = out.output
        report.push(out.line)
        return GO
      case 'skipped':
        return GO
      case 'stop':
        return { end: true, status: out.status ?? 'stopped', reason: out.reason }
      case 'refused':
      case 'failed':
        if (out.line) report.push(out.line)
        return settle(key, id, out)
      default:
        return { end: true, status: 'failed', reason: `${key}: unexpected state` }
    }
  }

  // ---------------------------------------------------------------- task steps

  const taskStep = async (st: TaskStep): Promise<Next> => {
    const key = st.id
    if (st.when && !fx(`${st.id}.when`, () => st.when!(s))) return skip(key, 'task', st.unit.id, 'condition', null, false).then(() => GO)
    const input = fx(`${key}.input`, () => st.input(s))
    const saves = !!st.unit.target
    let out = await tryDo(key, saves ? NO_RETRY : undefined, async () => {
      const ctx = await ctxFor(key)
      const stop = await automationStop(ctx)
      if (stop) return { t: 'stop', reason: stop }
      if (auto?.usdPerMonth !== undefined) {
        const u = await store.usage({ automation: auto.id, tenant: params.as.tenant, since: monthStart(now()) })
        if (u.costMicros / 1_000_000 >= auto.usdPerMonth) {
          await put(key, 'task', st.unit.id, 'refused', { code: 'budget', message: `The automation's monthly budget of $${auto.usdPerMonth} is spent.` })
          return { t: 'stop', reason: 'budget' }
        }
      }
      const res = await deps.ai.run(ctx, st.unit, input, { save: !dry })
      const run = await store.getRun(runId)
      await store.updateRun(runId, { costMicros: (run?.costMicros ?? 0) + res.usage.costMicros, updatedAt: iso() })
      const extra = { ref: res.runId }
      if (res.outcome === 'ok') {
        if (dry && saves) {
          await put(key, 'task', st.unit.id, 'planned', { ...extra, message: `would save through ${st.unit.target}` })
          return { t: 'planned', output: res.output, line: `${key}: would save the ${st.unit.id} output through ${st.unit.target}` }
        }
        const save = res.save
        if (save && save.outcome !== 'ok' && save.outcome !== 'duplicate' && save.outcome !== 'pending_approval') {
          const end = writeEnd(save)
          if (end.t === 'refused' || end.t === 'failed') {
            await put(key, 'task', st.unit.id, end.t, { ...extra, code: end.code, message: end.message })
            await handoff(ctx, key, end.t, end.message, true)
            await runStatus('waiting')
            return end
          }
        }
        await put(key, 'task', st.unit.id, 'ok', extra)
        return { t: 'done', output: res.output }
      }
      if (res.outcome === 'refused_cap') {
        await put(key, 'task', st.unit.id, 'refused', { ...extra, code: `cap_${res.cap}`, message: res.message })
        return { t: 'stop', reason: res.message }
      }
      const message = res.outcome === 'invalid_output' ? res.issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ') : res.message
      await put(key, 'task', st.unit.id, 'failed', { ...extra, code: res.outcome, message })
      await handoff(ctx, key, 'failed', message, true)
      await runStatus('waiting')
      return { t: 'failed', code: res.outcome, message, waits: true }
    })
    if (out.t === 'threw') out = await threw(key, 'task', st.unit.id, out.message, true)
    return after(key, st.id, out)
  }

  // ---------------------------------------------------------------- actor steps

  const actorStep = async (st: ActorStep): Promise<Next> => {
    const key = st.id
    if (st.when && !fx(`${st.id}.when`, () => st.when!(s))) return skip(key, 'actor', st.actor, 'condition', null, false).then(() => GO)
    const prefill = st.prefill ? fx(`${key}.prefill`, () => st.prefill!(s)) : undefined
    let out = await tryDo(key, NO_RETRY, async () => {
      const ctx = await ctxFor(key)
      const stop = await automationStop(ctx)
      if (stop) return { t: 'stop', reason: stop }
      if (dry) {
        await put(key, 'actor', st.actor, 'planned', { message: `would ask through ${st.actor}` })
        return { t: 'planned', line: `${key}: would start ${st.actor}` }
      }
      if (!deps.actors) {
        await put(key, 'actor', st.actor, 'failed', { code: 'no_actors', message: 'The flows kit was given no actor runtime.' })
        return { t: 'stop', reason: `${key}: no actor runtime`, status: 'failed' }
      }
      const reply = await deps.actors.start(ctx, st.actor, prefill ? { prefill } : {})
      if (reply.state === 'done') {
        await put(key, 'actor', st.actor, 'ok', { ref: reply.session })
        return { t: 'done', output: reply.result ?? null }
      }
      if (FINAL_STATES.includes(reply.state)) {
        await put(key, 'actor', st.actor, 'refused', { ref: reply.session, code: reply.state })
        return { t: 'stop', reason: `${key}: the ${st.actor} session ended ${reply.state}` }
      }
      const type = flowEvents.actor(reply.session)
      await store.link('actor', reply.session, runId, type)
      await put(key, 'actor', st.actor, 'waiting', { ref: reply.session })
      await runStatus('waiting')
      return { t: 'wait', type, timeoutMs: st.timeout === undefined ? DEFAULT_ACTOR_WAIT : durationMs(st.timeout), ref: reply.session }
    })
    if (out.t === 'threw') out = await threw(key, 'actor', st.actor, out.message, false)
    if (out.t === 'wait') {
      const w = out
      const ev = await wait(`${key}:actor`, w.type, w.timeoutMs)
      out = await tryDo(`${key}:ended`, NO_RETRY, async () => {
        const ctx = await ctxFor(key)
        await runStatus('running')
        const r = await deps.actors!.status(ctx, w.ref!)
        if (r.state === 'done') {
          await put(key, 'actor', st.actor, 'ok', { ref: w.ref! })
          return { t: 'done', output: r.result ?? null }
        }
        const code = 'timedOut' in ev ? 'expired' : r.state
        await put(key, 'actor', st.actor, 'refused', { ref: w.ref!, code })
        return { t: 'stop', reason: `${key}: the ${st.actor} session ended ${code}` }
      })
      if (out.t === 'threw') out = await threw(key, 'actor', st.actor, out.message, false)
    }
    return after(key, st.id, out)
  }

  // ---------------------------------------------------------------- notify steps

  const notifyStep = async (st: NotifyStep): Promise<Next> => {
    const key = st.id
    if (st.when && !fx(`${st.id}.when`, () => st.when!(s))) return skip(key, 'notify', st.template, 'condition', null, false).then(() => GO)
    if (fx(`${wf.id}.nothingToReport`, () => wf.nothingToReport?.(s) === true)) return skip(key, 'notify', st.template, 'nothing_to_report', null, false).then(() => GO)
    const data = st.data ? fx(`${key}.data`, () => st.data!(s)) : {}
    let out = await tryDo(key, NO_RETRY, async () => {
      const ctx = await ctxFor(key)
      const stop = await automationStop(ctx)
      if (stop) return { t: 'stop', reason: stop }
      if (dry || !deps.notify) {
        await put(key, 'notify', st.template, 'planned', { message: dry ? 'dry run: not sent' : 'no notify hook' })
        return { t: 'planned', line: `${key}: would send ${st.template}` }
      }
      await deps.notify(ctx, { runId, workflow: wf.id, template: st.template, data })
      await put(key, 'notify', st.template, 'ok')
      return { t: 'done', reported: true }
    })
    if (out.t === 'threw') out = await threw(key, 'notify', st.template, out.message, false)
    return after(key, st.id, out)
  }

  // ---------------------------------------------------------------- bulk steps

  const bulkStep = async (st: BulkStep): Promise<Next> => {
    const key = st.id
    if (st.when && !fx(`${st.id}.when`, () => st.when!(s))) return skip(key, 'bulk', st.capability, 'condition', null, false).then(() => GO)
    const items = fx(`${key}.items`, () => st.items(s))
    const size = st.chunk ?? FLOW_LIMITS.chunk
    const chunks = Math.ceil(items.length / size)
    const write = deps.registry.mode(st.capability) === 'write'
    if (used + chunks + 2 > maxSteps) {
      const message = `${items.length} items in chunks of ${size} pass the run's cap of ${maxSteps} steps; split the work.`
      await tryDo(key, NO_RETRY, async () => {
        await put(key, 'bulk', st.capability, 'refused', { code: 'too_many_items', message })
        await handoff(await ctxFor(key), key, 'refused', message, false)
        return { t: 'refused', code: 'too_many_items', message, waits: false }
      })
      return { end: true, status: 'stopped', reason: `${key}: ${message}` }
    }
    const total = { items: items.length, done: 0, planned: 0, failed: [] as { index: number; code: string }[] }
    for (let c = 0; c < chunks; c++) {
      const ck = `${key}#${c + 1}`
      const tag = { step: { key: ck, kind: 'bulk' as StepKind } }
      const from = c * size
      const slice = items.slice(from, from + size)
      const out = await tryDo(ck, write ? NO_RETRY : undefined, async () => {
        const ctx = await ctxFor(ck)
        const stop = await automationStop(ctx)
        if (stop) return { t: 'stop', reason: stop }
        let done = 0
        let planned = 0
        const failed: { index: number; code: string }[] = []
        for (let i = 0; i < slice.length; i++) {
          const args = st.args(slice[i], s)
          if (write && dry) {
            const p = await previewOf(ctx, ck, 'bulk', st.capability, args, st.confirm === 'upstream')
            // Live, an item that needs a confirm or an approval would not run: count it with the refused.
            if (p.outcome === 'ok' && p.next === 'run') planned++
            else failed.push({ index: from + i, code: p.outcome === 'ok' ? (p.next === 'confirm' ? 'confirm_required' : 'pending_approval') : String(p.code) })
            continue
          }
          const o = await deps.ai.callInRun(ctx, wf.unit, runId, st.capability, args, write && st.confirm ? { ...tag, confirm: 'upstream' } : tag)
          if (!write && (o.outcome === 'error' || o.outcome === 'rate_limited')) throw new Error(`${st.capability}: ${(o as { message?: string }).message ?? o.outcome}`)
          if (o.outcome === 'ok' || o.outcome === 'duplicate') done++
          else failed.push({ index: from + i, code: 'code' in o ? String(o.code) : o.outcome })
        }
        const status: StepStatus = failed.length ? 'failed' : write && dry ? 'planned' : 'ok'
        const message = `${slice.length} items: ${done} done${planned ? `, ${planned} planned` : ''}${failed.length ? `, ${failed.length} failed` : ''}`
        await put(ck, 'bulk', st.capability, status, { message, code: failed.length ? 'items_failed' : null, mode: write ? 'write' : 'read' })
        if (failed.length && write) {
          await handoff(ctx, ck, 'failed', `${st.capability}: ${failed.length} of ${slice.length} items failed (${failed.map((f) => `#${f.index}: ${f.code}`).join(', ')})`, true)
          await runStatus('waiting')
        }
        return { t: 'done', output: { done, planned, failed } }
      })
      if (out.t === 'stop') return { end: true, status: out.status ?? 'stopped', reason: out.reason }
      if (out.t === 'threw') {
        const f = await threw(ck, 'bulk', st.capability, out.message, write)
        if (!write) return { end: true, status: 'failed', reason: `${ck}: ${out.message}` }
        const n = await after(ck, st.id, f)
        if (n.end) return n
        continue
      }
      const r = (out as Extract<Out, { t: 'done' }>).output as { done: number; planned: number; failed: { index: number; code: string }[] }
      total.done += r.done
      total.planned += r.planned
      total.failed.push(...r.failed)
      if (r.failed.length && write) {
        const n = await settle(ck, st.id, { t: 'failed', code: 'items_failed', message: `${r.failed.length} items failed`, waits: true })
        if (n.end) return n
      }
    }
    if (dry && write) report.push(`${key}: would run ${st.capability} on ${total.planned} items${total.failed.length ? `; ${total.failed.length} would be refused` : ''}`)
    s[st.id] = total
    return GO
  }

  // ---------------------------------------------------------------- the run

  let end: Next = GO
  try {
    for (const st of wf.steps) {
      switch (st.kind) {
        case 'read':
        case 'write':
          end = await capabilityStep(st)
          break
        case 'task':
          end = await taskStep(st)
          break
        case 'actor':
          end = await actorStep(st)
          break
        case 'notify':
          end = await notifyStep(st)
          break
        case 'bulk':
          end = await bulkStep(st)
          break
      }
      if (end.end) break
    }
  } catch (e) {
    if (!(e instanceof StepCapError) && !(e instanceof ProductFnError)) throw e
    end = { end: true, status: 'failed', reason: e.message }
  }

  const status: FlowStatus = end.end ? end.status : 'ok'
  const reason = end.end ? end.reason : null
  let nothing = false
  try {
    nothing = wf.nothingToReport?.(s) === true
  } catch {
    // A run that ended early may lack what the check reads; it reports as usual.
  }
  await durable('close', undefined, async () => {
    const at = iso()
    await store.updateRun(runId, { status, reason, reported, report, endedAt: at, updatedAt: at })
    await deps.ai.runs.updateRun(runId, {
      outcome: status === 'ok' ? 'ok' : status === 'failed' ? 'error' : 'cancelled',
      endedAt: at,
      ...(reason ? { errorCode: status, error: reason } : {}),
    })
    if (dry && deps.report && report.length && !nothing) {
      try {
        await deps.report(await ctxFor('close'), { runId, workflow: wf.id, lines: report })
      } catch (e) {
        onError(e, 'report')
      }
    }
    return true
  }).catch((e) => onError(e, 'close'))
  return { runId, status, reason, reported, report }
}

function aiRunRow(wf: Workflow, params: FlowParams, channel: string, at: string): RunRow {
  return {
    id: params.key,
    unit: wf.id,
    unitKind: 'workflow',
    unitVersion: wf.version,
    promptTemplate: '',
    promptVersion: 0,
    language: '',
    role: '',
    model: null,
    seat: params.as.seat?.id ?? null,
    tenant: params.as.tenant,
    person: params.as.principal.id,
    channel,
    requestId: params.key,
    startedAt: at,
    endedAt: null,
    outcome: 'running',
    errorCode: null,
    error: null,
    calls: 0,
    cacheHits: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costMicros: 0,
    costEstimated: false,
    unpricedCalls: 0,
    context: null,
  }
}
