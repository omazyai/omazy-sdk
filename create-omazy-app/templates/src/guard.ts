// The guard: every call from the door (and the copilot, actors and
// workflows) goes through it. It checks switches, the arguments, the tenant
// and can(), asks the person to confirm an R2 write from its preview, holds
// R3 and R4 for an approval, and writes the request log. See the guard kit page.

import type { AnyCapability } from '@omazyai/sdk/capabilities'
import { createGuard, type Guard, type GuardStore, type RequestLogSink, type SwitchStore } from '@omazyai/sdk/guard'
import { can, rolesOf } from './access'
import { NOTE_FIELDS, reg } from './capabilities'
import { live } from './live'
import { type AppCtx, DOOR, type Permission } from './types'

export interface GuardParts {
  store: GuardStore
  log: RequestLogSink
  switches: SwitchStore
  /** 32 characters or more. GUARD_SECRET in the Worker. */
  secret: string
  /**
   * "off" keeps the door off until a switch row turns it on, so a fresh
   * deploy answers nothing until you decide it should. "on" in `wrangler dev`.
   */
  doorDefault: 'on' | 'off'
  onApproval?: Parameters<typeof createGuard<AppCtx, Permission>>[0]['onApproval']
  waitUntil?: (p: Promise<unknown>) => void
}

export const DOOR_OFF = 'This door is off until its owner turns it on.'

export function buildGuard(p: GuardParts): Guard<AppCtx> {
  return createGuard<AppCtx, Permission>({
    registry: reg,
    can,
    rolesOf,
    secret: p.secret,
    store: p.store,
    log: p.log,
    switches: p.doorDefault === 'off' ? offUnlessSet(p.switches, [{ key: `door:${DOOR}`, reason: DOOR_OFF }]) : p.switches,
    // A seat acts only in its own tenant: an argument that names another
    // tenant's note is refused before the capability runs.
    tenantsOf: async (_ctx, _capability: AnyCapability, input) => {
      const args = (input ?? {}) as Record<string, unknown>
      const tenants: string[] = []
      for (const f of NOTE_FIELDS) {
        const id = args[f]
        if (typeof id !== 'string') continue
        const t = await live.notes().tenantOf(id)
        if (t) tenants.push(t)
      }
      return tenants
    },
    policies: {},
    ...(p.onApproval ? { onApproval: p.onApproval } : {}),
    ...(p.waitUntil ? { waitUntil: p.waitUntil } : {}),
  })
}

/**
 * Switches that count as off until a global row says otherwise. Turn the
 * door on with `npm run door -- on --remote`, which writes that row; a row
 * that is on wins over the default, one that is off stays off.
 */
export function offUnlessSet(store: SwitchStore, defaults: readonly { key: string; reason: string }[]): SwitchStore {
  return {
    async read(q) {
      const rows = await store.read(q)
      const unset = defaults.filter((d) => q.keys.includes(d.key) && !rows.some((r) => r.scope === 'global' && r.key === d.key))
      return [...rows, ...unset.map((d) => ({ key: d.key, scope: 'global' as const, subject: null, on: false, reason: d.reason }))]
    },
    set: (row) => store.set(row),
    list: () => store.list(),
  }
}
