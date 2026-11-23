// The same actor on other surfaces. Over MCP it is three capabilities the
// product adds to its registry, so a door serves them with the guard like any
// other tool. In a copilot, the model may open an actor; after that, the
// person's messages go to the actor by code until the session closes.

import { type BaseCtx, type Capability, capability } from '../capabilities/capability.js'
import { schema } from '../capabilities/schema.js'
import type { ToolCall, ToolDefinition } from '../types.js'
import { ActorRefusal, type ActorRuntime } from './runtime.js'
import type { ActorReply, Attachment, ReplyInput } from './types.js'

export interface ActorToolsOptions<P = unknown, A extends string = string> {
  /** The doors that see the tools. */
  audiences: readonly A[]
  /** Passed to the product's `can()`, as for any capability. */
  permission: P
  /** The actors offered. Default every actor the runtime has. */
  actors?: readonly string[]
}

const attachmentSchema = schema.object({
  kind: schema.text(100),
  name: schema.text(200).optional(),
  /** Text already read from the file (a PDF, a CSV). */
  text: schema.text(20_000).optional(),
  /** A public https link to an image, for the vision model. */
  url: schema.string({ min: 9, max: 2000, pattern: /^https:\/\/\S+$/ }).optional(),
})

const replyShape = {
  text: schema.text(20_000).optional(),
  attachments: schema.array(attachmentSchema, { max: 8 }).optional(),
  choose: schema.object({ slot: schema.text(64), id: schema.text(200) }).optional(),
  affirm: schema.boolean().optional(),
}

type McpAttachment = { kind: string; name?: string; text?: string; url?: string }
const toAttachments = (list: readonly McpAttachment[] | undefined): Attachment[] | undefined =>
  list?.map((a) => ({ kind: a.kind, ...(a.name ? { name: a.name } : {}), ...(a.text ? { text: a.text } : {}), ...(a.url ? { image: { url: a.url } } : {}) }))

/**
 * What an MCP client gets: the reply, and at the card the target call it can
 * make through the same door. The guard then asks the person (a confirm at
 * R2, an approval at R3), so the model still cannot submit on its own.
 */
export type ActorToolResult = ActorReply & { submit?: { capability: string; arguments: Record<string, unknown>; note: string } }

function forClient(r: ActorReply, target: string | undefined): ActorToolResult {
  if (r.state !== 'confirm' || !r.card || !target) return r
  const note =
    r.card.needs === 'approval'
      ? 'Show the card to the person. When they agree, call the capability with these arguments; it goes to a second person for approval.'
      : 'Show the card to the person. When they agree, call the capability with these arguments; the person confirms it.'
  return { ...r, submit: { capability: target, arguments: r.card.input, note } }
}

/** Where each capability made by `actorTools` came from, so a copilot given the same registry can find the runtime. */
const SOURCES = new WeakMap<object, { runtime: () => ActorRuntime<any>; actors?: readonly string[] }>()

/**
 * The runtime and actor ids behind a capability made by `actorTools`, or
 * undefined for any other capability. A copilot uses it to serve the same
 * actors with its own hand-off tool and to keep these three from its model.
 */
export function actorToolSource<C extends BaseCtx>(cap: unknown): { runtime: () => ActorRuntime<C>; actors?: readonly string[] } | undefined {
  return cap && typeof cap === 'object' ? (SOURCES.get(cap) as { runtime: () => ActorRuntime<C>; actors?: readonly string[] } | undefined) : undefined
}

const refusalText = (e: unknown) => (e instanceof ActorRefusal ? e.message : 'The conversation could not continue.')

/**
 * `actor_start`, `actor_reply` and `actor_status` as capabilities. They read
 * and write the session's draft only, so they are R1; the target is never
 * called through them. Pass the runtime, or a function that returns it when
 * the runtime is built from the registry these join.
 */
