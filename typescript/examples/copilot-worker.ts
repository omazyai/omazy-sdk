// A Worker with a copilot on a notes product: capabilities, guard, ai and
// copilot together. Threads live in a Durable Object, the conversation, runs,
// confirm nonces and standing grants in D1. The page at `/` runs the ui
// kit's copilot panel, standing grants and approvals inbox from
// `examples/copilot-page.ts`, bundled to `/app.js` and served as a static
// asset; `uiRoutes` answers them at `/ui/`. The page has no inline script
// and a strict content security policy.
//
// The person comes from an `x-demo-person` header (default `u_demo`). That is
// for trying the kit only: a product builds the ctx from its own session.
//
// DEMO ONLY: the owner's step-up is the guard's `codeStepUp`, and with
// DEMO_STEP_UP_CODES=1 the code is handed back to the page instead of sent by
// email, so the approve path can be tried without a mail sender. Set it in
// `.dev.vars` for `wrangler dev` only, never in wrangler.toml or a deployed
// Worker; without it the route answers 404 and no code is ever made. The page
// also shows the code only in a development build.
//
//   # wrangler.toml
//   main = "examples/copilot-worker.ts"
//   compatibility_date = "2026-07-01"
//   [[durable_objects.bindings]]
//   name = "COPILOT_THREADS"
//   class_name = "CopilotThreads"
//   [[migrations]]
//   tag = "v1"
//   new_sqlite_classes = ["CopilotThreads"]
//   [[d1_databases]]
//   binding = "DB"
//   database_name = "copilot-demo"
//   database_id = "..."
//   [assets]
//   directory = "examples/public"
//   binding = "ASSETS"
//   # and the secrets OMAZY_TOKEN and GUARD_SECRET
//   # .dev.vars, for wrangler dev only: DEMO_STEP_UP_CODES=1
//
//   # the page, before `wrangler deploy`:
//   npx esbuild examples/copilot-page.ts --bundle --format=esm --minify --outfile=examples/public/app.js

import { Omazy } from '../src/index'
import { applyAiMigrations, copilotUnit, createAi, d1MemoryStore, d1RunStore, promptTemplates } from '../src/ai/index'
import { type BaseCtx, defineCapabilities, registry, schema } from '../src/capabilities/index'
import { applyGrantMigrations, CopilotThreadObject, createCopilot, createGrants, d1GrantStore, durableObjectThreads } from '../src/copilot/index'
import { applyGuardMigrations, approver, codeStepUp, createGuard, type D1DatabaseLike, d1GuardStore, policies } from '../src/guard/index'
import type { DurableObjectNamespaceLike } from '../src/actors/index'
import { UI_CSS } from '../src/ui/index'
import { uiRoutes } from '../src/ui/server'

interface Env {
  COPILOT_THREADS: DurableObjectNamespaceLike
  DB: D1DatabaseLike
  OMAZY_TOKEN: string
  /** Default the production Core API. */
  OMAZY_BASE_URL?: string
  GUARD_SECRET: string
  /** Static assets: `/app.js`, the bundled page. */
  ASSETS?: { fetch(req: Request): Promise<Response> }
  /** DEMO ONLY, `.dev.vars` only: `1` hands the step-up code to the page. Never set in production. */
  DEMO_STEP_UP_CODES?: string
}

type Door = 'org'
type Permission = 'notes.read' | 'notes.write' | 'notes.share'
const { capability } = defineCapabilities<BaseCtx, Permission, Door>()

// ---------------------------------------------------------------- the product's data and capabilities

const NOTES_SQL = 'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, title TEXT NOT NULL)'

const notesList = capability({
  name: 'notes_list',
  audiences: ['org'],
  title: 'List notes',
  description: 'Lists the notes of this account, newest first, with their ids and titles. Not for reading what a note says: notes have only a title.',
  synonyms: ['my notes', 'what notes do I have'],
  permission: 'notes.read',
  risk: 'R0',
  input: schema.object({}),
  version: 1,
  run: async (ctx) => ({ rows: (await db.prepare('SELECT id, title FROM notes WHERE tenant = ? ORDER BY id DESC LIMIT 50').bind(ctx.tenant ?? '').all()).results ?? [] }),
})

