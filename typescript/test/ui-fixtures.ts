// Shared by the ui tests: two capabilities, and uiRoutes over a real guard,
// memory and grants, with a fake connected apps source. `clientFor(ctx)`
// gives a uiClient whose fetch goes straight to the routes as that person.

import { type BaseCtx, defineCapabilities, registry, schema } from '../src/capabilities/index'
import { createMemory, memoryMemoryStore } from '../src/ai/index'
import { createGrants, memoryGrantStore } from '../src/copilot/index'
import { approver, createGuard, memoryGuardStore, policies } from '../src/guard/index'
import { uiClient } from '../src/ui/index'
import { type AppsSource, uiRoutes } from '../src/ui/server'

type Perm = 'notes.write' | 'notes.share'
const { capability } = defineCapabilities<BaseCtx, Perm, 'org'>()
const noteAdd = capability({
  name: 'note_add',
  audiences: ['org'],
  title: 'Add a note',
  description: 'Adds one note with a title to this account. The person confirms it on a card first. Not for sharing.',
  permission: 'notes.write',
  risk: 'R2',
  input: schema.object({ title: schema.text(200) }),
  version: 1,
  preview: (_c, i) => ({ summary: `Add "${i.title}".` }),
  run: (_c, i) => ({ added: i.title }),
})
const noteShare = capability({
  name: 'note_share',
  audiences: ['org'],
  title: 'Share a note',
  description: 'Shares one note with someone outside the account. An owner approves it first. Not for adding a note.',
  permission: 'notes.share',
  risk: 'R3',
  approval: 'owner',
  input: schema.object({ id: schema.integer({ min: 1 }) }),
  version: 1,
  preview: (_c, i) => ({ summary: `Share note ${i.id}.`, before: { shared: false }, after: { shared: true } }),
  run: () => ({ shared: true }),
})
const reg = registry([noteAdd, noteShare])

export const ctxOf = (id: string, channel = 'console', tenant = 'tA'): BaseCtx => ({
  principal: { kind: 'member', id, name: id === 'owner' ? 'Hemi' : undefined },
  seat: { id: `seat_${id}`, door: 'org', tenant },
  tenant,
  channel,
  approvalId: null,
  requestId: `req_${id}`,
})

export function kit() {
  const store = memoryGuardStore()
  const guard = createGuard<BaseCtx, Perm>({
    registry: reg,
    can: () => true,
    secret: 'test-secret-test-secret-test-secret-0123',
    store,
    policies: { owner: policies.single({ approver: approver.role('owner'), stepUp: 'passkey', expires: '24h' }) },
    rolesOf: (c) => (c.principal.id === 'owner' ? ['owner'] : []),
    stepUp: { methods: ['passkey'], verify: async (_c, proof) => (proof.assertion === 'good' ? { ok: true, method: 'passkey' } : { ok: false, reason: 'The passkey did not match.' }) },
    reviewUrl: (a) => `/approvals/${a.id}`,
  })
  const mem = createMemory<BaseCtx>({ store: memoryMemoryStore() })
  const grants = createGrants<BaseCtx>({ store: memoryGrantStore(), registry: reg })
  const revoked: string[] = []
  const apps: AppsSource = {
    connectedApps: async (person) => ({
      apps: [{ grantId: 'g1', clientId: 'https://claude.ai/oauth', clientName: 'Claude', status: 'known', door: 'org', seatId: `seat_${person}`, tenant: 'tA', createdAt: 1, expiresAt: null, lastUsedAt: null }],
      keys: [{ id: 'k1', kind: 'personal', name: 'laptop', door: 'org', tenant: 'tA', owner: person, createdAt: 1, expiresAt: 2, lastUsedAt: null }],
    }),
    revokeApp: async (_p, id) => (id === 'g1' ? (revoked.push(id), true) : false),
    keys: { revoke: async (_p, id) => (id === 'k1' ? (revoked.push(id), true) : false) },
  }
  const routes = uiRoutes<BaseCtx>({ approvals: { guard, store, reviewUrl: (a) => `/approvals/${a.id}` }, apps, memory: mem, grants, registry: reg })
  /** A fetch that answers `/ui/...` from the routes as this person. */
  const fetchFor = (ctx: BaseCtx) =>
    (async (url: string, init?: RequestInit) => (await routes.handle(new Request(`https://app.example${url}`, init), ctx)) ?? new Response('no route', { status: 404 })) as unknown as typeof fetch
  const clientFor = (ctx: BaseCtx) => uiClient({ fetch: fetchFor(ctx) })
  return { guard, store, mem, grants, routes, fetchFor, clientFor, revoked }
}
