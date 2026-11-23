// In memory: a flow store, and a runner that behaves like Cloudflare
// Workflows for tests. The runner keeps each step's result by name and
// replays the run from them on every wake, retries a step that throws up to
// its limit, buffers events sent before the run waits for them, and times
// waits out on its own clock (`advance`). Delays between retries are skipped.

import type { BaseCtx } from '../capabilities/capability.js'
import { runFlow } from './engine.js'
import type { FlowStarter } from './runtime.js'
import type { AutomationRow, FlowDeps, FlowParams, FlowResult, FlowRunRow, FlowStatus, FlowStore, RetryConfig, StepHost, WaitResult } from './types.js'
import type { Workflow } from './workflow.js'

const clone = <T>(v: T): T => structuredClone(v)

export function memoryFlowStore(): FlowStore & { runs: Map<string, FlowRunRow>; automations: Map<string, AutomationRow> } {
  const runs = new Map<string, FlowRunRow>()
  const links = new Map<string, { runId: string; eventType: string }>()
  const automations = new Map<string, AutomationRow>()
  const autoKey = (id: string, tenant: string | null) => `${tenant ?? ''}|${id}`
  return {
    runs,
    automations,
    async claimRun(row) {
      if (runs.has(row.id)) return false
      runs.set(row.id, clone(row))
      return true
    },
    async getRun(id) {
      const r = runs.get(id)
      return r ? clone(r) : null
    },
    async updateRun(id, patch) {
      const r = runs.get(id)
      if (r) runs.set(id, { ...r, ...clone(patch), id })
    },
    async listRuns(q = {}) {
      let rows = [...runs.values()]
      if (q.automation !== undefined) rows = rows.filter((r) => r.automation === q.automation)
      if (q.tenant !== undefined) rows = rows.filter((r) => r.tenant === q.tenant)
      if (q.status) rows = rows.filter((r) => r.status === q.status)
      rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      return clone(rows.slice(0, q.limit ?? 100))
    },
    async usage(q) {
      let n = 0
      let cost = 0
      for (const r of runs.values()) {
        if (r.automation !== q.automation || r.tenant !== q.tenant || r.startedAt < q.since) continue
        if (r.status === 'refused' || r.status === 'nothing') continue
        n++
        cost += r.costMicros
      }
      return { runs: n, costMicros: cost }
    },
    async link(kind, ref, runId, eventType) {
      links.set(`${kind}|${ref}`, { runId, eventType })
    },
    async linked(kind, ref) {
      const l = links.get(`${kind}|${ref}`)
      return l ? { ...l } : null
    },
    async getAutomation(id, tenant) {
      const r = automations.get(autoKey(id, tenant))
      return r ? clone(r) : null
    },
    async putAutomation(row) {
      automations.set(autoKey(row.id, row.tenant), clone(row))
    },
    async listAutomations(q = {}) {
      let rows = [...automations.values()]
      if (q.tenant !== undefined) rows = rows.filter((r) => r.tenant === q.tenant)
      if (q.on !== undefined) rows = rows.filter((r) => r.on === q.on)
      return clone(rows)
    },
  }
}

// ---------------------------------------------------------------- the runner

/** Thrown inside a run to park it until an event or a timeout. Never seen by the product. */
class Parked extends Error {}

const DEFAULT_RETRIES = 5

/** What `memoryRunner().status` answers: a run status, or `error` when the instance threw. */
export type MemoryRunStatus = FlowStatus | 'error'

interface Instance {
  key: string
  wf: Workflow
  params: FlowParams
  cache: Map<string, { ok: true; value: unknown } | { ok: false; message: string }>
  /** First time each wait was reached, on the runner's clock. */
  waitingSince: Map<string, number>
  events: { type: string; payload: unknown }[]
  /** `ended` once the run returned (its own status is in `result`), `error` when it threw. */
  status: 'running' | 'waiting' | 'ended' | 'error'
  result: FlowResult | null
  error: string | null
  /** Calls of each step's function, retries included. */
  attempts: Map<string, number>
  chain: Promise<void>
}

export interface MemoryRunner extends FlowStarter {
  /** Every instance by key. */
  readonly instances: ReadonlyMap<string, Readonly<Instance>>
  /** The run's result once it ended, else null. */
  result(key: string): FlowResult | null
  /**
   * Where the run is, in the flows words: `running`, `waiting`, then the run's
   * own status once it ended (`ok`, `stopped`, `failed`, `refused`,
   * `nothing`), or `error` when the instance threw.
   */
  status(key: string): MemoryRunStatus | null
  /** How many times a step's function ran, retries included. */
  attempts(key: string, step: string): number
  /** Moves the runner's clock and wakes runs whose waits have timed out. */
  advance(ms: number): Promise<void>
  /** Resolves when every run has nothing more to do. */
  idle(): Promise<void>
}

