// The catalog checks from the testing kit, run on every change: parity, the
// committed tier snapshot, the approval invariant and tenant isolation. Each
// drives the real registry and guard on memory stores.

import { assertApprovals, assertCatalogParity, assertTenantIsolation, checkTierSnapshot, formatCatalogReport } from '@omazyai/sdk/testing'
import { describe, expect, test } from 'vitest'
//#if ai
import { noteTitle, PROMPTS } from '../src/ai'
//#endif
//#if actor
import { noteIntake } from '../src/actor'
//#endif
import { reg } from '../src/capabilities'
//#if copilot
import { notesCopilot } from '../src/copilot'
//#endif
import { DOOR } from '../src/types'
import { harness } from './helpers'
//#if ai
import { promptTemplates } from '@omazyai/sdk/ai'
//#endif

const SNAPSHOT = 'catalog.snapshot.json'

describe('catalog', () => {
  test('every surface and unit agrees with the registry', () => {
    assertCatalogParity({
      registry: reg,
      surfaces: { 'mcp /mcp': { audience: DOOR, tools: reg.list(DOOR).map((c) => c.name) } },
      audiences: [DOOR],
//#if ai
      units: [
        noteTitle,
//#if actor
        noteIntake.unit,
//#endif
//#if copilot
        notesCopilot,
//#endif
      ],
      prompts: promptTemplates(PROMPTS),
//#endif
    })
  })

  test('tiers match the committed snapshot', async () => {
    // The first run writes catalog.snapshot.json: commit it. After that, a
    // changed tier or a breaking schema change fails until the snapshot is
    // updated on purpose (OMAZY_UPDATE_SNAPSHOTS=1 npm test).
    let report = await checkTierSnapshot({ registry: reg, snapshot: SNAPSHOT })
    if (report.problems.some((p) => p.step === 'no_snapshot')) report = await checkTierSnapshot({ registry: reg, snapshot: SNAPSHOT, update: true })
    expect(report.ok, formatCatalogReport(report)).toBe(true)
  })

  test('nothing at R3 or R4 runs without a decided approval', async () => {
    // The samples stop at R2, so this checks nothing yet. Give each R3 or R4
    // capability you add its arguments here, with a decider and a proof.
    const h = harness()
    await assertApprovals({ registry: reg, guard: h.app.guard, requester: h.seat(), args: {}, effects: () => h.notes.count() })
  })

  test('a seat in tenant A cannot reach tenant B', async () => {
    const h = harness()
    const theirs = await h.notes.add('tenant_b', 'Tenant B only')
    await assertTenantIsolation({
      registry: reg,
      guard: h.app.guard,
      seat: h.seat('rina', 'tenant_a'),
      args: {
        note_get: { id: theirs.id },
//#if flow
        note_followup_start: { note_id: theirs.id },
//#endif
      },
      // note_add only ever writes the caller's own tenant: it names no record.
      skip: [
        'note_add',
//#if actor
        // An actor session belongs to one person in one tenant; the runtime refuses any other.
        'actor_start',
        'actor_reply',
        'actor_status',
//#endif
      ],
      effects: () => h.notes.count(),
    })
  })
})
