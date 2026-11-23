import { describe, expect, test } from 'bun:test'
import { type BaseCtx, capability, createRegistry, schema } from '../src/capabilities/index'
import { type Guard, type GuardOutcome, type LogRequestInput, REQUEST_ID_HEADER, type AnonymousLogInput } from '../src/guard/index'
import { mcpDoors, mcpServer, type SeatGrant } from '../src/mcp/index'

const desc = (s: string) => `${s} This sentence pads the description to the length the registry asks of every capability.`

const tenantsList = capability({
  name: 'tenants_list',
  audiences: ['platform'],
  title: 'List tenants',
  description: desc('Lists every tenant with its state.'),
  permission: 'tenants.read',
  risk: 'R0',
  input: schema.object({ limit: schema.integer({ min: 1, max: 50 }).default(10) }),
  output: schema.object({ rows: schema.array(schema.object({ id: schema.text(64) })) }),
  version: 1,
  run: (_c, i) => ({ rows: Array.from({ length: Math.min(i.limit, 2) }, (_, n) => ({ id: `t${n}` })) }),
})
const tenantUpdate = capability({
  name: 'tenant_update',
  audiences: ['platform'],
  title: 'Update a tenant',
  description: desc('Renames one tenant.'),
  permission: 'tenants.write',
  risk: 'R2',
  input: schema.object({ id: schema.text(64), name: schema.text(80) }),
  version: 1,
  preview: (_c, i) => ({ summary: `Rename ${i.id} to ${i.name}.` }),
  run: (_c, i) => ({ id: i.id, name: i.name }),
})
const tenantDelete = capability({
  name: 'tenant_delete',
  audiences: ['platform'],
  title: 'Delete a tenant',
  description: desc('Deletes one tenant and every record it holds.'),
  permission: 'tenants.delete',
  risk: 'R4',
  approval: 'super_admin_step_up',
  input: schema.object({ id: schema.text(64) }),
  version: 1,
  preview: (_c, i) => ({ summary: `Delete ${i.id}.` }),
  run: () => ({ ok: true }),
})
const reportBoom = capability({
  name: 'report_boom',
  audiences: ['platform'],
  title: 'Break',
  description: desc('Always fails inside, to test the alert hook.'),
  permission: 'x',
  risk: 'R0',
  input: schema.object({}),
  version: 1,
  run: () => {
    throw new Error('secret database detail')
  },
})
const staffList = capability({
  name: 'staff_list',
  audiences: ['org'],
  title: 'List staff',
  description: desc('Lists the staff of the current tenant.'),
  permission: 'staff.read',
  risk: 'R1',
  input: schema.object({}),
  version: 1,
  run: () => ({ rows: [] }),
})
const many = Array.from({ length: 7 }, (_, n) =>
  capability({
    name: `widget_get${n}`,
    audiences: ['platform'],
    title: `Widget ${n}`,
    description: desc(`Reads widget ${n}.`),
    permission: 'w',
    risk: 'R0',
    input: schema.object({}),
    version: 1,
    run: () => ({ n }),
  }),
)
const reg = createRegistry([tenantsList, tenantUpdate, tenantDelete, reportBoom, staffList, ...many])

// A stand-in for createGuard with the same outcomes, until the real one lands.
function fakeGuard() {
  const logs: LogRequestInput[] = []
  const anon: AnonymousLogInput[] = []
  const calls: { name: string; args: unknown; confirmToken?: string }[] = []
  let doorOff = false
  let switchesDown = false
  const guard: Guard<BaseCtx> = {
    async doorSwitch(door) {
      if (switchesDown) throw new Error('switch store down')
      return doorOff && door === 'platform' ? { key: 'door:platform', scope: 'global', subject: null, on: false, reason: 'The platform door is off for maintenance.' } : null
    },
    async call(ctx, name, args, opts = {}): Promise<GuardOutcome<any>> {
      calls.push({ name, args, confirmToken: opts.confirmToken })
      const requestId = ctx.requestId
      if (doorOff) return { outcome: 'switched_off', code: 'switched_off', message: 'The platform door is off for maintenance.', requestId, switch: { key: 'door:platform', scope: 'global', subject: null } }
      const p = await reg.parse(name, args)
      if (!p.ok) return { outcome: 'invalid', code: 'invalid_arguments', message: 'The arguments are not valid.', issues: p.issues, requestId }
      const c = p.capability
      try {
        if (p.tier === 'R2') {
          const token = `tok.${name}.${JSON.stringify(p.input)}`
          if (opts.confirmToken !== token) return { outcome: 'confirm_required', preview: await c.preview!(ctx, p.input), token, expiresAt: '2026-11-24T10:10:00Z', requestId, tier: 'R2' }
        }
        if (p.tier === 'R3' || p.tier === 'R4')
          return {
            outcome: 'pending_approval',
            requestId,
            approval: { id: 'ap1', policy: c.approval!, decider: 'A super admin', expiresAt: '2026-11-24T11:00:00Z', preview: await c.preview!(ctx, p.input), reviewUrl: 'https://admin.example/approvals/ap1' },
          }
        return { outcome: 'ok', result: await c.run(ctx, p.input), requestId, tier: p.tier }
      } catch (e) {
        return { outcome: 'error', code: 'run_failed', message: 'That did not work.', requestId }
      }
    },
    logRequest: (_ctx, input) => void logs.push(input),
    logAnonymous: (input) => void anon.push(input),
    decide: async () => ({ outcome: 'not_found' }),
    execute: async () => ({ outcome: 'error', code: 'x', message: 'x', requestId: '' }),
    approval: async () => null,
    approvalArgs: async () => null,
    canDecide: async () => ({ ok: true }),
    expireDue: async () => 0,
    policyFor: async () => null,
  }
  return { guard, logs, anon, calls, setDoorOff: (v: boolean) => void (doorOff = v), setSwitchesDown: (v: boolean) => void (switchesDown = v) }
}

