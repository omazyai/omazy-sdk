// The copilot example's page under workerd: the Worker is bundled and served
// by Miniflare, the page (examples/copilot-page.ts) is bundled as its static
// asset, and the page's React tree is rendered in happy-dom with its fetch
// going to Miniflare. A person sends a message, the consent card arrives on
// the stream, the click runs the change, and a standing grant is set from
// the settings section. Then a share needs the owner's approval: the owner
// opens it in the inbox, passes the demo code step-up and the share runs.
// The model is a fake Core API on the outbound service.
//
// esbuild and miniflare are devDependencies, so this runs in every `bun test`
// after `npm ci`. WORKERD_TOOLS=<folder> loads them from <folder>/node_modules
// instead. Without them the file is skipped, unless OMAZY_REQUIRE_WORKERD=1
// (the release check). OMAZY_SKIP_WORKERD=1 always skips.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fakeCore, reply } from '../src/testing/index'
import { byText, openDom } from './ui-dom'

async function loadTools(): Promise<{ esbuild: any; Miniflare: any } | null> {
  const tools = process.env.WORKERD_TOOLS
  try {
    if (tools) {
      const esbuild = await import(join(tools, 'node_modules/esbuild/lib/main.js'))
      const { Miniflare } = await import(join(tools, 'node_modules/miniflare/dist/src/index.js'))
      return { esbuild, Miniflare }
    }
    const esbuild = await import('esbuild')
    const { Miniflare } = await import('miniflare')
    return { esbuild, Miniflare }
  } catch (e) {
    if (process.env.OMAZY_REQUIRE_WORKERD === '1') throw new Error(`ui.workerd.test: esbuild and miniflare are required (OMAZY_REQUIRE_WORKERD=1): ${String(e)}`)
    return null
  }
}

const loaded = process.env.OMAZY_SKIP_WORKERD === '1' ? null : await loadTools()
const run = loaded ? describe : describe.skip
const BASE = 'https://notes.example'

/**
 * Waits, inside act, until `done()` holds, and fails with `what` when it does
 * not within `ms`. A loop with a count fell through when the machine was slow
 * and the test then asserted on a half-drawn page.
 */
async function until(dom: { act(f: () => Promise<void>): Promise<void> }, what: string, done: () => boolean, ms = 20_000) {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await dom.act(async () => void (await Bun.sleep(20)))
  }
}

/** The reply has finished streaming: its card is drawn and the log is no longer busy. */
const streamed = (root: Element, card: string) => !!root.querySelector(card) && !root.querySelector('[role="log"][aria-busy="true"]')

