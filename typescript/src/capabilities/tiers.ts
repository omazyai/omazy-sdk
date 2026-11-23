// Risk tiers. The mode of a call (read or write) and the hints an MCP client
// sees come from the tier and are never stored beside it, so a tool cannot
// say "read" while its tier says "write". Anything that is not a known tier
// is treated as R4: an entry with a missing or misspelt tier fails closed.

export const TIERS = ['R0', 'R1', 'R2', 'R3', 'R4'] as const

/**
 * - R0: a read with no personal data.
 * - R1: a read with personal data.
 * - R2: a reversible change inside one tenant that reaches no one outside the product. Runs after a confirm step.
 * - R3: sensitive, outward facing, changes what the product says, or hard to undo. Needs an approval.
 * - R4: irreversible across a tenant. Needs an approval with step-up.
 */
export type Tier = (typeof TIERS)[number]

export type Mode = 'read' | 'write'

export const isTier = (t: unknown): t is Tier => typeof t === 'string' && (TIERS as readonly string[]).includes(t)

/** 0 to 4. Anything that is not a tier ranks 4. */
export const tierRank = (t: unknown): number => (isTier(t) ? TIERS.indexOf(t) : 4)

/** R0 and R1 read; every other value, including nonsense, writes. */
export const modeOf = (t: unknown): Mode => (tierRank(t) <= 1 ? 'read' : 'write')

/** The tier at or above which a call needs an approval rather than a confirm. */
export const needsApproval = (t: unknown): boolean => tierRank(t) >= 3

/** The tier at or above which a call needs a confirm step or more. */
export const needsConfirm = (t: unknown): boolean => tierRank(t) >= 2

/** MCP tool annotations (2025-06-18 and later). Hints for clients; the server still enforces the tier. */
// A type alias, not an interface, so it fits server.ts ToolDef's Record<string, unknown>.
export type McpAnnotations = {
  title?: string
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

/** The annotations for a tier. `openWorld` marks a tool that reaches outside the product (mail, the web). */
export function annotationsOf(t: unknown, extra: { title?: string; openWorld?: boolean } = {}): McpAnnotations {
  const r = tierRank(t)
  const base =
    r <= 1
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
      : r === 2
        ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
        : { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  return { ...(extra.title ? { title: extra.title } : {}), ...base, openWorldHint: extra.openWorld === true }
}
