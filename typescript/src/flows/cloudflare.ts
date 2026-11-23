// Cloudflare Workflows. `flowEntrypoint` turns a workflow into a
// WorkflowEntrypoint class; the product passes Cloudflare's base class in, so
// this module never imports `cloudflare:workers` and the kit still loads in
// Node and Bun. `cloudflareStarter` starts runs and sends events through the
// Workflow bindings.
//
//     import { WorkflowEntrypoint } from 'cloudflare:workers'
//     export class PaymentFulfil extends flowEntrypoint(WorkflowEntrypoint, paymentFulfil, (env) => depsFor(env)) {}
//
//     # wrangler.toml
//     [[workflows]]
//     name = "payment-fulfil"
//     binding = "PAYMENT_FULFIL"
//     class_name = "PaymentFulfil"

import type { BaseCtx } from '../capabilities/capability.js'
import { sha256Hex } from '../guard/crypto.js'
import { runFlow } from './engine.js'
import type { FlowStarter } from './runtime.js'
import type { FlowDeps, FlowParams, FlowResult, RetryConfig, StepHost, WaitResult } from './types.js'
import type { Workflow } from './workflow.js'

/** What the kit uses of Cloudflare's `WorkflowStep`. */
export interface WorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>
  do<T>(name: string, config: { retries?: { limit: number; delay: number | string; backoff?: 'constant' | 'linear' | 'exponential' }; timeout?: number | string }, callback: () => Promise<T>): Promise<T>
  waitForEvent<T>(name: string, opts: { type: string; timeout?: number | string }): Promise<{ payload: T; type: string; timestamp: Date }>
}

/** What the kit uses of a Workflow binding. */
export interface WorkflowBindingLike {
  create(opts: { id?: string; params?: unknown }): Promise<{ id: string }>
  get(id: string): Promise<{ id: string; sendEvent(e: { type: string; payload: unknown }): Promise<void>; status(): Promise<{ status: string }> }>
}

/** A step host over Cloudflare's `WorkflowStep`. */
export function cloudflareHost(step: WorkflowStepLike): StepHost {
  return {
    do<T>(name: string, config: { retries?: RetryConfig } | undefined, fn: () => Promise<T>) {
      if (!config?.retries) return step.do(name, fn)
      const r = config.retries
      // Cloudflare asks for a delay with every retry setting; it does not matter at limit 0.
      return step.do(name, { retries: { limit: r.limit, delay: r.delay ?? 10_000, backoff: r.backoff ?? 'exponential' } }, fn)
    },
    async waitForEvent<T>(name: string, o: { type: string; timeoutMs: number }): Promise<WaitResult<T>> {
      try {
        const e = await step.waitForEvent<T>(name, { type: o.type, timeout: o.timeoutMs })
        return { payload: e.payload }
      } catch {
        // Cloudflare throws when the wait times out; the throw is kept and replayed like a result.
        return { timedOut: true }
      }
    },
  }
}

/** The constructor of Cloudflare's `WorkflowEntrypoint`. */
// biome-ignore lint/suspicious/noExplicitAny: Cloudflare's base class takes (ctx, env).
export type WorkflowEntrypointCtor = abstract new (ctx: any, env: any) => any

/**
 * A WorkflowEntrypoint class that runs `wf`. `deps` builds the kit's pieces
 * from the Worker's env, once per run invocation.
 */
export function flowEntrypoint<C extends BaseCtx, Env = unknown>(Base: WorkflowEntrypointCtor, wf: Workflow, deps: (env: Env) => FlowDeps<C> | Promise<FlowDeps<C>>) {
  abstract class FlowEntrypoint extends Base {
    async run(event: { payload: FlowParams; instanceId: string }, step: WorkflowStepLike): Promise<FlowResult> {
      const d = await deps((this as unknown as { env: Env }).env)
      const params: FlowParams = { ...event.payload, key: event.payload?.key ?? event.instanceId }
      return runFlow(cloudflareHost(step), wf, d, params)
    }
  }
  return FlowEntrypoint as unknown as new (ctx: unknown, env: Env) => { run(event: { payload: FlowParams; instanceId: string }, step: WorkflowStepLike): Promise<FlowResult> }
}

const ID = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/

/**
 * The Cloudflare instance id for a run key. Keys such as `fulfil:pay_42` hold
 * characters Cloudflare refuses, so those get a cleaned prefix and a hash.
 */
export async function instanceIdFor(key: string): Promise<string> {
  if (ID.test(key)) return key
  const clean = key.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 70)
  return `${clean || 'run'}-${(await sha256Hex(key)).slice(0, 16)}`
}

/** Starts runs through the Workflow bindings, one per workflow id. */
export function cloudflareStarter(bindings: Readonly<Record<string, WorkflowBindingLike>>): FlowStarter & { instance(key: string): Promise<{ id: string; status(): Promise<{ status: string }> }> } {
  // The runtime sends events by run key; the binding is found by trying each.
  const owner = new Map<string, WorkflowBindingLike>()
  const bindingFor = (wf: Workflow) => {
    const b = bindings[wf.id]
    if (!b) throw new Error(`no Workflow binding for ${wf.id}`)
    return b
  }
  const find = async (key: string) => {
    const id = await instanceIdFor(key)
    const known = owner.get(key)
    if (known) return known.get(id)
    for (const b of Object.values(bindings)) {
      try {
        const inst = await b.get(id)
        owner.set(key, b)
        return inst
      } catch {
        // not this binding
      }
    }
    throw new Error(`no Workflow instance for ${key}`)
  }
  return {
    async start(wf, params) {
      const b = bindingFor(wf)
      const id = await instanceIdFor(params.key)
      try {
        await b.create({ id, params })
      } catch (e) {
        // An instance with this id already exists: one run per key.
        if (/exist/i.test((e as Error)?.message ?? '')) return { started: false }
        throw e
      }
      owner.set(params.key, b)
      return { started: true }
    },
    async send(key, event) {
      const inst = await find(key)
      await inst.sendEvent(event)
    },
    instance: find,
  }
}
