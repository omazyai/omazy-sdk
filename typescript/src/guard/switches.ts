// Kill switches, read deny first on every call and never cached. Only an
// off value matters: a tenant or person switch that is on cannot override
// one that is off above it.

import type { SwitchQuery, SwitchRow, SwitchScope, SwitchStore } from './types.js'

const SCOPES: readonly SwitchScope[] = ['global', 'tenant', 'person']

/** The keys the guard reads for a call, in order: all, door, unit kind, tool, then the product's own. */
export function switchKeysFor(door: string | null, channel: string, tool: string, extra: readonly string[] = []): string[] {
  const keys = ['all']
  if (door) keys.push(`door:${door}`)
  keys.push(`unit:${channel}`, `tool:${tool}`, ...extra)
  return [...new Set(keys)]
}

/**
 * The first switch that is off, in order of scope (global, tenant, person)
 * and then of key. Null when nothing stops the call. Rows for another tenant
 * or person are ignored, whatever the store returned.
 */
export function firstOff(rows: readonly SwitchRow[], q: SwitchQuery): SwitchRow | null {
  for (const scope of SCOPES) {
    const subject = scope === 'global' ? null : scope === 'tenant' ? q.tenant : q.person
    if (scope !== 'global' && !subject) continue
    for (const key of q.keys) {
      const hit = rows.find((r) => r.scope === scope && r.key === key && (r.subject ?? null) === subject && r.on === false)
      if (hit) return hit
    }
  }
  return null
}

/** Switches in memory, for tests and local runs. */
export function memorySwitches(initial: readonly SwitchRow[] = []): SwitchStore & { rows: Map<string, SwitchRow> } {
  const id = (r: Pick<SwitchRow, 'key' | 'scope' | 'subject'>) => `${r.scope}|${r.subject ?? ''}|${r.key}`
  const rows = new Map<string, SwitchRow>(initial.map((r) => [id(r), { ...r }]))
  return {
    rows,
    async read(q) {
      return [...rows.values()].filter(
        (r) =>
          q.keys.includes(r.key) &&
          ((r.scope === 'global' && r.subject == null) || (r.scope === 'tenant' && r.subject === q.tenant) || (r.scope === 'person' && r.subject === q.person)),
      )
    },
    async set(r) {
      rows.set(id(r), { ...r, subject: r.scope === 'global' ? null : r.subject })
    },
    async list() {
      return [...rows.values()]
    },
  }
}
