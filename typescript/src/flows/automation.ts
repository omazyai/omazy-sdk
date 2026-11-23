// Automations: a trigger bound to a workflow, with an owner, a budget, a
// switch and a mode. An automation runs under the seat of the person who
// enabled it and stops when that person loses the role. It ships in dry run;
// a person moves it to live. A condition that finds nothing records a
// "nothing" run and delivers nothing.

import type { BaseCtx } from '../capabilities/capability.js'
import { canonicalJson, sha256Hex } from '../guard/crypto.js'
import { firstOff } from '../guard/switches.js'
import type { SwitchStore } from '../guard/types.js'
import { type Cron, cron, isTimeZone, localMinute } from './cron.js'
import { type FlowStarter, startRun } from './runtime.js'
import type { AutomationRow, FlowMode, FlowParams, FlowRunRow, FlowStore } from './types.js'
import { WORKFLOW_ID_PATTERN, type Workflow } from './workflow.js'

/**
 * The zone a schedule is read in: an IANA name such as `Asia/Dhaka`, or
 * `tenant` for each tenant's own zone from `AutomationsOptions.timeZone`.
 */
export type ScheduleZone = string | 'tenant'

export interface ScheduleOptions {
  /** Default UTC. */
  tz?: ScheduleZone
}

export type Trigger =
  | { kind: 'event'; type: string; match?: Readonly<Record<string, unknown>> }
  | { kind: 'schedule'; cron: Cron; tz: ScheduleZone }
  | {
      kind: 'condition'
      cron: Cron
      tz: ScheduleZone
      /** Checked under the owner's seat. Nothing, or an empty list, is a "nothing to report" run. */
      check: (ctx: BaseCtx, at: number) => unknown | readonly unknown[] | null | undefined | Promise<unknown | readonly unknown[] | null | undefined>
    }

const zoned = (expr: string, o: ScheduleOptions) => {
  const tz = o.tz ?? 'UTC'
  return { cron: cron(expr, tz === 'tenant' ? {} : { tz }), tz }
}

/** Trigger builders. */
export const on = {
  /** A domain or audit event, such as `payment.approve`. `match` fields must equal the event's data. */
  event: (type: string, match?: Readonly<Record<string, unknown>>): Trigger => ({ kind: 'event', type, ...(match ? { match } : {}) }),
  /**
   * A five-field cron, checked by `automations.tick` from the Worker's
   * scheduled handler every minute. Read in UTC, in `tz`, or with
   * `tz: 'tenant'` in each tenant's own zone: `on.schedule('0 9 * * 0', { tz: 'tenant' })`
   * is Sunday 09:00 wherever each tenant is.
   */
  schedule: (expr: string, opts: ScheduleOptions = {}): Trigger => ({ kind: 'schedule', ...zoned(expr, opts) }),
  /** A query on a schedule: each item it returns starts a run. Takes `tz` as `schedule` does. */
  condition: (expr: string, check: Extract<Trigger, { kind: 'condition' }>['check'], opts: ScheduleOptions = {}): Trigger => ({ kind: 'condition', ...zoned(expr, opts), check }),
}

export interface Budget {
  runsPerDay?: number
  runsPerMonth?: number
  /** Model spend by the runs' task steps, per calendar month (UTC). */
  usdPerMonth?: number
}

export interface AutomationSpec {
  id: string
  on: Trigger
  run: Workflow
  /** The run's key from the trigger's data, such as `(e) => \`fulfil:${e.payment_id}\``. One run per key. */
  instanceId?: (data: any, at: number) => string
  /** The run's input. Default: the trigger's data. */
  input?: (data: any) => unknown
  /** The role the person who enables it must hold, and keep. */
  owner: string
  budget?: Budget
  /** The mode it starts in when enabled. Default `dry_run`. */
  mode?: FlowMode
}

export interface Automation extends Readonly<AutomationSpec> {
  readonly kind: 'automation'
  readonly mode: FlowMode
}

