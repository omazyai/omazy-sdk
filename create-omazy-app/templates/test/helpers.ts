// The app on memory stores, for tests: the same buildApp the Worker runs.

//#if actor
import { memorySessionStore } from '@omazyai/sdk/actors'
//#endif
//#if ai
import { type CoreLike, memoryMemoryStore, memoryRunStore } from '@omazyai/sdk/ai'
//#endif
//#if copilot
import { memoryGrantStore, memoryThreadStore } from '@omazyai/sdk/copilot'
//#endif
//#if flow
import { type MemoryRunner, memoryFlowStore, memoryRunner } from '@omazyai/sdk/flows'
//#endif
import { type Guard, memoryGuardStore, memoryRequestLog, memorySwitches } from '@omazyai/sdk/guard'
import { memoryKv } from '@omazyai/sdk/oauth/keys'
//#if ai
import { type FakeCore, fakeCore } from '@omazyai/sdk/testing'
//#endif
import { buildApp } from '../src/app'
//#if flow
import { noteFollowup } from '../src/flow'
//#endif
import { keysFor } from '../src/keys'
import { memoryNotes } from '../src/notes'
import { type AppCtx, DOOR } from '../src/types'

export const SECRET = 'test-secret-test-secret-test-secret-0123'

export interface HarnessOptions {
  doorDefault?: 'on' | 'off'
//#if ai
  fake?: FakeCore
  /** Another Core client for the units, such as evalCore's live one. Default the fake's. */
  core?: CoreLike
//#endif
  /** Wraps the guard before the rest of the app uses it, such as with spyGuard. */
  wrapGuard?: (g: Guard<AppCtx>) => Guard<AppCtx>
}

export function harness(o: HarnessOptions = {}) {
  const notes = memoryNotes()
  const kv = memoryKv()
  const keys = keysFor(kv)
  const log = memoryRequestLog()
  const switches = memorySwitches()
  const guardStore = memoryGuardStore()
//#if ai
  const fake = o.fake ?? fakeCore({})
//#endif
//#if flow
  let runner: MemoryRunner | undefined
//#endif
  const pending: Promise<unknown>[] = []
  const app = buildApp({
    notes,
    guardStore,
    log,
    switches,
    secret: SECRET,
    doorDefault: o.doorDefault ?? 'on',
    resolveSeat: async (token) => (await keys.resolve(token, DOOR))?.grant ?? null,
//#if ai
    omazy: () => o.core ?? fake.client,
    runs: memoryRunStore(),
    memory: memoryMemoryStore(),
//#endif
//#if actor
    sessions: memorySessionStore(),
//#endif
//#if flow
    flowStore: memoryFlowStore(),
    starter: (deps) => (runner = memoryRunner(deps, [noteFollowup])),
//#endif
//#if copilot
    threads: memoryThreadStore(),
    grants: memoryGrantStore(),
//#endif
  }, o.wrapGuard)

  /** A ctx for a person in a tenant, as their personal key gives it. */
  const seat = (person = 'rina', tenant = 'tenant_a', channel = 'mcp'): AppCtx => ({
    principal: { kind: 'member', id: person, name: person },
    seat: { id: `seat_${person}`, door: DOOR, tenant },
    tenant,
    channel,
    approvalId: null,
    requestId: crypto.randomUUID(),
  })

  /** Mints a personal key, as `npm run key` does. */
  const mint = async (person = 'rina', tenant = 'tenant_a') =>
    (await keys.createPersonal({ principal: { kind: 'member', id: person, name: person }, seat: { id: `seat_${person}`, door: DOOR, tenant }, name: 'test', days: 1 })).key

  /** One JSON-RPC request to the MCP door, as a 2025-06-18 client. */
  const rpc = async (method: string, params: unknown, key: string | null, id = 1) => {
    const res = await app.door.fetch(
      new Request('https://app.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }),
      undefined,
      { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    )
    await Promise.all(pending.splice(0))
    const text = await res.text()
    return { status: res.status, body: text ? (JSON.parse(text) as any) : null }
  }

  return {
    app,
    notes,
    keys,
    log,
    switches,
    guardStore,
//#if ai
    fake,
//#endif
//#if flow
    runner: () => {
      if (!runner) throw new Error('no runner')
      return runner
    },
//#endif
    seat,
    mint,
    rpc,
  }
}
