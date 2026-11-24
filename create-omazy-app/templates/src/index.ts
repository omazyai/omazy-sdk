// The Worker. Each isolate builds the app once, on D1, KV and Durable
// Objects, and routes:
//
//   /health        a plain answer for uptime checks
//   /mcp           the MCP door: personal keys (npm run key)
//#if copilot
//   /              the copilot page, /copilot/* its turns, /ui/* its screens
//#endif
//#if oauth
//   OAuth routes   only when OAUTH is "on" (see src/oauth.ts)
//#endif

//#if flow
import { WorkflowEntrypoint } from 'cloudflare:workers'
//#endif
//#if actor
import { d1SessionStore } from '@omazyai/sdk/actors'
//#endif
//#if ai
import { Omazy } from '@omazyai/sdk'
import { d1MemoryStore, d1RunStore } from '@omazyai/sdk/ai'
//#endif
//#if copilot
import { CopilotThreadObject, d1GrantStore, durableObjectThreads } from '@omazyai/sdk/copilot'
//#endif
//#if flow
import { cloudflareStarter, d1FlowStore, flowEntrypoint } from '@omazyai/sdk/flows'
//#endif
import { d1GuardStore, d1RequestLog, d1Switches } from '@omazyai/sdk/guard'
//#if copilot
import { UI_CSS } from '@omazyai/sdk/ui'
//#endif
import { type App, buildApp } from './app'
//#if copilot
import { PAGE, PAGE_CSP, PAGE_CSS } from './copilot'
//#endif
import type { Env } from './env'
//#if flow
import { noteFollowup } from './flow'
//#endif
import { keysFor } from './keys'
import { d1Notes } from './notes'
//#if oauth
import { oauthFor, signInPage } from './oauth'
//#endif
import { DOOR } from './types'

//#if oauth
export { OAuthRefreshLock } from './oauth'
//#endif

let app: App | undefined

function appFor(env: Env): App {
  if (app) return app
  const keys = keysFor(env.KV)
//#if oauth
  const oauth = oauthFor(env)
//#endif
  app = buildApp({
    notes: d1Notes(env.DB),
    guardStore: d1GuardStore(env.DB),
    log: d1RequestLog(env.DB),
    // Read at most every 2 seconds per isolate, so turning the door off takes effect within that.
    switches: d1Switches(env.DB, { cacheMs: 2000 }),
    secret: env.GUARD_SECRET,
    doorDefault: env.DOOR_DEFAULT === 'on' ? 'on' : 'off',
    // Wire your mail or SMS sender here. STEP_UP_LOG=1 in .dev.vars prints the
    // code to the wrangler dev console instead; never set it in production.
    sendCode: (ctx, _channel, code) => {
      if (env.STEP_UP_LOG !== '1') throw new Error('no code sender: wire mail or SMS in src/index.ts')
      console.log(`approval code for ${ctx.principal.id}: ${code}`)
    },
//#if oauth
    ...(oauth ? oauth.door(DOOR) : { resolveSeat: async (token: string) => (await keys.resolve(token, DOOR))?.grant ?? null }),
//#else
    resolveSeat: async (token) => (await keys.resolve(token, DOOR))?.grant ?? null,
//#endif
//#if ai
    omazy: () => {
      if (!env.OMAZY_TOKEN) throw new Error('OMAZY_TOKEN is not set: npx wrangler secret put OMAZY_TOKEN')
      return new Omazy({ token: env.OMAZY_TOKEN, ...(env.OMAZY_BASE_URL ? { baseUrl: env.OMAZY_BASE_URL } : {}) })
    },
    runs: d1RunStore(env.DB),
    memory: d1MemoryStore(env.DB),
//#endif
//#if actor
    sessions: d1SessionStore(env.DB),
//#endif
//#if flow
    flowStore: d1FlowStore(env.DB),
    starter: () => cloudflareStarter({ [noteFollowup.id]: env.NOTE_FOLLOWUP }),
//#endif
//#if copilot
    threads: durableObjectThreads(env.COPILOT_THREADS),
    grants: d1GrantStore(env.DB),
//#endif
  })
  return app
}

//#if copilot
/** The seat a page request carries, by its bearer key. */
async function seatOf(req: Request, env: Env, a: App, channel: 'copilot' | 'console') {
  const token = req.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1]
  const found = token ? await keysFor(env.KV).resolve(token, DOOR) : null
  return found ? a.ctxFor(found.grant, channel) : null
}

//#endif
export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/health') return Response.json({ ok: true })
    const a = appFor(env)
//#if oauth
    const oauth = oauthFor(env)
    if (oauth) {
      if (url.pathname === '/sign-in') return signInPage(req, env, oauth)
      const routed = await oauth.route(req, exec)
      if (routed) return routed
    }
//#endif
//#if copilot
    if (url.pathname === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP } })
    if (url.pathname === '/ui.css') return new Response(UI_CSS + PAGE_CSS, { headers: { 'content-type': 'text/css; charset=utf-8' } })
    if (url.pathname === '/app.js') return env.ASSETS.fetch(req)
    for (const [prefix, channel] of [
      ['/copilot/', 'copilot'],
      ['/ui/', 'console'],
    ] as const) {
      if (!url.pathname.startsWith(prefix)) continue
      const ctx = await seatOf(req, env, a, channel)
      if (!ctx) return Response.json({ error: 'unauthorized', message: 'Sign in with your personal key.' }, { status: 401 })
      const handler = channel === 'copilot' ? a.copilot : a.ui
      const res = await handler.handle(req, ctx, { waitUntil: (p) => exec.waitUntil(p) })
      if (res) return res
    }
//#endif
    return a.door.fetch(req, env, exec)
  },
}
//#if flow

/** The workflow's Cloudflare entrypoint. Its steps run the same capabilities through the same guard. */
export class NoteFollowup extends flowEntrypoint(WorkflowEntrypoint, noteFollowup, (env: Env) => appFor(env).flowDeps) {}
//#endif
//#if copilot

/** One Durable Object per copilot thread. */
export class CopilotThreads extends CopilotThreadObject {}
//#endif
