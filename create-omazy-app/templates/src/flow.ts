// A workflow: steps that are capabilities through the guard, each in the ai
// kit's effects ledger, on Cloudflare Workflows. A write is never retried; a
// failed one goes to a person. See the flows kit page.

import { schema } from '@omazyai/sdk/capabilities'
import { workflowCapability } from '@omazyai/sdk/copilot'
import { step, workflow } from '@omazyai/sdk/flows'
import { live } from './live'
import type { AppCtx, Door, Permission } from './types'

/** Reads a note and adds a follow-up note for it. */
export const noteFollowup = workflow({
  id: 'note_followup',
  version: 1,
  steps: [
    step.read('note', 'note_get', { args: (s) => ({ id: s.input.note_id }) }),
    // The person confirmed this change when they started the run (the R2
    // card of note_followup_start), so the write runs without asking again.
    step.write('followup', 'note_add', { confirm: 'upstream', args: (s) => ({ title: `Follow up: ${s.note.title}`.slice(0, 200) }) }),
    step.notify('tell', 'followup_added', { data: (s) => ({ note: s.input.note_id, followup: s.followup.id }) }),
  ],
})

/** Starts the workflow through the guard like any other change: an R2 card first. One run per note. */
export const followupStart = workflowCapability<{ note_id: string }, AppCtx, Permission, Door>(() => live.flows(), noteFollowup, {
  name: 'note_followup_start',
  audiences: ['app'],
  title: 'Add a follow-up note',
  description: 'Starts a workflow that reads one note and adds a follow-up note for it, once the person confirms. Not for adding a plain note: use note_add.',
  permission: 'notes.write',
  risk: 'R2',
  input: schema.object({ note_id: schema.id() }),
  key: (_ctx, input) => `followup:${input.note_id}`,
  summary: (_ctx, input) => `Add a follow-up note for ${input.note_id}.`,
})
