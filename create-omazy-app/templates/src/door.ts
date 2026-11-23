// The MCP door: one MCP server for the `app` audience at /mcp, built from the
// registry, with every tool call through the guard. It serves MCP 2026-07-28
// and the 2025 and 2024-11-05 revisions. See the mcp kit page.

import type { Guard } from '@omazyai/sdk/guard'
import { mcpServer, type SeatGrant } from '@omazyai/sdk/mcp'
import { reg } from './capabilities'
import { type AppCtx, DOOR, type Door } from './types'

export type SeatResolver = (token: string, req: Request) => SeatGrant | null | Promise<SeatGrant | null>

export function buildDoor(guard: Guard<AppCtx>, resolveSeat: SeatResolver, resourceMetadataUrl?: string) {
  return mcpServer<AppCtx, Door>({
    registry: reg,
    guard,
    door: DOOR,
    path: '/mcp',
    info: { name: '%%name%%', title: '%%title%%', version: '0.1.0' },
    instructions: 'Notes for one account. Read a note by its id, or add one after the person confirms it.',
    resolveSeat,
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
  })
}