export function automationProblems(spec: Partial<AutomationSpec>): string[] {
  const p: string[] = []
  if (!WORKFLOW_ID_PATTERN.test(spec.id ?? '') || (spec.id ?? '').length > 64) p.push('id must be lower case words joined by _, at most 64 characters')
  if (!spec.on || !['event', 'schedule', 'condition'].includes(spec.on.kind)) p.push('on must be on.event, on.schedule or on.condition')
  else if (spec.on.kind === 'event' && !spec.on.type) p.push('on.event needs an event type')
  if (!spec.run || spec.run.kind !== 'workflow') p.push('run must be a workflow')
  if (typeof spec.owner !== 'string' || !spec.owner.trim()) p.push('owner must name the role that enables it')
  if (spec.mode !== undefined && spec.mode !== 'live' && spec.mode !== 'dry_run') p.push("mode must be 'live' or 'dry_run'")
  for (const [k, v] of Object.entries(spec.budget ?? {})) {
    if (!['runsPerDay', 'runsPerMonth', 'usdPerMonth'].includes(k)) p.push(`budget.${k} is not a budget`)
    else if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) p.push(`budget.${k} must be a number from 0`)
  }
  return p
}

export class AutomationError extends Error {
  constructor(
    readonly automation: string,
    readonly problems: string[],
  ) {
    super(`automation ${automation || '(unnamed)'}: ${problems.join('; ')}`)
    this.name = 'AutomationError'
  }
}

/** Defines an automation and checks it. */
export function automation(spec: AutomationSpec): Automation {
  const p = automationProblems(spec)
  if (p.length) throw new AutomationError(spec.id ?? '', p)
  return Object.freeze({ ...spec, kind: 'automation' as const, mode: spec.mode ?? 'dry_run' })
}

// ---------------------------------------------------------------- the runtime

export type FireOutcome =
  | 'started'
  /** A run with this key exists: a second event for the same payment does nothing. */
  | 'exists'
  /** Not enabled in this tenant, or switched off. */
  | 'off'
  | 'switched_off'
  | 'owner_lost_role'
  | 'refused_budget'
  /** A condition found nothing. Recorded, not delivered. */
  | 'nothing'
  /** A `tz: 'tenant'` schedule whose tenant has no zone the runtime knows. Nothing ran. */
  | 'bad_time_zone'

export interface FireResult {
  automation: string
  tenant: string | null
  outcome: FireOutcome
  key?: string
  reason?: string
}

export interface AutomationEvent {
  type: string
  tenant: string | null
  data: Readonly<Record<string, unknown>>
}

export interface AutomationsOptions<C extends BaseCtx = BaseCtx> {
  automations: readonly Automation[]
  store: FlowStore
  starter: FlowStarter
  /** The roles a person holds now. */
  roles: (ctx: C) => readonly string[] | Promise<readonly string[]>
  /** Adds the product's own fields to the base ctx. */
  ctx?: (base: BaseCtx) => C | Promise<C>
  /** Switch key `automation:<id>`, read global, per tenant and per person. */
  switches?: SwitchStore
  /** A tenant's IANA time zone, for schedules with `tz: 'tenant'`. Required when any automation has one. */
  timeZone?: (tenant: string | null) => string | null | undefined | Promise<string | null | undefined>
  now?: () => number
}

export type EnableResult = { ok: true; row: AutomationRow } | { ok: false; code: 'unknown_automation' | 'no_role'; message: string }

export interface Automations<C extends BaseCtx = BaseCtx> {
  /** Turns it on in the ctx's tenant, under the ctx's seat. The person must hold the owner role. */
  enable(ctx: C, id: string, opts?: { mode?: FlowMode }): Promise<EnableResult>
  disable(ctx: C, id: string, reason?: string): Promise<void>
  /** Moves it between dry run and live. The person must hold the owner role. */
  setMode(ctx: C, id: string, mode: FlowMode): Promise<EnableResult>
  /** Starts the runs an event triggers. */
  dispatch(event: AutomationEvent): Promise<FireResult[]>
  /** Checks schedules and conditions for the minute holding `at`. Call from the Worker's scheduled handler. */
  tick(at?: number): Promise<FireResult[]>
  readonly list: readonly Automation[]
}

const DAY = 86_400_000
const dayStart = (ms: number) => new Date(Math.floor(ms / DAY) * DAY).toISOString()
const monthStart = (ms: number) => {
  const d = new Date(ms)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}