const seats: Record<string, SeatGrant> = {
  plat: { principal: { kind: 'member', id: 'u1' }, seat: { id: 's1', door: 'platform', tenant: null } },
  org: { principal: { kind: 'member', id: 'u2' }, seat: { id: 's2', door: 'org', tenant: 't1' } },
  personal: { principal: { kind: 'member', id: 'u3' }, seat: { id: 's3', door: 'platform', tenant: null }, maxTier: 'R2' },
}

function setup(extra: Partial<Parameters<typeof mcpServer>[0]> = {}) {
  const g = fakeGuard()
  const failures: unknown[] = []
  const common = { registry: reg, guard: g.guard, resolveSeat: (t: string) => seats[t] ?? null, onError: (f: unknown) => void failures.push(f) }
  const platform = mcpServer({ ...common, door: 'platform', info: { name: 'test-platform', version: '1' }, instructions: 'Platform tools.', pageSize: 5, ...extra } as never)
  const org = mcpServer({ ...common, door: 'org', info: { name: 'test-org', version: '1' } } as never)
  return { ...g, failures, worker: mcpDoors(platform, org), platform }
}

const MODERN_META = (caps: Record<string, unknown> = {}) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': caps,
})

type W = { fetch(req: Request): Promise<Response> }
let id = 0
async function legacy(w: W, method: string, params?: unknown, opts: { token?: string; version?: string; path?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (opts.token !== '') headers.authorization = `Bearer ${opts.token ?? 'plat'}`
  if (opts.version) headers['mcp-protocol-version'] = opts.version
  const res = await w.fetch(new Request(`https://mcp.example${opts.path ?? '/platform'}`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }) }))
  return { res, body: res.headers.get('content-type')?.includes('json') ? ((await res.json()) as any) : await res.text() }
}
async function modern(w: W, method: string, params: Record<string, unknown> = {}, opts: { token?: string; caps?: Record<string, unknown>; path?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${opts.token ?? 'plat'}`,
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
  }
  if (typeof params.name === 'string') headers['mcp-name'] = params.name
  const res = await w.fetch(
    new Request(`https://mcp.example${opts.path ?? '/platform'}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: MODERN_META(opts.caps) } }),
    }),
  )
  return { res, body: (await res.json()) as any }
}