export function actorTools<C extends BaseCtx, P = unknown, A extends string = string>(
  runtime: ActorRuntime<C> | (() => ActorRuntime<C>),
  opts: ActorToolsOptions<P, A>,
): Capability<any, ActorToolResult, C, P, A>[] {
  const rt = () => (typeof runtime === 'function' ? runtime() : runtime)
  const ids = opts.actors
  const guarded = async (fn: () => Promise<ActorReply>, session: string): Promise<ActorToolResult> => {
    try {
      const r = await fn()
      return forClient(r, rt().actor(r.actor)?.target)
    } catch (e) {
      if (e instanceof ActorRefusal) return { session, actor: '', state: 'cancelled', message: refusalText(e), refusal: { code: e.code, message: e.message } }
      throw e
    }
  }
  const actorIds = ids ?? []
  const actorField = actorIds.length ? schema.enum(actorIds as [string, ...string[]]) : schema.text(64)

  const start = capability<{ actor: string; text?: string; attachments?: McpAttachment[] }, ActorToolResult, C, P, A>({
    name: 'actor_start',
    audiences: opts.audiences,
    title: 'Start a guided form',
    description:
      'Starts a guided conversation that fills one form step by step, from what the person said and any files they sent. ' +
      'It asks for what is missing, checks every value and ends with a card the person confirms. Use actor_reply for each next message. Not for submitting: the card does that.',
    synonyms: ['fill a form', 'guided entry', 'conversation form'],
    permission: opts.permission,
    risk: 'R1',
    input: schema.object({ actor: actorField, text: replyShape.text, attachments: replyShape.attachments }),
    version: 1,
    run: async (ctx, i) => guarded(() => rt().start(ctx, i.actor, { text: i.text, attachments: toAttachments(i.attachments) }), ''),
  })

  const reply = capability<{ session: string } & ReplyInputWire, ActorToolResult, C, P, A>({
    name: 'actor_reply',
    audiences: opts.audiences,
    title: 'Answer a guided form',
    description:
      'Sends the person\'s next message, file, choice or yes/no answer to a guided form started with actor_start, and returns what to say next: a question, or the card to confirm. ' +
      'Pass the person\'s words as they wrote them. Not for confirming the card.',
    synonyms: ['answer the question', 'continue the form'],
    permission: opts.permission,
    risk: 'R1',
    input: schema.object({ session: schema.id(), ...replyShape }),
    version: 1,
    run: async (ctx, i) => {
      const input: ReplyInput = {
        ...(i.text !== undefined ? { text: i.text } : {}),
        ...(i.attachments ? { attachments: toAttachments(i.attachments) } : {}),
        ...(i.choose ? { choose: i.choose } : {}),
        ...(i.affirm !== undefined ? { affirm: i.affirm } : {}),
      }
      return guarded(() => rt().reply(ctx, i.session, input), i.session)
    },
  })

  const status = capability<{ session: string }, ActorToolResult, C, P, A>({
    name: 'actor_status',
    audiences: opts.audiences,
    title: 'Guided form status',
    description:
      'Shows where a guided form started with actor_start is: the question it is waiting on, the card to confirm, an approval it waits for, or the result. ' +
      'Also gives the link to finish it by hand in the form. Read only.',
    synonyms: ['form progress', 'where is my form'],
    permission: opts.permission,
    risk: 'R1',
    input: schema.object({ session: schema.id() }),
    version: 1,
    run: async (ctx, i) => guarded(() => rt().status(ctx, i.session), i.session),
  })
  const source = { runtime: rt, ...(ids ? { actors: ids } : {}) }
  for (const c of [start, reply, status]) SOURCES.set(c, source)
  return [start, reply, status] as Capability<any, ActorToolResult, C, P, A>[]
}

type ReplyInputWire = { text?: string; attachments?: McpAttachment[]; choose?: { slot: string; id: string }; affirm?: boolean }

// ---------------------------------------------------------------- copilot

export interface CopilotActorStep<C extends BaseCtx> {
  /** The one tool the copilot's model gets: open an actor. Replies never go through the model. */
  tools(): ToolDefinition[]
  /** Runs the model's `actor_start` call with the person's own message. Null for another tool. */
  start(ctx: C, call: ToolCall, message: ReplyInput): Promise<ActorReply | null>
  /**
   * A person's message while a session is open goes straight to it. Returns
   * null when the session is closed, so the copilot answers again.
   */
  route(ctx: C, session: string | null | undefined, message: ReplyInput): Promise<ActorReply | null>
}

/**
 * Helpers for a copilot that hands a conversation to an actor. The model
 * picks the actor; code passes the person's message to it, never the model's
 * paraphrase; and every later message goes to the actor until it closes.
 */
export function copilotActorStep<C extends BaseCtx>(
  runtimeOrGet: ActorRuntime<C> | (() => ActorRuntime<C>),
  opts: { actors?: readonly string[] } = {},
): CopilotActorStep<C> {
  // A function is read on first use, so the runtime may be built after the copilot.
  const rt = () => (typeof runtimeOrGet === 'function' ? runtimeOrGet() : runtimeOrGet)
  const idsOf = () => opts.actors ?? rt().actors.map((a) => a.id)
  return {
    tools: () => {
      const ids = idsOf()
      const runtime = rt()
      return ids.length
        ? [
            {
              name: 'actor_start',
              description: `Hand this conversation to a guided form when the person wants to do one of these: ${ids
                .map((id) => {
                  const a = runtime.actor(id)
                  const t = a?.title
                  return `${id} (${typeof t === 'string' ? t : (t?.en ?? a?.target ?? id)})`
                })
                .join(', ')}. The form asks its own questions.`,
              input_schema: { type: 'object', properties: { actor: { type: 'string', enum: [...ids] } }, required: ['actor'], additionalProperties: false },
            },
          ]
        : []
    },
    async start(ctx, call, message) {
      if (call.name !== 'actor_start') return null
      const actorId = (call.input as { actor?: unknown } | null)?.actor
      if (typeof actorId !== 'string' || !idsOf().includes(actorId)) return null
      return rt().start(ctx, actorId, message)
    },
    async route(ctx, session, message) {
      if (!session) return null
      const s = await rt().session(ctx, session)
      if (!s || !['start', 'collect', 'confirm'].includes(s.state)) return null
      return rt().reply(ctx, session, message)
    },
  }
}
