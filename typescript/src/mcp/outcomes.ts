// How a guard outcome becomes an MCP tool result. Pure functions, so the
// wording a model reads is tested on its own.

import type { AnyCapability } from '../capabilities/capability.js'
import type { GuardOutcome } from '../guard/types.js'

/** The `_meta` key that carries the guard's outcome on every tool result. */
export const OUTCOME_META_KEY = 'ai.omazy/outcome'
/** The `_meta` key a client may use to send a confirm token back instead of the argument. */
export const CONFIRM_META_KEY = 'ai.omazy/confirm_token'
/** The argument added to tools that run after a confirm step. */
export const CONFIRM_ARGUMENT = 'confirm_token'

/**
 * What `_meta["ai.omazy/outcome"]` holds. The names match `guard.call`'s
 * outcome: `outcome`, `token`, `expiresAt`, `preview`, `approval`, `code`,
 * `retryAfter`, `issues`. The snake_case keys are the old names, sent too
 * until the next release.
 */
export interface OutcomeMeta {
  outcome: string
  /** confirm_required: send it back as the `confirm_token` argument. */
  token?: string
  expiresAt?: string
  preview?: unknown
  /** pending_approval: as `guard.call` returns it. */
  approval?: { id: string; decider: string; expiresAt: string; preview: unknown; reviewUrl?: string }
  /** ok after an approval. */
  approvalId?: string
  code?: string
  retryAfter?: number
  issues?: { message: string; path: string }[]
  /** @deprecated Use `outcome`. Removed in the next release. */
  status?: string
  /** @deprecated Use `token`. Removed in the next release. */
  confirm_token?: string
  /** @deprecated Use `expiresAt`. Removed in the next release. */
  expires_at?: string
  /** @deprecated Use `approval.id` (pending) or `approvalId` (ok). Removed in the next release. */
  approval_id?: string
  /** @deprecated Use `approval.decider`. Removed in the next release. */
  decider?: string
  /** @deprecated Use `approval.reviewUrl`. Removed in the next release. */
  review_url?: string
  /** @deprecated Use `retryAfter`. Removed in the next release. */
  retry_after?: number
}

/** What a thrown error or an `error` outcome tells the model. */
export const GENERIC_ERROR = 'That did not work. The team has been told.'

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function text(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return String(value)
  }
}

/**
 * A status result. Carried in `structuredContent` only when the tool has no
 * output schema: a client checks `structuredContent` against the schema, and
 * a status is not the tool's output. A tool with an output schema gets the
 * status in `_meta` and `isError`, so no client rejects the result.
 */
function status(cap: AnyCapability | undefined, body: OutcomeMeta, sentence: string): ToolResult {
  const hasSchema = !!cap?.outputJson
  return {
    content: [{ type: 'text', text: sentence }],
    ...(hasSchema ? { isError: true } : { structuredContent: body as unknown as Record<string, unknown>, isError: false }),
    _meta: { [OUTCOME_META_KEY]: body },
  }
}

/** A refusal or a failure: `isError` with one sentence the model can act on. */
export function errorResult(message: string, meta?: OutcomeMeta): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true, ...(meta ? { _meta: { [OUTCOME_META_KEY]: meta } } : {}) }
}

/** The result for a confirm step when the client cannot answer an elicitation. */
export function confirmResult(cap: AnyCapability | undefined, name: string, o: Extract<GuardOutcome, { outcome: 'confirm_required' }>): ToolResult {
  const body: OutcomeMeta = {
    outcome: 'confirm_required',
    token: o.token,
    expiresAt: o.expiresAt,
    preview: o.preview,
    status: 'confirm_required',
    confirm_token: o.token,
    expires_at: o.expiresAt,
  }
  const sentence =
    `Not done yet: this needs the person's confirmation. Show them: ${o.preview.summary} ` +
    `If they agree, call ${name} again with the same arguments and ${CONFIRM_ARGUMENT} "${o.token}". ` +
    `The token works once, until ${o.expiresAt}.`
  return status(cap, body, sentence)
}

export function pendingResult(cap: AnyCapability | undefined, o: Extract<GuardOutcome, { outcome: 'pending_approval' }>): ToolResult {
  const a = o.approval
  const body: OutcomeMeta = {
    outcome: 'pending_approval',
    approval: { id: a.id, decider: a.decider, expiresAt: a.expiresAt, preview: a.preview, ...(a.reviewUrl ? { reviewUrl: a.reviewUrl } : {}) },
    expiresAt: a.expiresAt,
    preview: a.preview,
    status: 'pending_approval',
    approval_id: a.id,
    decider: a.decider,
    expires_at: a.expiresAt,
    ...(a.reviewUrl ? { review_url: a.reviewUrl } : {}),
  }
  const link = a.reviewUrl ? ` Review it at ${a.reviewUrl}.` : ''
  const sentence =
    `Sent for approval: ${a.preview.summary} ${a.decider} decides by ${a.expiresAt}.${link} ` +
    `Nothing has changed yet. Do not call again: it runs once it is approved.`
  return status(cap, body, sentence)
}

export function declinedResult(cap: AnyCapability | undefined): ToolResult {
  return status(cap, { outcome: 'declined', status: 'declined' }, 'The person did not confirm. Nothing changed.')
}

/**
 * A refusal. Validation issues are listed after the sentence so the model can
 * fix its arguments, unless `listIssues` is false (the capability wrote its
 * own sentence with `invalidMessage`).
 */
export function refusalResult(o: Extract<GuardOutcome, { code: string }>, opts: { listIssues?: boolean } = {}): ToolResult {
  let msg = o.message
  if (o.outcome === 'invalid' && o.issues?.length && opts.listIssues !== false) {
    const list = o.issues
      .slice(0, 10)
      .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
      .join('; ')
    msg = `${msg.replace(/\.?\s*$/, '.')} ${list}.`
  }
  if (o.outcome === 'rate_limited' && o.retryAfter) msg = `${msg.replace(/\.?\s*$/, '.')} Try again in ${o.retryAfter} seconds.`
  return errorResult(msg, {
    outcome: o.outcome,
    code: o.code,
    ...(o.retryAfter ? { retryAfter: o.retryAfter } : {}),
    ...(o.issues ? { issues: o.issues } : {}),
    status: o.outcome,
    ...(o.retryAfter ? { retry_after: o.retryAfter } : {}),
  })
}

/**
 * A completed call. Object results also go in `structuredContent`. `say` is
 * the text a model reads, from the capability's `say`; the JSON otherwise.
 */
export function okResult(value: unknown, approvalId?: string, say?: string): ToolResult {
  return {
    content: [{ type: 'text', text: say ?? text(value) }],
    ...(isPlainObject(value) ? { structuredContent: value } : {}),
    isError: false,
    ...(approvalId ? { _meta: { [OUTCOME_META_KEY]: { outcome: 'ok', approvalId, status: 'ok', approval_id: approvalId } satisfies OutcomeMeta } } : {}),
  }
}
