// The flows kit on real Cloudflare Workflows: the payment fulfilment example
// Worker is bundled with esbuild and served by Miniflare, whose Workflows
// engine keeps step results, replays runs and delivers events. Miniflare and
// esbuild are heavy, so they are not dev dependencies: point WORKERD_TOOLS at
// a folder whose node_modules holds both, or the test is skipped.
//
//   npm i --prefix /tmp/wt esbuild miniflare && WORKERD_TOOLS=/tmp/wt bun test test/flows.workerd.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const tools = process.env.WORKERD_TOOLS
const run = tools ? describe : describe.skip

const payment = (id: string) => ({ id, status: 'paid', rail: 'manual_bank', purpose: 'billing', tenant_id: 'tA', invoice_ref: 'INV-0042', order_level: 'professional', order_months: 12 })
const tenant = { id: 'tA', level: 'essential', status: 'rehearsal', basis: null, order_ref: null, missing: [], version: 1 }

run('flows: Cloudflare Workflows under workerd', () => {
  let mf: { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; dispose(): Promise<void> }

  beforeAll(async () => {
    const esbuild = await import(join(tools!, 'node_modules/esbuild/lib/main.js'))
    const { Miniflare } = await import(join(tools!, 'node_modules/miniflare/dist/src/index.js'))
    const out = await esbuild.build({
      entryPoints: [join(import.meta.dir, '../examples/flows-worker.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      mainFields: ['module', 'main'],
      target: 'es2022',
      external: ['cloudflare:workers'],
    })
    mf = new Miniflare({
      modules: true,
      script: out.outputFiles[0].text,
      compatibilityDate: '2026-07-01',
      workflows: { PAYMENT_FULFIL: { name: 'payment-fulfil', className: 'PaymentFulfil' } },
    })
    // Wait for workerd to be up here, inside the start-up allowance, so a slow
    // start under load is not charged to the first test.
    await mf.ready
  }, 60_000)
  afterAll(async () => mf?.dispose())

  const post = async (path: string, body: unknown) => (await mf.dispatchFetch(`https://flows.example${path}`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<any>
  const state = async (key: string) => (await mf.dispatchFetch(`https://flows.example/run?key=${encodeURIComponent(key)}`)).json() as Promise<any>
  const until = async (key: string, ok: (s: any) => boolean, ms = 15_000) => {
    const end = Date.now() + ms
    for (;;) {
      const s = await state(key)
      if (ok(s)) return s
      if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(s.run)} ${JSON.stringify(s.steps)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  test('dry run: the whole workflow runs on Workflows and writes nothing', async () => {
    await post('/setup', { payments: [payment('pay_dry')], tenant, mode: 'dry_run' })
    expect((await post('/event', { payment_id: 'pay_dry', rail: 'manual_bank', purpose: 'billing' }))[0].outcome).toBe('started')
    const s = await until('fulfil:pay_dry', (x) => x.run?.status === 'ok')
    expect(s.writes).toEqual([])
    expect(s.run.report).toEqual(['level: would set tA from essential to professional', 'go_live: would make tA live on order INV-0042', 'tell: would send payment_fulfilled'])
    expect(s.steps.map((r: any) => `${r.key}:${r.status}`)).toEqual(['check:ok', 'tenant:ok', 'order:ok', 'invoice:skipped', 'level:planned', 'term:skipped', 'checks:ok', 'go_live:planned', 'tell:planned'])
    expect((await post('/event', { payment_id: 'pay_dry', rail: 'manual_bank', purpose: 'billing' }))[0].outcome).toBe('exists')
  }, 30_000)

  test('live: an approval pauses the Workflow and its decision resumes it', async () => {
    await post('/setup', { payments: [payment('pay_live')], tenant, mode: 'live' })
    await post('/event', { payment_id: 'pay_live', rail: 'manual_bank', purpose: 'billing' })
    let s = await until('fulfil:pay_live', (x) => x.steps.some((r: any) => r.key === 'level' && r.status === 'waiting'))
    expect(s.run.status).toBe('waiting')
    const level = s.steps.find((r: any) => r.key === 'level').approvalId
    expect((await post('/decide', { approvalId: level, approve: true })).outcome).toBe('approved')
    s = await until('fulfil:pay_live', (x) => x.steps.some((r: any) => r.key === 'go_live' && r.status === 'waiting'))
    expect(s.tenants[0].level).toBe('professional')
    const go = s.steps.find((r: any) => r.key === 'go_live').approvalId
    await post('/decide', { approvalId: go, approve: true })
    s = await until('fulfil:pay_live', (x) => x.run?.status === 'ok')
    expect(s.tenants[0]).toMatchObject({ status: 'live', basis: 'order', order_ref: 'INV-0042' })
    expect(s.calls.tenant_level_set).toBe(1)
    expect(s.calls.tenant_go_live_approve).toBe(1)
    expect(s.notices.length).toBe(1)
  }, 30_000)

  test('live: an approved change that fails runs once and goes to a person; the run waits, then stops', async () => {
    await post('/setup', { payments: [payment('pay_fail')], tenant: { ...tenant, level: 'essential', status: 'rehearsal' }, mode: 'live', fail: { tenant_level_set: 5 } })
    await post('/event', { payment_id: 'pay_fail', rail: 'manual_bank', purpose: 'billing' })
    let s = await until('fulfil:pay_fail', (x) => x.steps.some((r: any) => r.key === 'level' && r.status === 'waiting'))
    const before = s.calls.tenant_level_set ?? 0
    const checksBefore = s.calls.go_live_checks ?? 0
    await post('/decide', { approvalId: s.steps.find((r: any) => r.key === 'level').approvalId, approve: true })
    s = await until('fulfil:pay_fail', (x) => x.steps.some((r: any) => r.key === 'level' && r.status === 'failed'))
    expect(s.calls.tenant_level_set - before).toBe(1)
    expect(s.handoffs.at(-1)).toMatchObject({ step: 'level', kind: 'failed' })
    expect(s.run.status).toBe('waiting')
    await post('/resolve', { key: 'fulfil:pay_fail', step: 'level', action: 'stop' })
    s = await until('fulfil:pay_fail', (x) => x.run?.status === 'stopped')
    expect(s.calls.tenant_level_set - before).toBe(1)
    expect(s.calls.go_live_checks ?? 0).toBe(checksBefore)
  }, 30_000)
})
