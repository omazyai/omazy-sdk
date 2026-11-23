// Wires the kits together once per isolate. The Worker passes D1, KV and
// Durable Object stores; the tests pass memory ones, so both run the same
// code.

//#if actor
import { actorRuntime, type SessionStore } from '@omazyai/sdk/actors'
//#endif
//#if ai
import { type CoreLike, createAi, type MemoryStore, type RunStore } from '@omazyai/sdk/ai'
//#endif
//#if copilot
import { type CopilotThreadStore, createCopilot, createGrants, type GrantStore } from '@omazyai/sdk/copilot'
//#endif
//#if flow
import { createFlows, type FlowDeps, type FlowStarter, type FlowStore } from '@omazyai/sdk/flows'
//#endif
import type { Guard, GuardStore, RequestLogSink, SwitchStore } from '@omazyai/sdk/guard'
//#if copilot
import type { SeatGrant } from '@omazyai/sdk/mcp'
//#endif
//#if copilot
import { uiRoutes } from '@omazyai/sdk/ui/server'
//#endif
//#if ai
import { rolesOf } from './access'
import { PERSONA, prompts } from './ai'
//#endif
//#if actor
import { noteIntake } from './actor'
//#endif
import { reg } from './capabilities'
//#if copilot
import { notesCopilot } from './copilot'
//#endif
import { buildDoor, type SeatResolver } from './door'
//#if flow
import { noteFollowup } from './flow'
//#endif
import { buildGuard } from './guard'
import { live } from './live'
import type { NotesStore } from './notes'
//#if copilot
import { type AppCtx, DOOR } from './types'
//#else
import type { AppCtx } from './types'
//#endif

export interface AppParts {
  notes: NotesStore
  guardStore: GuardStore
  log: RequestLogSink
  switches: SwitchStore
  secret: string
  doorDefault: 'on' | 'off'
//#if oauth
  /** Turns a bearer token into a seat: personal keys, and OAuth tokens when it is on. */
//#else
  /** Turns a bearer token into a seat: a personal key. */
//#endif
  resolveSeat: SeatResolver
//#if oauth
  /** With OAuth on, where a 401 points clients for the door's metadata. */
  resourceMetadataUrl?: string
//#endif
//#if ai
  /** The Core API client for a ctx: the SDK's Omazy client in the Worker, fakeCore in tests. */
  omazy: (ctx: AppCtx) => CoreLike
  runs: RunStore
  memory: MemoryStore
//#endif
//#if actor
  sessions: SessionStore
//#endif
//#if flow
  flowStore: FlowStore
  /** Cloudflare Workflows in the Worker, the memory runner in tests. */
  starter: (deps: FlowDeps<AppCtx>) => FlowStarter
//#endif
//#if copilot
  threads: CopilotThreadStore
  grants: GrantStore
//#endif
}

/** `wrapGuard` lets a test wrap the guard (spyGuard) before anything else holds it. */
export function buildApp(p: AppParts, wrapGuard: (g: Guard<AppCtx>) => Guard<AppCtx> = (g) => g) {
  live.set({ notes: p.notes })
//#if flow
  let flowsRef: ReturnType<typeof createFlows<AppCtx>> | undefined
//#endif
//#if copilot
  let copilotRef: ReturnType<typeof createCopilot<AppCtx>> | undefined
//#endif
  const guard = wrapGuard(buildGuard({
    store: p.guardStore,
    log: p.log,
    switches: p.switches,
    secret: p.secret,
    doorDefault: p.doorDefault,
//#if flow || copilot
    // An approval's events move a waiting workflow step and the copilot's approval card.
    onApproval: async (e) => {
//#if flow
      await flowsRef?.onApproval(e)
//#endif
//#if copilot
      await copilotRef?.onApproval(e)
//#endif
    },
//#endif
  }))
  //#if oauth
  const door = buildDoor(guard, p.resolveSeat, p.resourceMetadataUrl)
//#else
  const door = buildDoor(guard, p.resolveSeat)
//#endif
//#if ai
  const ai = createAi<AppCtx>({
    omazy: p.omazy,
    runs: p.runs,
    memory: p.memory,
    prompts,
    guard,
    registry: reg,
    layers: { platform: () => PERSONA },
  })
//#endif
//#if actor
  const actors = actorRuntime<AppCtx>({ ai, registry: reg, guard, actors: [noteIntake], sessions: p.sessions })
  live.set({ actors })
//#endif
//#if flow
  const flowDeps: FlowDeps<AppCtx> = {
    ai,
    guard,
    registry: reg,
    store: p.flowStore,
    roles: rolesOf,
    // A fixed template and its data, never model text. Send mail or Slack here.
    notify: (_ctx, n) => console.log('notice', n.template, JSON.stringify(n.data)),
    // A failed write or a confirm a workflow cannot give goes to a person. Put it in your inbox here.
    handoff: (_ctx, h) => console.log('handoff', h.step, h.kind, h.message),
  }
  const flows = createFlows<AppCtx>({ store: p.flowStore, runs: ai.runs, starter: p.starter(flowDeps) })
  flowsRef = flows
  live.set({ flows })
//#endif
//#if copilot
  const grants = createGrants<AppCtx>({ store: p.grants, registry: reg })
  const copilot = createCopilot<AppCtx>({
    ai,
//#if actor
    // The registry holds the door's actor tools: the copilot finds the actor
    // there and hands off with its own actor_start.
//#endif
    registry: reg,
    unit: notesCopilot,
    threads: p.threads,
    audience: DOOR,
    standingGrants: grants,
  })
  copilotRef = copilot
  const ui = uiRoutes<AppCtx>({ grants, registry: reg, approvals: { guard, store: p.guardStore }, memory: ai.memory })
//#endif
  return {
    guard,
    door,
//#if ai
    ai,
//#endif
//#if actor
    actors,
//#endif
//#if flow
    flows,
    flowDeps,
//#endif
//#if copilot
    copilot,
    ui,
    /** The ctx for a seat on a route that is not MCP: the copilot's and the page's. */
    ctxFor: (grant: SeatGrant, channel: string, requestId: string = crypto.randomUUID()): AppCtx => ({
      principal: grant.principal,
      seat: grant.seat,
      tenant: grant.seat.tenant,
      channel,
      approvalId: null,
      requestId,
    }),
//#endif
  }
}

export type App = ReturnType<typeof buildApp>
