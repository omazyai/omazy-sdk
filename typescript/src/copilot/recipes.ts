// Two recipes on the copilot: starting a workflow from the conversation, and
// the support agent of RFC-0901 7.11.
//
// A workflow starts through a capability, so the guard decides it like any
// other change: R2 is a consent card, R3 an approval. The run itself goes
// through `flows.start`, one run per key.
//
// The support agent is a copilot unit with a help-centre recipe: retrievers
// over the product's help pages and release notes, the tenant's health
// findings, and an R2 capability that drafts a support ticket with
// everything support needs. It answers from the help and the findings, and
// drafts a ticket when they do not hold the answer.

import type { Retriever } from '../ai/ai.js'
import type { Retrieved } from '../ai/context.js'
import { type AnyUnit, copilotUnit, type ModelSpec, type PromptSpec } from '../ai/manifest.js'
import { type BaseCtx, type Capability, capability } from '../capabilities/capability.js'
import { schema } from '../capabilities/schema.js'
import type { SchemaLike } from '../capabilities/standard.js'
import type { Flows, StartRunResult } from '../flows/runtime.js'
import type { Workflow } from '../flows/workflow.js'

// ---------------------------------------------------------------- workflows

export interface WorkflowCapabilityOptions<I, C extends BaseCtx, P, A extends string> {
  /** `<noun>_<verb>`, such as `fulfilment_start`. */
  name: string
  audiences: readonly A[]
  title: string
  /** 80 to 600 characters, written for the model. */
  description: string
  synonyms?: readonly string[]
  permission: P
  /** R2 (a consent card) or R3 (an approval, with `approval` naming the policy). Default R2. */
  risk?: 'R2' | 'R3'
  approval?: string
  /** The workflow's input, as the model fills it. */
  input: SchemaLike<I>
  /** One run per key. Default `<workflow id>:<hash of the input>`, so the same start twice is one run. */
  key?: (ctx: C, input: I) => string | Promise<string>
  /** One sentence for the card. Default "Start <title>". */
  summary?: (ctx: C, input: I) => string | Promise<string>
  version?: number
}