const noteAdd = capability({
  name: 'note_add',
  audiences: ['org'],
  title: 'Add a note',
  description: 'Adds one note with a title to this account. The person confirms it on a card first. Not for changing a note: notes cannot be edited.',
  synonyms: ['write down', 'remember this note'],
  permission: 'notes.write',
  risk: 'R2',
  input: schema.object({ title: schema.text(200) }),
  version: 1,
  preview: (_ctx, i) => ({ summary: `Add the note "${i.title}".` }),
  run: async (ctx, i) => {
    await db.prepare('INSERT INTO notes (tenant, title) VALUES (?, ?)').bind(ctx.tenant ?? '', i.title).run()
    return { added: i.title }
  },
})

const noteShare = capability({
  name: 'note_share',
  audiences: ['org'],
  title: 'Share a note by email',
  description: 'Emails one note to an address outside the account. It reaches someone outside, so an owner approves it first. Not for adding a note: use note_add.',
  permission: 'notes.share',
  risk: 'R3',
  approval: 'owner',
  openWorld: true,
  input: schema.object({ id: schema.integer({ min: 1 }), email: schema.string({ max: 200, format: 'email' }) }),
  pii: ['email'],
  version: 1,
  preview: (_ctx, i) => ({ summary: `Email note ${i.id} to ${i.email}.` }),
  run: () => ({ sent: true }),
})

const reg = registry([notesList, noteAdd, noteShare])

const unit = copilotUnit({
  id: 'notes_copilot',
  version: 1,
  owner: 'notes',
  model: { use: 'converse' },
  prompt: { template: 'copilot/notes', version: 1, languages: ['en'] },
  context: { layers: ['platform', 'unit'], budgetTokens: 16_000, untrusted: ['message'] },
  memory: { read: ['working', 'conversation'], write: [] },
  tools: { allow: ['notes_list', 'note_add', 'note_share'], maxTier: 'R3' },
  evals: 'evals/notes-copilot.jsonl',
  caps: { perRunUsd: 0.05, perDayUsd: 5 },
})

const prompts = promptTemplates({ 'copilot/notes': { 1: { en: 'You help a person keep short notes. Answer briefly.' } } })

// ---------------------------------------------------------------- wiring, once per isolate

let db: D1DatabaseLike
let ready: Promise<void> | undefined
let app: ReturnType<typeof build> | undefined

function build(env: Env) {
  let copilotRef: ReturnType<typeof createCopilot<BaseCtx>> | undefined
  const guardStore = d1GuardStore(env.DB)
  // DEMO ONLY. A product's `send` emails or texts the code to the decider and
  // never returns it. Here, with DEMO_STEP_UP_CODES=1, it is kept for the
  // demo route below to hand to the page once; without it nothing is sent.
  const demoCodes = new Map<string, string>()
  const stepUp = codeStepUp<BaseCtx>({
    store: guardStore,
    send: (_ctx, _channel, code, b) => {
      if (env.DEMO_STEP_UP_CODES !== '1') throw new Error('this demo has no code sender')
      demoCodes.set(`${b.approvalId}:${b.person}`, code)
    },
  })
  const guard = createGuard<BaseCtx, Permission>({
    registry: reg,
    can: () => true,
    secret: env.GUARD_SECRET,
    store: guardStore,
    policies: { owner: policies.single({ approver: approver.role('owner'), stepUp: 'code', expires: '24h' }) },
    stepUp,
    // The demo's owner is the person u_owner.
    rolesOf: (c) => (c.principal.id === 'u_owner' ? ['owner'] : ['member']),
    reviewUrl: (a) => `/approvals/${a.id}`,
    // An approval card's status follows the guard's events.
    onApproval: (e) => copilotRef?.onApproval(e),
  })
  const ai = createAi<BaseCtx>({
    omazy: () => new Omazy({ token: env.OMAZY_TOKEN, ...(env.OMAZY_BASE_URL ? { baseUrl: env.OMAZY_BASE_URL } : {}), maxRetries: 0 }),
    runs: d1RunStore(env.DB),
    memory: d1MemoryStore(env.DB),
    prompts,
    guard,
    registry: reg,
    layers: { platform: () => 'You are the notes copilot.' },
  })
  const grants = createGrants<BaseCtx>({ store: d1GrantStore(env.DB), registry: reg })
  const copilot = createCopilot<BaseCtx>({ ai, registry: reg, unit, threads: durableObjectThreads(env.COPILOT_THREADS), audience: 'org', standingGrants: grants })
  copilotRef = copilot
  // The ui kit's routes for the page: standing grants, approvals and memory.
  const ui = uiRoutes<BaseCtx>({ grants, registry: reg, approvals: { guard, store: guardStore, reviewUrl: (a) => `/approvals/${a.id}` }, ...(ai.memory ? { memory: ai.memory } : {}) })
  return { copilot, grants, guard, guardStore, stepUp, demoCodes, ui }
}