run('ui: the copilot example page under workerd', () => {
  let mf: { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; dispose(): Promise<void> }
  let page = ''
  const fake = fakeCore({ baseUrl: 'https://core.test/api/v1/core', fallback: reply.text('Noted.') })

  beforeAll(async () => {
    const { esbuild, Miniflare } = loaded!
    const worker = await esbuild.build({
      entryPoints: [join(import.meta.dir, '../examples/copilot-worker.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      mainFields: ['module', 'main'],
      target: 'es2022',
    })
    const app = await esbuild.build({
      entryPoints: [join(import.meta.dir, '../examples/copilot-page.ts')],
      bundle: true,
      write: false,
      minify: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    page = app.outputFiles[0].text as string
    mf = new Miniflare({
      modules: true,
      script: worker.outputFiles[0].text,
      compatibilityDate: '2026-07-01',
      durableObjects: { COPILOT_THREADS: 'CopilotThreads' },
      d1Databases: ['DB'],
      bindings: { OMAZY_TOKEN: 'cai_test.test', OMAZY_BASE_URL: 'https://core.test/api/v1/core', GUARD_SECRET: 'test-secret-test-secret-test-secret-0123', DEMO_STEP_UP_CODES: '1' },
      serviceBindings: { ASSETS: () => new Response(page, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }) },
      outboundService: (req: Request) => fake.fetch(req),
    })
  }, 60_000)
  afterAll(async () => mf?.dispose())

  test('the page has no inline script, a strict policy, the kit stylesheet and the bundled app', async () => {
    const res = await mf.dispatchFetch(`${BASE}/`)
    const html = await res.text()
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe-inline')
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    expect(scripts).toHaveLength(1)
    expect(scripts[0]![1]).toContain('src="/app.js"')
    expect(scripts[0]![2]!.trim()).toBe('')
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i)
    const css = await (await mf.dispatchFetch(`${BASE}/ui.css`)).text()
    expect(css).toContain('--omz-accent')
    const js = await mf.dispatchFetch(`${BASE}/app.js`)
    expect(js.headers.get('content-type')).toContain('javascript')
    expect((await js.text()).length).toBe(page.length)
    // The production build of the page carries no demo step-up.
    expect(page).not.toContain('Demo only')
    expect(page).not.toContain('/demo/step-up/')
  }, 30_000)

  test('the panel in happy-dom: a message, the consent card from the stream, the click, then a standing grant', async () => {
    const dom = await openDom()
    try {
      const { NotesPage } = await import('../examples/copilot-page')
      const calls: string[] = []
      const f = (async (url: string, init: RequestInit = {}) => {
        const { signal: _signal, ...rest } = init
        calls.push(`${rest.method ?? 'GET'} ${url}`)
        const r = await mf.dispatchFetch(new URL(url, BASE).toString(), rest)
        return new Response(r.body as ReadableStream<Uint8Array> | null, { status: r.status, headers: Object.fromEntries(r.headers) })
      }) as unknown as typeof fetch
      const el = await dom.render(dom.React.createElement(NotesPage, { thread: 'ui1', person: 'u_rina', fetch: f }))
      expect(el.querySelector('h1')?.textContent).toBe('Notes copilot')
      expect(calls).toContain('GET /copilot/threads/ui1')

      fake.push(reply.tool('note_add', { title: 'Buy milk' }), reply.text('A card is up for you to confirm.'))
      await dom.type(el.querySelector('textarea')!, 'add a note: buy milk')
      await dom.key(el.querySelector('textarea')!, 'Enter')
      // The card and the reply after it arrive on one stream. The card shows
      // while the reply text may still stream in, so wait for the end of the
      // stream, then check both.
      await until(dom, 'the end of the reply stream', () => streamed(el, '.omz-card--consent'))
      const card = el.querySelector('.omz-card--consent')!
      expect(card.getAttribute('data-status')).toBe('waiting')
      expect(card.textContent).toContain('Add the note "Buy milk".')
      expect(el.querySelector('[role="log"]')?.textContent).toContain('A card is up for you to confirm.')
      expect(await (await mf.dispatchFetch(`${BASE}/notes`)).json()).toEqual([])

      await dom.click(byText(card, 'button', 'Confirm'))
      await until(dom, 'the card to leave waiting', () => card.getAttribute('data-status') !== 'waiting')
      expect(card.getAttribute('data-status')).toBe('confirmed')
      expect(await (await mf.dispatchFetch(`${BASE}/notes`)).json()).toEqual([{ id: 1, title: 'Buy milk' }])

      // The settings section on uiRoutes: only R2 capabilities, and the grant shows with what is left today.
      const grants = el.querySelector('select')!.closest('section')!
      expect([...grants.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Add a note'])
      await dom.click(byText(grants, 'button', 'Allow'))
      await until(dom, 'the standing grant', () => !!grants.querySelector('li'))
      expect(grants.querySelector('li')?.textContent).toContain('Add a note')
      expect(grants.querySelector('li')?.textContent).toContain('10 of 10 left today')
      expect(calls).toContain('POST /ui/grants')
    } finally {
      await dom.close()
    }
  }, 60_000)

  test('an owner approves a share in the inbox with the demo code step-up, and the share runs', async () => {
    const dom = await openDom()
    try {
      const { NotesPage } = await import('../examples/copilot-page')
      const f = (async (url: string, init: RequestInit = {}) => {
        const { signal: _signal, ...rest } = init
        const r = await mf.dispatchFetch(new URL(url, BASE).toString(), rest)
        return new Response(r.body as ReadableStream<Uint8Array> | null, { status: r.status, headers: Object.fromEntries(r.headers) })
      }) as unknown as typeof fetch
      const wait = (what: string, done: () => boolean) => until(dom, what, done)

      // Rina asks for the share; the guard holds it for the owner.
      const rina = await dom.render(dom.React.createElement(NotesPage, { thread: 'ui2', person: 'u_rina', fetch: f }))
      fake.push(reply.tool('note_share', { id: 1, email: 'kim@example.com' }), reply.text('The owner decides on the share.'))
      await dom.type(rina.querySelector('textarea')!, 'share note 1 with kim@example.com')
      await dom.key(rina.querySelector('textarea')!, 'Enter')
      await wait('the end of the reply stream', () => streamed(rina, '.omz-card--approval') && !!byText(rina, 'button', 'Send'))
      expect(rina.querySelector('[role="log"]')?.textContent).toContain('The owner decides on the share.')
      const card = rina.querySelector('.omz-card--approval')!
      expect(card.getAttribute('data-status')).toBe('waiting')
      expect(card.textContent).toContain('Email note 1 to kim@example.com.')

      // Rina may not decide it, so the demo route makes no code for her.
      const [waiting] = ((await (await mf.dispatchFetch(`${BASE}/ui/approvals`, { headers: { 'x-demo-person': 'u_owner' } })).json()) as { approvals: { id: string }[] }).approvals
      const forRina = await mf.dispatchFetch(`${BASE}/demo/step-up/${waiting!.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-person': 'u_rina' }, body: '{}' })
      expect(forRina.status).toBe(403)
      expect(await forRina.json()).not.toHaveProperty('code')

      // The owner opens it, approves, gets the demo code and types it.
      const owner = await dom.render(dom.React.createElement(NotesPage, { thread: 'ui3', person: 'u_owner', fetch: f }))
      await wait('the approval in the inbox', () => !!byText(owner, 'button', /Share a note by email/))
      await dom.click(byText(owner, 'button', /Share a note by email/))
      const detail = owner.querySelector('.omz-inbox__detail')!
      expect(detail.textContent).toContain('Email note 1 to kim@example.com.')
      await dom.click(byText(detail, 'button', 'Approve'))
      expect(detail.querySelector('.omz-stepup')?.textContent).toContain('Demo only.')
      await dom.click(byText(detail, 'button', 'Get a demo code'))
      await wait('the demo code', () => !!detail.querySelector('.notes-demo-code code'))
      const code = detail.querySelector('.notes-demo-code code')!.textContent!
      expect(code).toMatch(/^[0-9]{6}$/)
      await dom.type(detail.querySelector('.omz-stepup input')!, code)
      await dom.click(byText(detail, 'button', 'Verify and approve'))
      await wait('the decision', () => detail.querySelector('.omz-status')?.getAttribute('data-status') !== 'waiting')
      expect(detail.querySelector('.omz-status')?.getAttribute('data-status')).toBe('executed')
      expect(detail.querySelector('.omz-note')?.textContent).toContain('Approved')

      // The guard ran it once, and the requester sees it done.
      const all = ((await (await mf.dispatchFetch(`${BASE}/ui/approvals?status=all`, { headers: { 'x-demo-person': 'u_rina' } })).json()) as { approvals: { id: string; status: string; verification: string | null }[] }).approvals
      expect(all.find((a) => a.id === waiting!.id)).toMatchObject({ status: 'executed', verification: 'code' })
      // A spent code does not work twice.
      const again = await mf.dispatchFetch(`${BASE}/ui/approvals/${waiting!.id}/decide`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-person': 'u_owner' }, body: JSON.stringify({ approve: true, proof: { method: 'code', codes: { email: code } } }) })
      expect(((await again.json()) as { outcome: string }).outcome).toBe('already_decided')
    } finally {
      await dom.close()
    }
  }, 60_000)
})