async function inputKey(wf: Workflow, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input ?? null))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `${wf.id}:${[...hash.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * A capability that starts a workflow through `flows.start`. Add it to the
 * registry and to the copilot unit's `tools.allow`; the copilot then offers it
 * like any other change, and the person confirms it on a card.
 */
export function workflowCapability<I, C extends BaseCtx = BaseCtx, P = unknown, A extends string = string>(
  flows: Flows<C> | (() => Flows<C>),
  wf: Workflow,
  o: WorkflowCapabilityOptions<I, C, P, A>,
): Capability<I, StartRunResult & { workflow: string }, C, P, A> {
  const f = () => (typeof flows === 'function' ? flows() : flows)
  return capability<I, StartRunResult & { workflow: string }, C, P, A>({
    name: o.name,
    audiences: o.audiences,
    title: o.title,
    description: o.description,
    ...(o.synonyms ? { synonyms: o.synonyms } : {}),
    permission: o.permission,
    risk: o.risk ?? 'R2',
    ...(o.approval ? { approval: o.approval } : {}),
    input: o.input,
    version: o.version ?? 1,
    preview: async (ctx, input) => ({ summary: o.summary ? await o.summary(ctx, input) : `Start ${o.title}`, after: { workflow: wf.id, input } }),
    run: async (ctx, input) => {
      const key = o.key ? await o.key(ctx, input) : await inputKey(wf, input)
      return { ...(await f().start(ctx, wf, key, { input })), workflow: wf.id }
    },
  })
}

// ---------------------------------------------------------------- support

export interface HealthFinding {
  /** A stable code, such as `whatsapp_token_expired`. */
  code: string
  severity: 'info' | 'warn' | 'error'
  /** One sentence for a person. */
  text: string
  since?: string
  /** The help page that fixes it, when there is one. */
  help?: string
}

export interface SupportRecipeOptions<C extends BaseCtx> {
  /** Default `support_agent`. */
  id?: string
  version?: number
  owner: string
  model: ModelSpec
  prompt: PromptSpec
  /** Help pages and release notes for the question. Their text is fenced as data. */
  help: Retriever<C>
  /** The tenant's health: account checks and recent errors. */
  health: (ctx: C) => readonly HealthFinding[] | Promise<readonly HealthFinding[]>
  /**
   * When someone other than the tenant asks (Betopia support, say), live
   * tenant data is read only under an active support grant (ADR-0502).
   * Return false and the findings are left out. Default: always read.
   */
  mayReadTenant?: (ctx: C) => boolean | Promise<boolean>
  /** The capability that drafts a ticket: `supportTicketCapability`'s name. */
  ticket: string
  /** Other capabilities the agent may call, read only or R2. */
  tools?: readonly string[]
  evals: string
  caps: { perRunUsd: number; perDayUsd: number }
  budgetTokens?: number
}

/** The retriever names the recipe's unit reads. */
export const SUPPORT_RETRIEVERS = ['support_help', 'support_health'] as const

/** Words for the support unit's prompt. Put them in the product's own template, after its persona. */
export const SUPPORT_PROMPT =
  'You help the people who run this account with questions about the product. Answer from the help pages and the health findings in the data. ' +
  'Name the help page you used. When a health finding explains the problem, say what it is and how to fix it. ' +
  'When neither holds the answer, draft a support ticket with the ticket tool: the question, what you checked, the findings and the steps already tried. ' +
  'The person confirms the draft on a card; until then, it is not sent.'

/**
 * The support agent as a copilot unit and its two retrievers. Give the
 * retrievers to `createAi`, the unit to `createCopilot`.
 *
 * ```ts
 * const support = supportRecipe({ owner: 'support', model: { use: 'converse' }, prompt: { template: 'copilot/support', version: 1, languages: ['en', 'bn'] },
 *   help: helpSearch, health: accountHealth, ticket: 'support_ticket_draft', evals: 'evals/support.jsonl', caps: { perRunUsd: 0.05, perDayUsd: 5 } })
 * const ai = createAi({ ..., retrievers: { ...support.retrievers } })
 * const copilot = createCopilot({ ai, registry, unit: support.unit, threads })
 * ```
 */
export function supportRecipe<C extends BaseCtx>(o: SupportRecipeOptions<C>): { unit: AnyUnit; retrievers: Record<(typeof SUPPORT_RETRIEVERS)[number], Retriever<C>> } {
  const unit = copilotUnit({
    id: o.id ?? 'support_agent',
    version: o.version ?? 1,
    owner: o.owner,
    surfaces: ['copilot:support'],
    model: o.model,
    prompt: o.prompt,
    context: {
      layers: ['platform', 'tenant', 'role', 'surface', 'unit'],
      retrievers: [...SUPPORT_RETRIEVERS],
      budgetTokens: o.budgetTokens ?? 12_000,
      untrusted: ['message'],
      // Findings are live: never served from an old reply.
      live: true,
    },
    memory: { read: ['working', 'known', 'conversation'], write: [] },
    tools: { allow: [o.ticket, ...(o.tools ?? []).filter((t) => t !== o.ticket)], maxTier: 'R2' },
    evals: o.evals,
    caps: o.caps,
  })
  const health: Retriever<C> = async (ctx) => {
    if (o.mayReadTenant && !(await o.mayReadTenant(ctx))) return [{ source: 'health', text: 'No health findings: there is no active support grant to read this account.' }]
    const list = await o.health(ctx)
    if (!list.length) return [{ source: 'health', text: 'No health findings: every check passes.' }]
    return list.map(
      (f): Retrieved => ({ source: 'health', text: `[${f.severity}] ${f.code}: ${f.text}${f.since ? ` (since ${f.since})` : ''}${f.help ? ` Help: ${f.help}` : ''}` }),
    )
  }
  return { unit, retrievers: { support_help: o.help, support_health: health } }
}

export interface TicketDraft {
  subject: string
  question: string
  checked: string
  findings?: string[]
  steps_tried?: string
  severity: 'low' | 'normal' | 'high'
}

/**
 * The R2 capability that drafts a support ticket. A draft stays inside the
 * tenant until a person sends it, so it is reversible; the copilot shows it
 * as a consent card.
 */
export function supportTicketCapability<C extends BaseCtx = BaseCtx, P = unknown, A extends string = string>(o: {
  name?: string
  audiences: readonly A[]
  permission: P
  /** Saves the draft. Returns its id. */
  save: (ctx: C, draft: TicketDraft) => Promise<{ id: string; url?: string }> | { id: string; url?: string }
}): Capability<TicketDraft, { ticket: string; url?: string }, C, P, A> {
  return capability<TicketDraft, { ticket: string; url?: string }, C, P, A>({
    name: o.name ?? 'support_ticket_draft',
    audiences: o.audiences,
    title: 'Draft a support ticket',
    description:
      'Drafts a support ticket for this account with the question, what was checked, the health findings and the steps already tried. ' +
      'The draft is not sent: a person checks it and sends it. Use it only when the help pages and the findings do not answer the question.',
    synonyms: ['contact support', 'open a ticket', 'report a problem'],
    permission: o.permission,
    risk: 'R2',
    input: schema.object({
      subject: schema.text(120),
      question: schema.text(2000),
      checked: schema.text(2000),
      findings: schema.array(schema.text(300), { max: 20 }).optional(),
      steps_tried: schema.text(2000).optional(),
      severity: schema.enum(['low', 'normal', 'high']),
    }) as SchemaLike<TicketDraft>,
    version: 1,
    preview: (_ctx, i) => ({ summary: `Draft a ${i.severity} support ticket: ${i.subject}`, after: i }),
    run: async (ctx, i) => {
      const r = await o.save(ctx, i)
      return { ticket: r.id, ...(r.url ? { url: r.url } : {}) }
    },
    say: (out) => `Drafted support ticket ${out.ticket}. It is not sent until a person sends it.`,
  })
}