describe('mcp: protocol negotiation', () => {
  for (const v of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    test(`initialize on ${v} answers ${v} as one JSON body`, async () => {
      const { worker, logs } = setup()
      const { res, body } = await legacy(worker, 'initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'c', version: '1' } })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(res.headers.get('mcp-session-id')).toBeNull()
      expect(body.result.protocolVersion).toBe(v)
      expect(body.result.serverInfo.name).toBe('test-platform')
      expect(body.result.instructions).toBe('Platform tools.')
      // A 2025 client served statelessly has no stream to hear the notice on.
      expect(body.result.capabilities.tools.listChanged).toBe(false)
      expect(logs.map((l) => l.method)).toEqual(['initialize'])
    })
    test(`tools/list and tools/call without a session on ${v}`, async () => {
      const { worker } = setup()
      const list = await legacy(worker, 'tools/list', undefined, { version: v })
      expect(list.body.result.tools[0].name).toBe('tenants_list')
      const call = await legacy(worker, 'tools/call', { name: 'tenants_list', arguments: { limit: 2 } }, { version: v })
      expect(call.body.result.isError).toBe(false)
      expect(call.body.result.structuredContent).toEqual({ rows: [{ id: 't0' }, { id: 't1' }] })
    })
  }
  test('an unknown version is answered with the newest 2025 one', async () => {
    const { worker } = setup()
    const { body } = await legacy(worker, 'initialize', { protocolVersion: '2024-01-01', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })
  test('2026-07-28: server/discover, no initialize, cache hints on tools/list', async () => {
    const { worker } = setup()
    const d = await modern(worker, 'server/discover')
    expect(d.body.result.supportedVersions).toEqual(['2026-07-28'])
    expect(d.body.result.instructions).toBe('Platform tools.')
    const l = await modern(worker, 'tools/list')
    expect(l.body.result.resultType).toBe('complete')
    expect(l.body.result.ttlMs).toBe(60000)
    expect(l.body.result.cacheScope).toBe('private')
    const c = await modern(worker, 'tools/call', { name: 'tenants_list', arguments: {} })
    expect(c.body.result.structuredContent.rows.length).toBe(2)
  })
  test('batches only on 2025-03-26', async () => {
    const { worker } = setup()
    const send = (v: string) =>
      worker.fetch(
        new Request('https://mcp.example/platform', {
          method: 'POST',
          headers: { authorization: 'Bearer plat', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': v },
          body: JSON.stringify([
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            { jsonrpc: '2.0', id: 2, method: 'ping' },
          ]),
        }),
      )
    const old = await send('2025-03-26')
    expect(old.status).toBe(200)
    expect(((await old.json()) as unknown[]).length).toBe(2)
    expect((await send('2025-06-18')).status).toBe(400)
  })
  test('GET on a 2025 door is 405, and every answer carries the request id', async () => {
    const { worker } = setup()
    const res = await worker.fetch(new Request('https://mcp.example/platform', { headers: { authorization: 'Bearer plat', [REQUEST_ID_HEADER]: 'req-00000042' } }))
    expect(res.status).toBe(405)
    const ok = await worker.fetch(
      new Request('https://mcp.example/platform', {
        method: 'POST',
        headers: { authorization: 'Bearer plat', 'content-type': 'application/json', accept: 'application/json, text/event-stream', [REQUEST_ID_HEADER]: 'req-00000043' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
    )
    expect(ok.headers.get(REQUEST_ID_HEADER)).toBe('req-00000043')
  })
})

describe('mcp: tools from the registry', () => {
  test('annotations from the tier, confirm_token on R2 and above, output schema', async () => {
    const { worker } = setup({ pageSize: 50 })
    const { body } = await legacy(worker, 'tools/list', undefined, { version: '2025-06-18' })
    const byName = Object.fromEntries(body.result.tools.map((t: any) => [t.name, t]))
    expect(byName.tenants_list.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(byName.tenants_list.outputSchema.type).toBe('object')
    expect(byName.tenants_list.inputSchema.properties.confirm_token).toBeUndefined()
    expect(byName.tenant_update.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(byName.tenant_update.inputSchema.properties.confirm_token.type).toBe('string')
    expect(byName.tenant_delete.annotations.destructiveHint).toBe(true)
    expect(byName.staff_list).toBeUndefined()
  })
  test('cursor paging walks the whole list once', async () => {
    const { worker } = setup()
    const names: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const { body } = await modern(worker, 'tools/list', cursor ? { cursor } : {})
      names.push(...body.result.tools.map((t: any) => t.name))
      cursor = body.result.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(names).toEqual(reg.list('platform').map((c) => c.name))
  })
  test('a bad cursor is a protocol error', async () => {
    const { worker } = setup()
    const { body } = await legacy(worker, 'tools/list', { cursor: 'nonsense' }, { version: '2025-06-18' })
    expect(body.error.code).toBe(-32602)
  })
  test('a personal key capped at R2 sees no R4 tool and cannot call one', async () => {
    const { worker } = setup({ pageSize: 50 })
    const { body } = await legacy(worker, 'tools/list', undefined, { token: 'personal', version: '2025-06-18' })
    const names = body.result.tools.map((t: any) => t.name)
    expect(names).toContain('tenant_update')
    expect(names).not.toContain('tenant_delete')
    const call = await legacy(worker, 'tools/call', { name: 'tenant_delete', arguments: { id: 't1' } }, { token: 'personal', version: '2025-06-18' })
    expect(call.body.error.code).toBe(-32602)
  })
})

describe('mcp: calls through guard outcomes', () => {
  test('confirm on a 2025 client: a result with the preview and the token, then the token runs it', async () => {
    const { worker, calls } = setup()
    const first = await legacy(worker, 'tools/call', { name: 'tenant_update', arguments: { id: 't1', name: 'Acme' } }, { version: '2025-06-18' })
    const r = first.body.result
    expect(r.isError).toBe(false)
    expect(r.structuredContent.outcome).toBe('confirm_required')
    expect(r.structuredContent.preview.summary).toBe('Rename t1 to Acme.')
    expect(r.content[0].text).toContain('confirm_token')
    const token = r.structuredContent.token
    // The guard's names, and the old ones until the next release.
    const meta = r._meta['ai.omazy/outcome']
    expect(meta).toMatchObject({ outcome: 'confirm_required', token, status: 'confirm_required', confirm_token: token })
    expect(typeof meta.expiresAt).toBe('string')
    expect(meta.expires_at).toBe(meta.expiresAt)
    const second = await legacy(worker, 'tools/call', { name: 'tenant_update', arguments: { id: 't1', name: 'Acme', confirm_token: token } }, { version: '2025-06-18' })
    expect(second.body.result.structuredContent).toEqual({ id: 't1', name: 'Acme' })
    expect(calls[1]).toEqual({ name: 'tenant_update', args: { id: 't1', name: 'Acme' }, confirmToken: token })
  })
  test('confirm on a 2026-07-28 client with elicitation: input_required, then the retry runs it', async () => {
    const { worker } = setup()
    const caps = { elicitation: { form: {} } }
    const first = await modern(worker, 'tools/call', { name: 'tenant_update', arguments: { id: 't1', name: 'Acme' } }, { caps })
    const r = first.body.result
    expect(r.resultType).toBe('input_required')
    expect(r.inputRequests.confirm.method).toBe('elicitation/create')
    expect(r.inputRequests.confirm.params.message).toContain('Rename t1 to Acme.')
    const retry = await modern(
      worker,
      'tools/call',
      { name: 'tenant_update', arguments: { id: 't1', name: 'Acme' }, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } }, requestState: r.requestState },
      { caps },
    )
    expect(retry.body.result.structuredContent).toEqual({ id: 't1', name: 'Acme' })
    const declined = await modern(
      worker,
      'tools/call',
      { name: 'tenant_update', arguments: { id: 't1', name: 'Acme' }, inputResponses: { confirm: { action: 'decline' } }, requestState: r.requestState },
      { caps },
    )
    expect(declined.body.result.structuredContent).toMatchObject({ outcome: 'declined', status: 'declined' })
  })
  test('confirm on a 2026-07-28 client without elicitation: the structured result', async () => {
    const { worker } = setup()
    const { body } = await modern(worker, 'tools/call', { name: 'tenant_update', arguments: { id: 't1', name: 'Acme' } })
    expect(body.result.resultType).toBe('complete')
    expect(body.result.structuredContent.outcome).toBe('confirm_required')
  })
  test('pending approval: a result with the review link', async () => {
    const { worker } = setup()
    const { body } = await legacy(worker, 'tools/call', { name: 'tenant_delete', arguments: { id: 't1' } }, { version: '2025-11-25' })
    expect(body.result.isError).toBe(false)
    expect(body.result.structuredContent).toMatchObject({ outcome: 'pending_approval', approval: { id: 'ap1', reviewUrl: 'https://admin.example/approvals/ap1' } })
    expect(body.result.structuredContent).toMatchObject({ status: 'pending_approval', approval_id: 'ap1', review_url: 'https://admin.example/approvals/ap1' })
    expect(body.result.content[0].text).toContain('https://admin.example/approvals/ap1')
  })
  test('invalid arguments: isError with each issue', async () => {
    const { worker } = setup()
    const { body } = await legacy(worker, 'tools/call', { name: 'tenants_list', arguments: { limit: 500 } }, { version: '2025-06-18' })
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('limit')
    expect(body.result._meta['ai.omazy/outcome']).toMatchObject({ outcome: 'invalid', status: 'invalid' })
    const extra = await legacy(worker, 'tools/call', { name: 'tenants_list', arguments: { nope: 1 } }, { version: '2025-06-18' })
    expect(extra.body.result.isError).toBe(true)
  })
  test('an unknown tool is a protocol error, logged through the guard as invalid with the tool name', async () => {
    const { worker, logs, calls } = setup()
    const { body } = await legacy(worker, 'tools/call', { name: 'nothing_here', arguments: {} }, { version: '2025-06-18' })
    expect(body.error.code).toBe(-32602)
    expect(calls.length).toBe(0)
    expect(logs).toEqual([expect.objectContaining({ method: 'tools/call', tool: 'nothing_here', outcome: 'invalid', errorCode: 'unknown_tool' })])
  })
  test('a tool above the seat, or of another door, is unknown to the client and logged with why', async () => {
    const { worker, logs } = setup()
    const above = await legacy(worker, 'tools/call', { name: 'tenant_delete', arguments: { id: 't1' } }, { token: 'personal', version: '2025-06-18' })
    expect(above.body.error.code).toBe(-32602)
    const other = await modern(worker, 'tools/call', { name: 'staff_list', arguments: {} })
    expect(other.body.error.code).toBe(-32602)
    expect(logs.map((l) => [l.tool, l.outcome, l.errorCode, l.client?.name ?? null])).toEqual([
      ['tenant_delete', 'invalid', 'tier_above_seat', null],
      ['staff_list', 'invalid', 'unknown_tool', 'test-client'],
    ])
  })
  test('a tool outside a service key allow list is logged as not_in_allow_list', async () => {
    const g = fakeGuard()
    const door = mcpServer({
      registry: reg,
      guard: g.guard,
      door: 'platform',
      resolveSeat: () => ({ ...seats.plat!, tools: ['tenants_list'] }),
      info: { name: 'p', version: '1' },
    })
    const { body } = await legacy(door, 'tools/call', { name: 'tenant_update', arguments: { id: 't1', name: 'A' } }, { version: '2025-06-18' })
    expect(body.error.code).toBe(-32602)
    expect(g.logs[0]).toMatchObject({ tool: 'tenant_update', outcome: 'invalid', errorCode: 'not_in_allow_list' })
  })
  test('a failure inside: the generic sentence with a reference, and the alert hook', async () => {
    const { worker, failures } = setup()
    const { body } = await legacy(worker, 'tools/call', { name: 'report_boom', arguments: {} }, { version: '2025-06-18' })
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toStartWith('That did not work. The team has been told.')
    expect(body.result.content[0].text).not.toContain('secret')
    expect(failures.length).toBe(1)
  })
  test('a guard that throws is caught the same way', async () => {
    const g = fakeGuard()
    const failures: unknown[] = []
    g.guard.call = async () => {
      throw new Error('store down')
    }
    const door = mcpServer({ registry: reg, guard: g.guard, door: 'platform', resolveSeat: (t) => seats[t] ?? null, info: { name: 'p', version: '1' }, onError: (f) => void failures.push(f), errorMessage: 'Sorry.' })
    const { body } = await legacy(door, 'tools/call', { name: 'tenants_list', arguments: {} }, { version: '2025-06-18' })
    expect(body.result.content[0].text).toStartWith('Sorry.')
    expect(failures.length).toBe(1)
  })
  test('a door switched off: 503 at the door', async () => {
    const { worker, setDoorOff } = setup()
    setDoorOff(true)
    const { res, body } = await legacy(worker, 'tools/call', { name: 'tenants_list', arguments: {} }, { version: '2025-06-18' })
    expect(res.status).toBe(503)
    expect(body.message).toContain('off for maintenance')
  })
  test('a door switched off answers 503 to every method, before the token, logged as switched_off', async () => {
    const { worker, setDoorOff, anon, calls, logs } = setup()
    setDoorOff(true)
    const init = await legacy(worker, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    const list = await modern(worker, 'tools/list')
    const call = await modern(worker, 'tools/call', { name: 'tenants_list', arguments: {} })
    const nobody = await legacy(worker, 'tools/list', undefined, { token: 'stolen' })
    expect([init.res.status, list.res.status, call.res.status, nobody.res.status]).toEqual([503, 503, 503, 503])
    expect(list.body).toEqual({ error: 'door_off', message: 'The platform door is off for maintenance.' })
    expect(list.res.headers.get(REQUEST_ID_HEADER)).toBeTruthy()
    expect(calls.length).toBe(0)
    expect(logs.length).toBe(0)
    expect(anon.map((r) => [r.method, r.outcome, r.errorCode, r.door])).toEqual([
      ['initialize', 'switched_off', 'door_off', 'platform'],
      ['tools/list', 'switched_off', 'door_off', 'platform'],
      ['tools/call', 'switched_off', 'door_off', 'platform'],
      ['tools/list', 'switched_off', 'door_off', 'platform'],
    ])
    // The other door is not touched.
    expect((await legacy(worker, 'tools/list', undefined, { token: 'org', path: '/org', version: '2025-06-18' })).res.status).toBe(200)
  })
  test('switches that cannot be read count as off', async () => {
    const { worker, setSwitchesDown, anon, failures } = setup()
    setSwitchesDown(true)
    const { res, body } = await legacy(worker, 'tools/list', undefined, { version: '2025-06-18' })
    expect(res.status).toBe(503)
    expect(body.message).toBe('The switches could not be read, so nothing ran.')
    expect(anon[0]).toMatchObject({ outcome: 'error', errorCode: 'hook_failed' })
    expect(failures.length).toBe(1)
  })
  test('doorOffMessage is the sentence when the switch gives no reason', async () => {
    const g = fakeGuard()
    g.guard.doorSwitch = async () => ({ key: 'all', scope: 'global', subject: null, on: false })
    const door = mcpServer({ registry: reg, guard: g.guard, door: 'platform', resolveSeat: (t) => seats[t] ?? null, info: { name: 'p', version: '1' }, doorOffMessage: 'Joya is resting. Ask Betopia to turn it on.' })
    const { res, body } = await legacy(door, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    expect(res.status).toBe(503)
    expect(body.message).toBe('Joya is resting. Ask Betopia to turn it on.')
  })
})

describe('mcp: doors', () => {
  test('every auth refusal goes to the anonymous log with its code, method and request id', async () => {
    const { worker, anon } = setup()
    const send = (token: string | null, path: string, id: string) =>
      worker.fetch(
        new Request(`https://mcp.example${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [REQUEST_ID_HEADER]: id, ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
      )
    const a = await send(null, '/platform', 'req-anon-0001')
    const b = await send('stolen', '/platform', 'req-anon-0002')
    const c = await send('org', '/platform', 'req-anon-0003')
    expect([a.status, b.status, c.status]).toEqual([401, 401, 401])
    expect(c.headers.get(REQUEST_ID_HEADER)).toBe('req-anon-0003')
    expect(anon.map((r) => [r.errorCode, r.door, r.method, r.requestId, r.outcome])).toEqual([
      ['no_token', 'platform', 'tools/list', 'req-anon-0001', 'refused_auth'],
      ['bad_token', 'platform', 'tools/list', 'req-anon-0002', 'refused_auth'],
      ['wrong_door', 'platform', 'tools/list', 'req-anon-0003', 'refused_auth'],
    ])
    await send('plat', '/platform', 'req-anon-0004')
    expect(anon.length).toBe(3)
  })

  test('no token: 401 with a Bearer challenge', async () => {
    const { worker } = setup()
    const { res } = await legacy(worker, 'tools/list', undefined, { token: '' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toStartWith('Bearer ')
  })
  test('an unknown token: 401 invalid_token', async () => {
    const { worker } = setup()
    const { res } = await legacy(worker, 'tools/list', undefined, { token: 'stolen' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('invalid_token')
  })
  test('a token for one door is refused at the other', async () => {
    const { worker } = setup()
    expect((await legacy(worker, 'tools/list', undefined, { token: 'org', path: '/platform' })).res.status).toBe(401)
    expect((await legacy(worker, 'tools/list', undefined, { token: 'plat', path: '/org' })).res.status).toBe(401)
    const org = await legacy(worker, 'tools/list', undefined, { token: 'org', path: '/org', version: '2025-06-18' })
    expect(org.body.result.tools.map((t: any) => t.name)).toEqual(['staff_list'])
  })
  test('a tool of another door is unknown here', async () => {
    const { worker } = setup()
    const { body } = await legacy(worker, 'tools/call', { name: 'staff_list', arguments: {} }, { version: '2025-06-18' })
    expect(body.error.code).toBe(-32602)
  })
  test('an unknown path is 404', async () => {
    const { worker } = setup()
    expect((await legacy(worker, 'tools/list', undefined, { path: '/host' })).res.status).toBe(404)
  })
})

describe('mcp: resources and prompts', () => {
  test('lists, reads and gets from the product lists', async () => {
    const { worker } = setup({
      resources: [{ uri: 'joya://docs/tiers', name: 'tiers', mimeType: 'text/markdown', read: () => '# Tiers' }],
      prompts: [{ name: 'weekly_review', description: 'Review the week.', arguments: [{ name: 'tenant', required: true }], get: (a) => `Review ${a.tenant}.` }],
    })
    const init = await legacy(worker, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    expect(init.body.result.capabilities.resources).toBeDefined()
    const rl = await legacy(worker, 'resources/list', undefined, { version: '2025-06-18' })
    expect(rl.body.result.resources[0]).toEqual({ uri: 'joya://docs/tiers', name: 'tiers', mimeType: 'text/markdown' })
    const rr = await legacy(worker, 'resources/read', { uri: 'joya://docs/tiers' }, { version: '2025-06-18' })
    expect(rr.body.result.contents[0].text).toBe('# Tiers')
    const pg = await modern(worker, 'prompts/get', { name: 'weekly_review', arguments: { tenant: 'Acme' } })
    expect(pg.body.result.messages[0].content.text).toBe('Review Acme.')
    const missing = await legacy(worker, 'prompts/get', { name: 'weekly_review', arguments: {} }, { version: '2025-06-18' })
    expect(missing.body.error.code).toBe(-32602)
  })
})

describe('mcp: with the real guard', () => {
  async function real() {
    const { createGuard, memoryGuardStore, memoryRequestLog, memorySwitches, policies, approver } = await import('../src/guard/index')
    const log = memoryRequestLog()
    const switches = memorySwitches()
    const guard = createGuard<BaseCtx, string>({
      registry: reg as never,
      can: () => true,
      secret: 'a-test-secret-that-is-long-enough-for-hmac',
      store: memoryGuardStore(),
      policies: { super_admin_step_up: policies.single({ approver: approver.role('super_admin'), stepUp: 'passkey', expires: '1h', typedTarget: true }) },
      reviewUrl: (a) => `https://admin.example/approvals/${a.id}`,
      switches,
      log,
    })
    const pending: Promise<unknown>[] = []
    const door = mcpServer({ registry: reg, guard, door: 'platform', resolveSeat: (t) => seats[t] ?? null, info: { name: 'p', version: '1' } })
    const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
    const w = { fetch: (req: Request) => door.fetch(req, undefined, exec) }
    return { w, log, switches, settle: () => Promise.all(pending) }
  }

  test('read, confirm with the token, approval, invalid, door off', async () => {
    const { w, log, switches, settle } = await real()
    const read = await legacy(w, 'tools/call', { name: 'tenants_list', arguments: {} }, { version: '2025-06-18' })
    expect(read.body.result.structuredContent.rows.length).toBe(2)

    const first = await legacy(w, 'tools/call', { name: 'tenant_update', arguments: { id: 't1', name: 'Acme' } }, { version: '2025-06-18' })
    expect(first.body.result.structuredContent.status).toBe('confirm_required')
    const token = first.body.result.structuredContent.confirm_token
    const wrong = await legacy(w, 'tools/call', { name: 'tenant_update', arguments: { id: 't1', name: 'Other', confirm_token: token } }, { version: '2025-06-18' })
    expect(wrong.body.result.isError).toBe(true)
    const done = await legacy(w, 'tools/call', { name: 'tenant_update', arguments: { id: 't1', name: 'Acme', confirm_token: token } }, { version: '2025-06-18' })
    expect(done.body.result.structuredContent).toEqual({ id: 't1', name: 'Acme' })
    const again = await legacy(w, 'tools/call', { name: 'tenant_update', arguments: { id: 't1', name: 'Acme', confirm_token: token } }, { version: '2025-06-18' })
    expect(again.body.result.isError).toBe(true)

    const caps = { elicitation: {} }
    const ask = await modern(w, 'tools/call', { name: 'tenant_update', arguments: { id: 't2', name: 'B' } }, { caps })
    expect(ask.body.result.resultType).toBe('input_required')
    const yes = await modern(
      w,
      'tools/call',
      { name: 'tenant_update', arguments: { id: 't2', name: 'B' }, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } }, requestState: ask.body.result.requestState },
      { caps },
    )
    expect(yes.body.result.structuredContent).toEqual({ id: 't2', name: 'B' })

    const hold = await legacy(w, 'tools/call', { name: 'tenant_delete', arguments: { id: 't1' } }, { version: '2025-06-18' })
    expect(hold.body.result.structuredContent.status).toBe('pending_approval')
    expect(hold.body.result.structuredContent.review_url).toStartWith('https://admin.example/approvals/')

    const bad = await legacy(w, 'tools/call', { name: 'tenants_list', arguments: { limit: 'many' } }, { version: '2025-06-18' })
    expect(bad.body.result.isError).toBe(true)
    expect(bad.body.result.content[0].text).toContain('limit')

    const nobody = await legacy(w, 'tools/list', undefined, { token: 'stolen' })
    expect(nobody.res.status).toBe(401)

    const unknown = await legacy(w, 'tools/call', { name: 'nothing_here', arguments: {} }, { version: '2025-06-18' })
    expect(unknown.body.error.code).toBe(-32602)

    await switches.set({ key: 'door:platform', scope: 'global', subject: null, on: false, reason: 'maintenance' })
    const off = await legacy(w, 'tools/call', { name: 'tenants_list', arguments: {} }, { version: '2025-06-18' })
    expect(off.res.status).toBe(503)
    const offList = await legacy(w, 'tools/list', undefined, { version: '2025-06-18' })
    expect(offList.res.status).toBe(503)
    expect(offList.body.message).toBe('maintenance')
    await settle()
    expect(log.records.find((r) => r.tool === 'nothing_here')).toMatchObject({ method: 'tools/call', outcome: 'invalid', errorCode: 'unknown_tool', principalId: 'u1' })
    // A global switch stops the request before the token, so the row has no principal.
    expect(log.records.filter((r) => r.outcome === 'switched_off').map((r) => [r.method, r.errorCode, r.principalId])).toEqual([
      ['tools/call', 'door_off', null],
      ['tools/list', 'door_off', null],
    ])
    expect(log.records.some((r) => r.outcome === 'confirm_required')).toBe(true)
    const refused = log.records.find((r) => r.outcome === 'refused_auth')
    expect(refused).toMatchObject({ door: 'platform', method: 'tools/list', errorCode: 'bad_token', principalId: null })
  })
})

describe('mcp: door switches with the real guard', () => {
  test('a switch for one person holds the door off for that person only, logged with their seat', async () => {
    const { createGuard, memoryGuardStore, memoryRequestLog, memorySwitches } = await import('../src/guard/index')
    const log = memoryRequestLog()
    const switches = memorySwitches([{ key: 'door:platform', scope: 'person', subject: 'u3', on: false, reason: 'Your access is paused.' }])
    const guard = createGuard<BaseCtx, string>({ registry: reg as never, can: () => true, secret: 'a-test-secret-that-is-long-enough-for-hmac', store: memoryGuardStore(), switches, log })
    const pending: Promise<unknown>[] = []
    const door = mcpServer({ registry: reg, guard, door: 'platform', resolveSeat: (t) => seats[t] ?? null, info: { name: 'p', version: '1' } })
    const w = { fetch: (req: Request) => door.fetch(req, undefined, { waitUntil: (p) => void pending.push(p) }) }
    const mine = await modern(w, 'tools/list', {}, { token: 'personal' })
    expect(mine.res.status).toBe(503)
    expect(mine.body.message).toBe('Your access is paused.')
    expect((await modern(w, 'tools/list', {}, { token: 'plat' })).res.status).toBe(200)
    await Promise.all(pending)
    expect(log.records.find((r) => r.outcome === 'switched_off')).toMatchObject({ method: 'tools/list', principalId: 'u3', seat: 's3', errorCode: 'door_off' })
  })
})

describe('mcp: what the second product asked for', () => {
  const said = capability({
    name: 'ticket_get',
    audiences: ['platform'],
    title: 'Get a ticket',
    description: desc('Reads one ticket and says its status in a sentence.'),
    permission: 'tickets.read',
    risk: 'R0',
    input: schema.object({ id: schema.text(20) }),
    output: schema.object({ id: schema.text(20), status: schema.text(20) }),
    version: 1,
    say: (o) => `Ticket ${o.id} is ${o.status}.`,
    run: (_c, i) => ({ id: i.id, status: 'open' }),
  })
  const filed = capability({
    name: 'ticket_file',
    audiences: ['platform'],
    title: 'File a ticket',
    description: desc('Files one ticket. Old clients send fields it does not name, which are dropped.'),
    permission: 'tickets.write',
    risk: 'R2',
    input: schema.object({ title: schema.text(80) }),
    unknownFields: 'strip',
    invalidMessage: () => 'Ask the person what the ticket is about first.',
    version: 1,
    preview: (_c, i) => ({ summary: `File "${i.title}".` }),
    run: (_c, i) => ({ id: 'T-1', title: i.title }),
  })
  const held = capability({
    name: 'ticket_purge',
    audiences: ['platform'],
    title: 'Purge tickets',
    description: desc('Deletes every ticket. Needs a person to approve it.'),
    permission: 'tickets.purge',
    risk: 'R3',
    approval: 'owner',
    input: schema.object({}),
    version: 1,
    preview: () => ({ summary: 'Delete every ticket.' }),
    run: () => ({ ok: true }),
  })
  const reg2 = createRegistry([said, filed, held])
  const upstreamSeat: SeatGrant = { principal: { kind: 'service', id: 'omazy' }, seat: { id: 'agent', door: 'platform', tenant: null }, confirm: 'upstream' }
  const plainSeat: SeatGrant = { principal: { kind: 'member', id: 'u1' }, seat: { id: 's1', door: 'platform', tenant: null } }

  async function door(opts: { ephemeral?: boolean; accept2024?: boolean } = {}) {
    const { createGuard, memoryGuardStore, memoryRequestLog, policies, approver } = await import('../src/guard/index')
    const log = memoryRequestLog()
    const common = { registry: reg2 as never, can: () => true, log, policies: { owner: policies.single({ approver: approver.role('owner'), stepUp: 'code', expires: '1h' }) } }
    const guard = opts.ephemeral
      ? createGuard<BaseCtx, string>({ ...common, ephemeral: true })
      : createGuard<BaseCtx, string>({ ...common, secret: 'a-test-secret-that-is-long-enough-for-hmac', store: memoryGuardStore() })
    const pending: Promise<unknown>[] = []
    const d = mcpServer({
      registry: reg2,
      guard,
      door: 'platform',
      resolveSeat: (t) => (t === 'up' ? upstreamSeat : t === 'plat' ? plainSeat : null),
      info: { name: 'p', version: '1' },
      ...(opts.accept2024 === false ? { accept2024: false } : {}),
    })
    const w = { fetch: (req: Request) => d.fetch(req, undefined, { waitUntil: (p) => void pending.push(p) }) }
    return { w, log, settle: () => Promise.all(pending) }
  }

  test('say sets the text a model reads; structuredContent stays the JSON', async () => {
    const { w } = await door()
    const r = await legacy(w, 'tools/call', { name: 'ticket_get', arguments: { id: 'T-9' } }, { version: '2025-06-18' })
    expect(r.body.result.content).toEqual([{ type: 'text', text: 'Ticket T-9 is open.' }])
    expect(r.body.result.structuredContent).toEqual({ id: 'T-9', status: 'open' })
  })

  test('a seat that confirms upstream writes in one call, logs both steps, and sees no confirm_token', async () => {
    const { w, log, settle } = await door()
    const list = await legacy(w, 'tools/list', undefined, { token: 'up', version: '2025-06-18' })
    const file = list.body.result.tools.find((t: any) => t.name === 'ticket_file')
    expect(Object.keys(file.inputSchema.properties)).toEqual(['title'])
    const plain = await legacy(w, 'tools/list', undefined, { version: '2025-06-18' })
    expect(Object.keys(plain.body.result.tools.find((t: any) => t.name === 'ticket_file').inputSchema.properties)).toContain('confirm_token')

    const r = await legacy(w, 'tools/call', { name: 'ticket_file', arguments: { title: 'Leak' } }, { token: 'up', version: '2025-06-18' })
    expect(r.body.result.isError).toBe(false)
    expect(r.body.result.structuredContent).toEqual({ id: 'T-1', title: 'Leak' })
    const held = await legacy(w, 'tools/call', { name: 'ticket_purge', arguments: {} }, { token: 'up', version: '2025-06-18' })
    expect(held.body.result.structuredContent.status).toBe('pending_approval')
    await settle()
    expect(log.records.filter((x) => x.tool === 'ticket_file').map((x) => x.outcome)).toEqual(['confirm_required', 'ok'])
  })

  test('unknownFields strip drops the field and logs it; invalidMessage is the one sentence', async () => {
    const { w, log, settle } = await door()
    const r = await legacy(w, 'tools/call', { name: 'ticket_file', arguments: { title: 'Leak', ward: 3 } }, { token: 'up', version: '2025-06-18' })
    expect(r.body.result.structuredContent).toEqual({ id: 'T-1', title: 'Leak' })
    const bad = await legacy(w, 'tools/call', { name: 'ticket_file', arguments: { ward: 3 } }, { token: 'up', version: '2025-06-18' })
    expect(bad.body.result.isError).toBe(true)
    expect(bad.body.result.content[0].text).toBe('Ask the person what the ticket is about first.')
    await settle()
    expect(log.records.find((x) => x.outcome === 'ok' && x.tool === 'ticket_file')?.errorCode).toBe('stripped:ward')
  })

  test('an ephemeral guard writes only for an upstream seat and holds no approvals', async () => {
    const { w } = await door({ ephemeral: true })
    const ok = await legacy(w, 'tools/call', { name: 'ticket_file', arguments: { title: 'Leak' } }, { token: 'up', version: '2025-06-18' })
    expect(ok.body.result.structuredContent).toEqual({ id: 'T-1', title: 'Leak' })
    const plain = await legacy(w, 'tools/call', { name: 'ticket_file', arguments: { title: 'Leak' } }, { version: '2025-06-18' })
    expect(plain.body.result.isError).toBe(true)
    expect(plain.body.result.content[0].text).toContain('keeps no state between requests')
    const purge = await legacy(w, 'tools/call', { name: 'ticket_purge', arguments: {} }, { token: 'up', version: '2025-06-18' })
    expect(purge.body.result.isError).toBe(true)
    expect(purge.body.result.content[0].text).toContain('keeps no approvals')
  })

  test('2024-11-05 is answered and served like 2025-03-26, batches included, unless turned off', async () => {
    const { w } = await door()
    const init = await legacy(w, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } }, { token: 'up' })
    expect(init.body.result.protocolVersion).toBe('2024-11-05')
    expect(init.body.result.capabilities.tools.listChanged).toBe(false)
    const list = await legacy(w, 'tools/list', undefined, { token: 'up', version: '2024-11-05' })
    expect(list.body.result.tools.length).toBe(3)
    const batch = await w.fetch(
      new Request('https://mcp.example/platform', {
        method: 'POST',
        headers: { authorization: 'Bearer up', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2024-11-05' },
        body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]),
      }),
    )
    expect(((await batch.json()) as unknown[]).length).toBe(2)

    const off = await door({ accept2024: false })
    const init2 = await legacy(off.w, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } }, { token: 'up' })
    expect(init2.body.result.protocolVersion).toBe('2025-11-25')
  })

  test('the 2025 leg serves a missing Accept and a body that is not called JSON', async () => {
    const { w } = await door()
    for (const headers of [{}, { 'content-type': 'text/plain' }, { accept: '*/*' }, { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }]) {
      const res = await w.fetch(
        new Request('https://mcp.example/platform', { method: 'POST', headers: { authorization: 'Bearer up', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }),
      )
      expect({ headers, status: res.status }).toEqual({ headers, status: 200 })
    }
  })

  test('2026-07-28 is left to the MCP SDK: a body not sent as JSON is 415', async () => {
    const { w } = await door()
    const res = await w.fetch(
      new Request('https://mcp.example/platform', {
        method: 'POST',
        headers: { authorization: 'Bearer up', 'content-type': 'text/plain', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: MODERN_META() } }),
      }),
    )
    expect(res.status).toBe(415)
  })

  test('initialize without capabilities or clientInfo is -32602 with a sentence', async () => {
    const { w } = await door()
    const r = await legacy(w, 'initialize', { protocolVersion: '2025-03-26' }, { token: 'up' })
    expect(r.body.error.code).toBe(-32602)
    expect(r.body.error.message).toBe(
      'initialize needs capabilities and clientInfo in its params: protocolVersion as a string, capabilities as an object ({} for none), clientInfo as { name, version }.',
    )
  })
})
