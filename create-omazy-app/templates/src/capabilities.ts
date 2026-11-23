// The product's capabilities: each action it offers, defined once. The MCP
// door's tools, the model's tools, the request log and the tier snapshot all
// come from these definitions. See the capabilities kit page.
//
// Two samples: a read at R0, and a write at R2 that the person confirms from
// its preview before it runs.

import { defineCapabilities, registry, schema } from '@omazyai/sdk/capabilities'
import { GuardRefusal } from '@omazyai/sdk/guard'
//#if actor
import { intakeTools } from './actor'
//#endif
//#if flow
import { followupStart } from './flow'
//#endif
import { live } from './live'
import type { AppCtx, Door, Permission } from './types'

const { capability } = defineCapabilities<AppCtx, Permission, Door>()

export const noteGet = capability({
  name: 'note_get',
  audiences: ['app'],
  title: 'Get a note',
  description: 'Reads one note of this account by its id: its title and when it was written. Not for adding a note: use note_add.',
  synonyms: ['read a note', 'show a note', 'open a note'],
  permission: 'notes.read',
  risk: 'R0',
  input: schema.object({ id: schema.id().describe('The note id, such as n_3f9a1c2b7d4e.') }),
  output: schema.object({ id: schema.id(), title: schema.text(200), created_at: schema.text(40) }),
  version: 1,
  run: async (ctx, input) => {
    const note = await live.notes().get(ctx.tenant ?? '', input.id)
    if (!note) throw new GuardRefusal('not_found', 'not_found', `There is no note ${input.id} in this account.`)
    return { id: note.id, title: note.title, created_at: note.createdAt }
  },
  say: (out) => `Note ${out.id}: ${out.title}`,
})

export const noteAdd = capability({
  name: 'note_add',
  audiences: ['app'],
  title: 'Add a note',
  description: 'Adds one note with a title to this account and returns its id. The person confirms the preview first. Not for changing a note: notes cannot be edited.',
  synonyms: ['write down', 'new note', 'remember this'],
  permission: 'notes.write',
  risk: 'R2',
  input: schema.object({ title: schema.text(200).describe('What the note says, in a line.') }),
  output: schema.object({ id: schema.id(), title: schema.text(200) }),
  version: 1,
  preview: (_ctx, input) => ({ summary: `Add the note "${input.title}".`, after: { title: input.title } }),
  run: async (ctx, input) => {
    const note = await live.notes().add(ctx.tenant ?? '', input.title)
    return { id: note.id, title: note.title }
  },
  say: (out) => `Added note ${out.id}: ${out.title}`,
})

export const reg = registry([
  noteGet,
  noteAdd,
//#if flow
  followupStart,
//#endif
//#if actor
  ...intakeTools,
//#endif
])

/** The arguments that name a note, for the guard's tenant check. */
export const NOTE_FIELDS = ['id', 'note_id'] as const
