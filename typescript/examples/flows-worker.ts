// The payment fulfilment example on Cloudflare Workflows. The kit's state
// (flow store, guard store, the stand-in data) lives in memory in the
// isolate, so this is for trying the kit, not for production: use
// d1FlowStore, d1GuardStore and d1RunStore there.
//
//   # wrangler.toml
//   main = "examples/flows-worker.ts"
//   compatibility_date = "2026-07-01"
//   [[workflows]]
//   name = "payment-fulfil"
//   binding = "PAYMENT_FULFIL"
//   class_name = "PaymentFulfil"

import { WorkflowEntrypoint } from 'cloudflare:workers'
import { cloudflareStarter, flowEntrypoint, type WorkflowBindingLike } from '../src/flows/index'
import { fulfilment, paymentFulfil, seats } from './flows-payment-fulfil'

interface Env {
  PAYMENT_FULFIL: WorkflowBindingLike
}

let app: ReturnType<typeof fulfilment> | undefined
const appFor = (env: Env) => {
  app ??= fulfilment({ starter: () => cloudflareStarter({ payment_fulfil: env.PAYMENT_FULFIL }) })
  return app
}

export class PaymentFulfil extends flowEntrypoint(WorkflowEntrypoint, paymentFulfil, (env: Env) => appFor(env).deps) {}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const a = appFor(env)
    const url = new URL(req.url)
    const body = req.method === 'POST' ? ((await req.json()) as Record<string, any>) : {}
    switch (url.pathname) {
      case '/setup': {
        for (const p of body.payments ?? []) a.w.payments.set(p.id, p)
        if (body.tenant) a.w.tenants.set(body.tenant.id, body.tenant)
        for (const [name, n] of Object.entries(body.fail ?? {})) a.w.fail.set(name, n as number)
        return json(await a.automations.enable(seats.finance(), 'payment_fulfil', { mode: body.mode ?? 'dry_run' }))
      }
      case '/event':
        return json(await a.automations.dispatch({ type: 'payment.approve', tenant: null, data: body }))
      case '/run': {
        const key = url.searchParams.get('key') ?? ''
        return json({ run: await a.flows.run(key), steps: await a.flows.steps(key), calls: Object.fromEntries(a.w.calls), writes: a.w.writes, handoffs: a.handoffs, notices: a.notices, tenants: [...a.w.tenants.values()] })
      }
      case '/decide': {
        const d = await a.guard.decide(body.approvalId, seats.admin(), body.approve ? { approve: true, proof: { method: 'code', codes: { email: '000000' } } } : { approve: false, reason: body.reason ?? 'no' }, { waitUntil: (p) => ctx.waitUntil(p) })
        return json({ outcome: d.outcome })
      }
      case '/resolve':
        await a.flows.resolve(body.key, body.step, { action: body.action, by: 'u_finance' })
        return json({ ok: true })
      default:
        return json({ error: 'not found' }, 404)
    }
  },
}