/** Runs workflows in memory, the way Cloudflare Workflows runs them. For tests and local runs. */
export function memoryRunner<C extends BaseCtx>(deps: FlowDeps<C>, workflows: readonly Workflow[], opts: { defaultRetries?: number } = {}): MemoryRunner {
  const byId = new Map(workflows.map((w) => [w.id, w]))
  const instances = new Map<string, Instance>()
  let clock = 0

  const host = (inst: Instance): StepHost => ({
    async do<T>(name: string, config: { retries?: RetryConfig } | undefined, fn: () => Promise<T>): Promise<T> {
      const hit = inst.cache.get(name)
      if (hit) {
        if (hit.ok) return clone(hit.value) as T
        throw new Error(hit.message)
      }
      const limit = config?.retries?.limit ?? opts.defaultRetries ?? DEFAULT_RETRIES
      let last: unknown
      for (let i = 0; i <= limit; i++) {
        inst.attempts.set(name, (inst.attempts.get(name) ?? 0) + 1)
        try {
          const v = await fn()
          // A step's result is stored as JSON, as Cloudflare stores it.
          const kept = v === undefined ? undefined : JSON.parse(JSON.stringify(v))
          inst.cache.set(name, { ok: true, value: kept })
          return clone(kept) as T
        } catch (e) {
          last = e
        }
      }
      const message = (last as Error)?.message ?? String(last)
      inst.cache.set(name, { ok: false, message })
      throw new Error(message)
    },
    async waitForEvent<T>(name: string, o: { type: string; timeoutMs: number }): Promise<WaitResult<T>> {
      const hit = inst.cache.get(name)
      if (hit?.ok) return clone(hit.value) as WaitResult<T>
      const i = inst.events.findIndex((e) => e.type === o.type)
      if (i >= 0) {
        const [e] = inst.events.splice(i, 1)
        const r: WaitResult<T> = { payload: e!.payload as T }
        inst.cache.set(name, { ok: true, value: r })
        return clone(r)
      }
      if (!inst.waitingSince.has(name)) inst.waitingSince.set(name, clock)
      if (clock - inst.waitingSince.get(name)! >= o.timeoutMs) {
        const r: WaitResult<T> = { timedOut: true }
        inst.cache.set(name, { ok: true, value: r })
        return r
      }
      throw new Parked()
    },
  })

  const drive = (inst: Instance): Promise<void> => {
    inst.chain = inst.chain.then(async () => {
      if (inst.status === 'ended' || inst.status === 'error') return
      inst.status = 'running'
      try {
        inst.result = await runFlow(host(inst), inst.wf, deps, inst.params)
        inst.status = 'ended'
      } catch (e) {
        if (e instanceof Parked) inst.status = 'waiting'
        else {
          inst.status = 'error'
          inst.error = (e as Error)?.message ?? String(e)
        }
      }
    })
    return inst.chain
  }

  return {
    instances,
    async start(wf, params) {
      if (!byId.has(wf.id)) byId.set(wf.id, wf)
      if (instances.has(params.key)) return { started: false }
      const inst: Instance = {
        key: params.key,
        wf,
        params: clone(params),
        cache: new Map(),
        waitingSince: new Map(),
        events: [],
        status: 'running',
        result: null,
        error: null,
        attempts: new Map(),
        chain: Promise.resolve(),
      }
      instances.set(params.key, inst)
      await drive(inst)
      return { started: true }
    },
    async send(key, event) {
      const inst = instances.get(key)
      if (!inst) throw new Error(`no run ${key}`)
      inst.events.push(clone(event))
      if (inst.status === 'waiting') await drive(inst)
    },
    result: (key) => instances.get(key)?.result ?? null,
    status: (key) => {
      const inst = instances.get(key)
      if (!inst) return null
      return inst.status === 'ended' ? (inst.result?.status ?? 'ok') : inst.status
    },
    attempts: (key, step) => instances.get(key)?.attempts.get(step) ?? 0,
    async advance(ms) {
      clock += ms
      await Promise.all([...instances.values()].filter((i) => i.status === 'waiting').map(drive))
    },
    async idle() {
      await Promise.all([...instances.values()].map((i) => i.chain))
    },
  }
}
