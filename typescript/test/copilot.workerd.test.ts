// The copilot example Worker under workerd: threads in a real Durable Object,
// runs, nonces and grants in D1, the model a fake Core API that Miniflare's
// outbound service answers. Miniflare and esbuild are heavy, so they are not
// dev dependencies: point WORKERD_TOOLS at a folder whose node_modules holds
// both, or the test is skipped.
//
//   npm i --prefix /tmp/wt esbuild miniflare && WORKERD_TOOLS=/tmp/wt bun test test/copilot.workerd.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fakeCore, reply } from '../src/testing/index'

const tools = process.env.WORKERD_TOOLS
const ok = !!tools && existsSync(join(tools, 'node_modules/esbuild')) && existsSync(join(tools, 'node_modules/miniflare'))
const run = ok ? describe : describe.skip

run('copilot: the example Worker under workerd', () => {
  let mf: { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; dispose(): Promise<void> }
  const fake = fakeCore({ baseUrl: 'https://core.test/api/v1/core', fallback: reply.text('Noted.') })

  beforeAll(async () => {
    const esbuild = await import(join(tools!, 'node_modules/esbuild/lib/main.js'))
    const { Miniflare } = await import(join(tools!, 'node_modules/miniflare/dist/src/index.js'))
    const out = await esbuild.build({
      entryPoints: [join(import.meta.dir, '../examples/copilot-worker.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      mainFields: ['module', 'main'],
      target: 'es2022',
    })
    mf = new Miniflare({
      modules: true,
      script: out.outputFiles[0].text,
      compatibilityDate: '2026-07-01',
      durableObjects: { COPILOT_THREADS: 'CopilotThreads' },
      d1Databases: ['DB'],
      bindings: { OMAZY_TOKEN: 'cai_test.test', OMAZY_BASE_URL: 'https://core.test/api/v1/core', GUARD_SECRET: 'test-secret-test-secret-test-secret-0123' },
      outboundService: (req: Request) => fake.fetch(req),
    })
    // Wait for workerd to be up here, inside the start-up allowance, so a slow
    // start under load is not charged to the first test.
    await mf.ready
  }, 60_000)
  afterAll(async () => mf?.dispose())

  const chat = async (thread: string, text: string, person = 'u_rina') => {
    const res = await mf.dispatchFetch('https://notes.example/copilot/chat', {
      method: 'POST',
      headers: { 'x-demo-person': person },
      body: JSON.stringify({ id: thread, trigger: 'submit-message', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }], screen: { name: 'notes' } }),
    })
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    const body = await res.text()
    return body
      .split('\n\n')
      .map((f) => f.replace(/^data: /, ''))
      .filter((f) => f && f !== '[DONE]')
      .map((f) => JSON.parse(f))
  }
  const post = async (path: string, body: unknown, person = 'u_rina') =>
    (await mf.dispatchFetch(`https://notes.example${path}`, { method: 'POST', headers: { 'x-demo-person': person }, body: JSON.stringify(body) })).json() as Promise<any>
  const get = async (path: string, person = 'u_rina') => (await mf.dispatchFetch(`https://notes.example${path}`, { headers: { 'x-demo-person': person } })).json() as Promise<any>

  test('a consent card in the stream, the click runs it, the thread is kept in its Durable Object', async () => {
    fake.push(reply.tool('note_add', { title: 'Buy milk' }), reply.text('A card is up for you to confirm.'))
    const chunks = await chat('th1', 'add a note: buy milk')
    const card = chunks.find((c) => c.type === 'data-consent')
    expect(card.data).toMatchObject({ capability: 'note_add', status: 'waiting', preview: { summary: 'Add the note "Buy milk".' } })
    expect(await get('/notes')).toEqual([])
    const c = await post(`/copilot/cards/${card.data.id}/confirm`, { thread: 'th1' })
    expect(c.outcome).toBe('confirmed')
    expect(await get('/notes')).toEqual([{ id: 1, title: 'Buy milk' }])
    const h = await get('/copilot/threads/th1')
    expect(h.messages.map((m: any) => m.role)).toEqual(['user', 'assistant'])
    expect(h.messages[1].parts.find((p: any) => p.type === 'data-consent').data.status).toBe('confirmed')
    // Another person's thread of the same id is empty.
    expect((await get('/copilot/threads/th1', 'u_karim')).messages).toEqual([])
  }, 30_000)

  test('an approval card for R3, and a batch held whole', async () => {
    fake.push(reply.tools([{ name: 'notes_list', input: {} }, { name: 'note_share', input: { id: 1, email: 'a@example.com' } }]), reply.text('It waits for an owner.'))
    const chunks = await chat('th2', 'list my notes and email the first to a@example.com')
    const outs = chunks.filter((c) => c.type === 'tool-output-available').map((c) => c.output.status)
    expect(outs).toEqual(['not_run', 'pending_approval'])
    const a = chunks.find((c) => c.type === 'data-approval')
    expect(a.data.reviewUrl).toBe(`/approvals/${a.data.id}`)
    // Only an owner refuses it; the guard's event moves the card in the thread's Durable Object.
    expect((await post(`/approvals/${a.data.id}/refuse`, { reason: 'Not to that address.' })).outcome).toBe('not_allowed')
    expect((await post(`/approvals/${a.data.id}/refuse`, { reason: 'Not to that address.' }, 'u_owner')).outcome).toBe('refused')
    const card = async () => (await get('/copilot/threads/th2')).messages[1].parts.find((p: any) => p.type === 'data-approval').data
    for (let i = 0; i < 50 && (await card()).status === 'waiting'; i++) await new Promise((r) => setTimeout(r, 20))
    expect(await card()).toMatchObject({ status: 'refused', message: 'Not to that address.' })
    expect((await get('/copilot/threads/th2')).approvals).toEqual([])
  }, 30_000)

  test('a standing grant set on the settings route runs an R2 without a card; the conversation resumes from D1', async () => {
    expect((await post('/settings/grants', { capability: 'note_add', days: 30, dailyCap: 1 })).ok).toBe(true)
    fake.push(reply.tool('note_add', { title: 'Call Rina' }), reply.text('Added.'))
    const chunks = await chat('th1', 'add a note: call Rina')
    expect(chunks.filter((c) => c.type === 'tool-output-available').map((c) => c.output.status)).toEqual(['ok'])
    expect((await get('/notes')).map((n: any) => n.title)).toEqual(['Buy milk', 'Call Rina'])
    // The model read the first turn of this thread from D1.
    const last = fake.completions().filter((x) => JSON.stringify(x.body.messages).includes('call Rina'))[0]!
    expect(JSON.stringify(last.body.messages)).toContain('add a note: buy milk')
    // The person's threads, newest first, from D1's ai_threads.
    expect((await get('/copilot/threads')).threads.map((t: any) => t.id)).toEqual(['th1', 'th2'])
    expect((await get('/copilot/threads', 'u_karim')).threads).toEqual([])
  }, 30_000)

  test('another person on the same thread id gets their own Durable Object, conversation and list', async () => {
    fake.push(reply.text('Hello Karim.'), reply.text('You said hello.'))
    await chat('th1', 'hello from karim', 'u_karim')
    await chat('th1', 'what did I say?', 'u_karim')
    const karimSaw = JSON.stringify(fake.completions().at(-1)!.body.messages)
    expect(karimSaw).toContain('hello from karim')
    expect(karimSaw).not.toContain('buy milk')
    const h = await get('/copilot/threads/th1', 'u_karim')
    expect(h.messages.map((m: any) => m.parts.find((p: any) => p.type === 'text')?.text)).toEqual(['hello from karim', 'Hello Karim.', 'what did I say?', 'You said hello.'])
    expect((await get('/copilot/threads', 'u_karim')).threads.map((t: any) => t.id)).toEqual(['th1'])
    // Rina's thread of that id is as it was.
    expect((await get('/copilot/threads/th1')).messages.length).toBe(4)
    expect((await get('/copilot/threads')).threads.map((t: any) => t.id)).toEqual(['th1', 'th2'])
  }, 30_000)
})
