// Who may do what. The guard calls can() on every call, so a change here
// takes effect on the next call, whatever a token or a key says.
//
// The template gives every seat in a tenant the member role, and members may
// read and add notes. Replace rolesOf with your own lookup, such as a members
// table in D1.

import type { AppCtx, Permission } from './types'

const ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  member: ['notes.read', 'notes.write'],
}

export function rolesOf(ctx: AppCtx): readonly string[] {
  return ctx.seat?.tenant ? ['member'] : []
}

export function can(ctx: AppCtx, permission: Permission): boolean {
  return rolesOf(ctx).some((role) => ROLE_PERMISSIONS[role]?.includes(permission))
}