const ctxOf = (req: Request, channel: 'copilot' | 'console'): BaseCtx => {
  const id = (req.headers.get('x-demo-person') ?? 'u_demo').replace(/[^a-z0-9_]/g, '').slice(0, 40) || 'u_demo'
  return { principal: { kind: 'member', id }, seat: { id: `seat_${id}`, door: 'org', tenant: 'demo' }, tenant: 'demo', channel, approvalId: null, requestId: crypto.randomUUID() }
}

export class CopilotThreads extends CopilotThreadObject {}

export default {
  async fetch(req: Request, env: Env, ectx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    db = env.DB
    ready ??= (async () => {
      await applyGuardMigrations(env.DB)
      await applyAiMigrations(env.DB)
      await applyGrantMigrations(env.DB)
      await env.DB.prepare(NOTES_SQL).run()
    })()
    await ready
    app ??= build(env)
    const url = new URL(req.url)
    if (url.pathname === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP } })
    if (url.pathname === '/ui.css') return new Response(UI_CSS + PAGE_CSS, { headers: { 'content-type': 'text/css; charset=utf-8' } })
    if (url.pathname === '/app.js') return env.ASSETS ? env.ASSETS.fetch(req) : new Response('build the page first (see the top of this file)', { status: 404 })
    if (url.pathname.startsWith('/ui/')) {
      const res = await app.ui.handle(req, ctxOf(req, 'console'), { waitUntil: (p) => ectx.waitUntil(p) })
      if (res) return res
    }
    if (url.pathname.startsWith('/copilot/')) {
      const res = await app.copilot.handle(req, ctxOf(req, 'copilot'), { waitUntil: (p) => ectx.waitUntil(p) })
      if (res) return res
    }
    // The settings page's call: a person sets a standing grant here, never in the chat.
    if (url.pathname === '/settings/grants' && req.method === 'POST') {
      const body = (await req.json()) as { capability: string; days: number; dailyCap: number }
      return Response.json(await app.grants.set(ctxOf(req, 'console'), body))
    }
    // DEMO ONLY: starts the owner's step-up and hands the code to the page.
    // 404 unless DEMO_STEP_UP_CODES=1, so a deployed Worker never answers it.
    const demoCode = url.pathname.match(/^\/demo\/step-up\/([A-Za-z0-9_-]{1,64})$/)
    if (demoCode && req.method === 'POST') {
      if (env.DEMO_STEP_UP_CODES !== '1') return new Response('not found', { status: 404 })
      if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return new Response('send JSON', { status: 415 })
      const ctx = ctxOf(req, 'console')
      const id = demoCode[1]!
      const may = await app.guard.canDecide(id, ctx)
      const row = may.ok ? await app.guardStore.getApproval(id) : null
      if (!row) return Response.json({ error: { code: 'not_allowed', message: may.ok ? 'No such approval.' : may.message } }, { status: 403 })
      const started = await app.stepUp.start(ctx, row)
      const key = `${id}:${ctx.principal.id}`
      const code = app.demoCodes.get(key)
      app.demoCodes.delete(key)
      return Response.json({ demo: true, channels: started.channels, expiresAt: started.expiresAt, code }, { headers: { 'cache-control': 'no-store' } })
    }
    // The review page's refusal. Refusing needs a reason and no step-up: it is the safe direction.
    // An approval id is apr_ and base64url, so it may hold - and _.
    const refuse = url.pathname.match(/^\/approvals\/([A-Za-z0-9_-]{1,64})\/refuse$/)
    if (refuse && req.method === 'POST') {
      const body = (await req.json()) as { reason?: string }
      const out = await app.guard.decide(refuse[1]!, ctxOf(req, 'console'), { approve: false, reason: body.reason ?? '' }, { waitUntil: (p) => ectx.waitUntil(p) })
      return Response.json({ outcome: out.outcome })
    }
    if (url.pathname === '/notes') return Response.json((await env.DB.prepare('SELECT id, title FROM notes ORDER BY id').all()).results ?? [])
    return new Response('not found', { status: 404 })
  },
}

// ---------------------------------------------------------------- the page

/** The kit's optional stylesheet plus the page's own layout. */
const PAGE_CSS = `
body { margin: 0; }
.notes-page { font: 15px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; display: grid; gap: 2rem; }
.notes-chat .omz-log { max-height: 60vh; }
`

/** No inline script, no inline style, no other origin, no framing. */
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notes copilot</title>
<link rel="stylesheet" href="/ui.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<div id="root"></div>
</body>
</html>`
