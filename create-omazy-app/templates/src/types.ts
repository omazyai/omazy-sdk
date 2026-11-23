// The product's own types: its doors, its permissions and the ctx every
// capability gets.

import type { Ctx } from '@omazyai/sdk/capabilities'

/** One MCP door, `app`, served at /mcp. Add a door per audience, such as `staff` for your own team. */
export type Door = 'app'
export const DOOR: Door = 'app'

export type Permission = 'notes.read' | 'notes.write'

/** The ctx every capability, unit and workflow step gets. Add your own fields, such as a locale. */
export type AppCtx = Ctx
