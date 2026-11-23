// An actor turns a form into a conversation: code owns the order of
// questions, every check, the card and the submit; the model only reads what
// the person wrote into slot values. Its target is note_add (R2), so nothing
// is added until the person confirms the card. See the actors kit page.

import { actor, actorTools, slot } from '@omazyai/sdk/actors'
import { live } from './live'
import type { AppCtx, Door, Permission } from './types'

export const noteIntake = actor<AppCtx>({
  id: 'note_intake',
  version: 1,
  owner: '%%slug%%',
  target: 'note_add',
  title: { en: 'Add a note' },
  model: { use: 'extract.fast', fallback: 'extract.strong' },
  prompt: { template: 'actors/note-intake', version: 1, languages: ['en'] },
  evals: 'evals/note-intake.jsonl',
  caps: { perRunUsd: 0.02, perDayUsd: 2 },
  slots: [slot('title', { label: { en: 'note' }, hint: 'What the note says, in a line.', ask: { en: 'What should the note say?' } })],
  summary: (_values, _language, rows) => `Add the note "${rows.find((r) => r.slot === 'title')?.display ?? ''}".`,
})

/**
 * actor_start, actor_reply and actor_status on the MCP door. They are R1 and
 * never submit: at the card they name the note_add call, which the client
 * makes on the same door, so the guard still asks the person.
 */
export const intakeTools = actorTools<AppCtx, Permission, Door>(() => live.actors(), {
  audiences: ['app'],
  permission: 'notes.write',
  actors: ['note_intake'],
})
