// A Worker that serves a notes product over MCP: capabilities, guard and mcp
// together, on the in-memory adapters. Memory lives as long as the isolate,
// so this is for trying the kits, not for production: swap in D1 adapters
// for that.
//
//   npx wrangler dev examples/mcp-worker.ts
//   curl -s localhost:8787/org -H 'authorization: Bearer demo-org-key' \
//     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
//     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

import { type Ctx, defineCapabilities, registry, schema } from '../src/capabilities/index'
import { approver, createGuard, memoryGuardStore, memoryRateLimiter, memoryRequestLog, memorySwitches, policies } from '../src/guard/index'
import { mcpDoors, mcpServer, type SeatGrant } from '../src/mcp/index'

type Door = 'org' | 'platform'
type Permission = 'notes.read' | 'notes.write' | 'notes.purge'
type AppCtx = Ctx<{ roles: readonly string[] }>
const { capability } = defineCapabilities<AppCtx, Permission, Door>()

// The product's own data. A Map per tenant stands in for a table.
const notes = new Map<string, { id: string; title: string }[]>()
const of = (tenant: string | null) => notes.get(tenant ?? '') ?? []

const notesList = capability({
  name: 'notes_list',
  audiences: ['org'],
  title: 'List notes',
  description: 'Lists the notes of the current branch, newest first, with their ids and titles. Not for searching inside a note: there is no search yet.',
  permission: 'notes.read',
  risk: 'R0',
  input: schema.object({ limit: schema.integer({ min: 1, max: 100 }).default(20) }),
  output: schema.object({ rows: schema.array(schema.object({ id: schema.text(40), title: schema.text(200) })) }),
  version: 1,
  run: (ctx, i) => ({ rows: of(ctx.tenant).slice(-i.limit).reverse() }),
})

const noteAdd = capability({
  name: 'note_add',
  audiences: ['org'],
  title: 'Add a note',
  description: 'Adds one note with a title to the current branch. The person confirms it first. Not for changing a note: notes cannot be edited.',
  permission: 'notes.write',
  risk: 'R2',
  input: schema.object({ title: schema.text(200) }),
  output: schema.object({ id: schema.text(40), title: schema.text(200) }),
  version: 1,
  preview: (_ctx, i) => ({ summary: `Add the note "${i.title}".` }),
  run: (ctx, i) => {
    const row = { id: `n${of(ctx.tenant).length + 1}`, title: i.title }
    notes.set(ctx.tenant ?? '', [...of(ctx.tenant), row])
    return row
  },
})

const notesPurge = capability({
  name: 'notes_purge',
  audiences: ['org'],
  title: 'Delete every note',
  description: 'Deletes every note of the current branch. It cannot be undone, so a branch owner approves it with a code first. Not for one note: there is no single delete.',
  permission: 'notes.purge',
  risk: 'R4',
  approval: 'owner_step_up',
  input: schema.object({}),
  version: 1,
  preview: (ctx) => ({ summary: `Delete all ${of(ctx.tenant).length} notes.` }),
  run: (ctx) => {
    notes.delete(ctx.tenant ?? '')
    return { deleted: true }
  },
})

const reg = registry([notesList, noteAdd, notesPurge])

// Demo keys. A product keeps these hashed in its own table.
const KEYS: Record<string, SeatGrant & { roles: string[] }> = {
  'demo-org-key': { principal: { kind: 'member', id: 'rina' }, seat: { id: 'seat-rina', door: 'org', tenant: 'branch-1' }, roles: ['owner'] },
  'demo-personal-key': { principal: { kind: 'member', id: 'tanvir' }, seat: { id: 'seat-tanvir', door: 'org', tenant: 'branch-1' }, roles: [], maxTier: 'R2' },
}
const PERMISSIONS: Record<string, readonly Permission[]> = { owner: ['notes.read', 'notes.write', 'notes.purge'] }

const guard = createGuard<AppCtx, Permission>({
  registry: reg,
  can: (ctx, permission) => permission !== 'notes.purge' || ctx.roles.some((r) => PERMISSIONS[r]?.includes(permission)),
  secret: 'demo-secret-change-me-in-production-0123456789',
  store: memoryGuardStore(),
  policies: { owner_step_up: policies.single({ approver: approver.role('owner'), stepUp: 'code', expires: '24h' }) },
  rolesOf: (ctx) => ctx.roles,
  switches: memorySwitches(),
  rateLimit: memoryRateLimiter(),
  log: memoryRequestLog(),
  reviewUrl: (a) => `https://notes.example/approvals/${a.id}`,
})

const worker = mcpDoors(
  mcpServer<AppCtx, Door>({
    registry: reg,
    guard,
    door: 'org',
    info: { name: 'notes-org', version: '1.0.0', title: 'Notes' },
    instructions: 'Notes for one branch. List them, add one after the person confirms, or ask an owner to delete them all.',
    resolveSeat: (token) => KEYS[token] ?? null,
    ctx: (base, grant) => ({ ...base, roles: (grant as (typeof KEYS)[string]).roles }),
    resources: [{ uri: 'notes://docs/tiers', name: 'tiers', mimeType: 'text/markdown', read: () => '# Tiers\n\nR0 reads, R2 asks to confirm, R4 needs an owner.' }],
    prompts: [{ name: 'weekly_notes', description: 'Summarise the notes of the week.', get: () => 'List the notes and summarise them in three lines.' }],
  }),
)

export default {
  fetch: (req: Request, env: unknown, exec: { waitUntil(p: Promise<unknown>): void }) => worker.fetch(req, env, exec),
}