export function createAutomations<C extends BaseCtx = BaseCtx>(o: AutomationsOptions<C>): Automations<C> {
  const tenantZoned = o.automations.filter((a) => a.on.kind !== 'event' && a.on.tz === 'tenant')
  if (tenantZoned.length && !o.timeZone) {
    throw new TypeError(`createAutomations needs timeZone(tenant) for schedules in tenant time: ${tenantZoned.map((a) => a.id).join(', ')}`)
  }
  const byId = new Map(o.automations.map((a) => [a.id, a]))
  const now = () => o.now?.() ?? Date.now()
  const iso = (ms = now()) => new Date(ms).toISOString()

  const ownerCtx = async (row: AutomationRow, at: number): Promise<C> => {
    const base: BaseCtx = { principal: row.enabledBy, seat: row.seat, tenant: row.tenant, channel: 'automation', approvalId: null, requestId: `auto:${row.id}:${at}` }
    return o.ctx ? o.ctx(base) : (base as C)
  }
  const holds = async (ctx: C, role: string) => (await o.roles(ctx)).includes(role)

  /** A run that never started, kept so the automation's page shows why. */
  const record = async (a: Automation, row: AutomationRow, id: string, status: FlowRunRow['status'], reason: string | null, at: number) => {
    const t = iso(at)
    await o.store.claimRun({
      id,
      workflow: a.run.id,
      workflowVersion: a.run.version,
      mode: row.mode,
      status,
      automation: a.id,
      tenant: row.tenant,
      person: row.enabledBy.id,
      reason,
      costMicros: 0,
      reported: false,
      report: [],
      startedAt: t,
      updatedAt: t,
      endedAt: t,
    })
  }

  // A schedule's key is the local minute, so the hour a daylight saving change repeats starts one run, not two.
  const defaultKey = async (a: Automation, row: AutomationRow, data: unknown, at: number, tz: string) =>
    a.on.kind === 'schedule' ? `${a.id}:${row.tenant ?? 'all'}:${localMinute(at, tz)}` : `${a.id}:${row.tenant ?? 'all'}:${(await sha256Hex(canonicalJson(data ?? null))).slice(0, 24)}`

  /** The zone a scheduled automation reads its cron in for this row, or null when the tenant has none the runtime knows. */
  const zoneOf = async (a: Automation, row: AutomationRow): Promise<string | null> => {
    if (a.on.kind === 'event') return 'UTC'
    if (a.on.tz !== 'tenant') return a.on.tz
    const tz = await o.timeZone!(row.tenant)
    return isTimeZone(tz) ? tz : null
  }

  /** Every gate, then the run. */
  const fire = async (a: Automation, row: AutomationRow, data: unknown, at: number, ctx?: C, tz = 'UTC'): Promise<FireResult> => {
    const res = (outcome: FireOutcome, extra: Partial<FireResult> = {}): FireResult => ({ automation: a.id, tenant: row.tenant, outcome, ...extra })
    const key = a.instanceId ? a.instanceId(data, at) : await defaultKey(a, row, data, at, tz)
    if (await o.store.getRun(key)) return res('exists', { key })
    if (!row.on) return res('off', { key })
    if (o.switches) {
      const q = { keys: [`automation:${a.id}`], tenant: row.tenant, person: row.enabledBy.id }
      if (firstOff(await o.switches.read(q), q)) return res('switched_off', { key })
    }
    const owner = ctx ?? (await ownerCtx(row, at))
    if (!(await holds(owner, row.role))) {
      await o.store.putAutomation({ ...row, on: false, stoppedReason: 'owner_lost_role', updatedAt: iso(at) })
      const reason = `${row.enabledBy.name ?? row.enabledBy.id} no longer holds ${row.role}; the automation is off.`
      await record(a, row, `${key}~refused~${at}`, 'refused', reason, at)
      return res('owner_lost_role', { key, reason })
    }
    const b = a.budget ?? {}
    const over: string[] = []
    if (b.runsPerDay !== undefined || b.runsPerMonth !== undefined || b.usdPerMonth !== undefined) {
      const month = await o.store.usage({ automation: a.id, tenant: row.tenant, since: monthStart(at) })
      if (b.runsPerMonth !== undefined && month.runs >= b.runsPerMonth) over.push(`${month.runs} of ${b.runsPerMonth} runs this month`)
      if (b.usdPerMonth !== undefined && month.costMicros / 1_000_000 >= b.usdPerMonth) over.push(`$${(month.costMicros / 1_000_000).toFixed(2)} of $${b.usdPerMonth} this month`)
      if (b.runsPerDay !== undefined) {
        const day = await o.store.usage({ automation: a.id, tenant: row.tenant, since: dayStart(at) })
        if (day.runs >= b.runsPerDay) over.push(`${day.runs} of ${b.runsPerDay} runs today`)
      }
    }
    if (over.length) {
      const reason = `Budget spent: ${over.join('; ')}.`
      await record(a, row, `${key}~refused~${at}`, 'refused', reason, at)
      return res('refused_budget', { key, reason })
    }
    const params: FlowParams = {
      key,
      workflow: a.run.id,
      input: a.input ? a.input(data) : (data ?? null),
      mode: row.mode,
      as: { principal: row.enabledBy, seat: row.seat, tenant: row.tenant },
      automation: { id: a.id, role: row.role, ...(b.usdPerMonth !== undefined ? { usdPerMonth: b.usdPerMonth } : {}) },
    }
    const r = await startRun(o.store, o.starter, a.run, params, () => at)
    return res(r.outcome, { key })
  }

  const setRow = async (ctx: C, id: string, mode: FlowMode | undefined): Promise<EnableResult> => {
    const a = byId.get(id)
    if (!a) return { ok: false, code: 'unknown_automation', message: `No automation ${id}.` }
    if (!(await holds(ctx, a.owner))) return { ok: false, code: 'no_role', message: `Only someone holding ${a.owner} can turn on ${id}.` }
    const old = await o.store.getAutomation(id, ctx.tenant)
    const t = iso()
    const row: AutomationRow = {
      id,
      tenant: ctx.tenant,
      on: true,
      mode: mode ?? old?.mode ?? a.mode,
      role: a.owner,
      enabledBy: { ...ctx.principal },
      seat: ctx.seat ? { ...ctx.seat } : null,
      enabledAt: old?.on ? old.enabledAt : t,
      updatedAt: t,
      stoppedReason: null,
    }
    await o.store.putAutomation(row)
    return { ok: true, row }
  }

  return {
    list: o.automations,
    enable: (ctx, id, opts = {}) => setRow(ctx, id, opts.mode),
    setMode: (ctx, id, mode) => setRow(ctx, id, mode),
    async disable(ctx, id, reason) {
      const row = await o.store.getAutomation(id, ctx.tenant)
      if (row) await o.store.putAutomation({ ...row, on: false, stoppedReason: reason ?? `turned off by ${ctx.principal.id}`, updatedAt: iso() })
    },
    async dispatch(event) {
      const at = now()
      const out: FireResult[] = []
      for (const a of o.automations) {
        if (a.on.kind !== 'event' || a.on.type !== event.type) continue
        const match = a.on.match ?? {}
        if (!Object.entries(match).every(([k, v]) => canonicalJson(event.data[k] ?? null) === canonicalJson(v))) continue
        const row = await o.store.getAutomation(a.id, event.tenant)
        if (!row) {
          out.push({ automation: a.id, tenant: event.tenant, outcome: 'off' })
          continue
        }
        out.push(await fire(a, row, event.data, at))
      }
      return out
    },
    async tick(at = now()) {
      const out: FireResult[] = []
      const rows = await o.store.listAutomations({ on: true })
      for (const row of rows) {
        const a = byId.get(row.id)
        if (!a || a.on.kind === 'event') continue
        const tz = await zoneOf(a, row)
        if (!tz) {
          out.push({ automation: a.id, tenant: row.tenant, outcome: 'bad_time_zone', reason: `No time zone the runtime knows for tenant ${row.tenant ?? '(none)'}.` })
          continue
        }
        if (!a.on.cron.matches(at, tz)) continue
        if (a.on.kind === 'schedule') {
          out.push(await fire(a, row, { at: iso(at), local: localMinute(at, tz), tz }, at, undefined, tz))
          continue
        }
        const ctx = await ownerCtx(row, at)
        if (!(await holds(ctx, row.role))) {
          out.push(await fire(a, row, null, at, ctx, tz))
          continue
        }
        const found = await a.on.check(ctx, at)
        const items = found == null ? [] : Array.isArray(found) ? found : [found]
        if (!items.length) {
          const id = `${a.id}:${row.tenant ?? 'all'}:${localMinute(at, tz)}~nothing`
          await record(a, row, id, 'nothing', 'Nothing to report.', at)
          out.push({ automation: a.id, tenant: row.tenant, outcome: 'nothing', key: id })
          continue
        }
        for (const item of items) out.push(await fire(a, row, item, at, ctx, tz))
      }
      return out
    },
  }
}
