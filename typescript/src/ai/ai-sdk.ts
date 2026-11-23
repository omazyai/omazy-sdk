// @omazyai/sdk/ai-sdk: a Vercel AI SDK language model (LanguageModelV4) over
// a run of the ai kit. `generateText`, `streamText`, `Output.object` and the
// tool loop work as usual, and every call still goes through the run's
// gateway: the unit's role, the tags, the cache policy, the caps and the usage.
// The model is made from a run, never from a bare token, so no call happens
// outside a unit. Install `@ai-sdk/provider` 4.0.39 beside the SDK; only its
// types are used.

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
  SharedV4Warning,
} from '@ai-sdk/provider'
import type { BaseCtx } from '../capabilities/capability.js'
import type { Registry } from '../capabilities/registry.js'
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '../capabilities/standard.js'
import type { CompleteResult, Image, Message, ToolCall, ToolResult } from '../types.js'
import type { ModelRequest, RunCallOutcome, RunScope } from './ai.js'

export interface OmazyModelOptions {
  /** This model's calls carry live data: `cache_ttl: 0`. Default: the unit's recipe. */
  live?: boolean
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function toolOutputText(output: unknown): { content: string; is_error?: boolean } {
  const o = output as { type: string; value?: unknown; reason?: string }
  switch (o.type) {
    case 'text':
      return { content: String(o.value) }
    case 'error-text':
      return { content: String(o.value), is_error: true }
    case 'json':
      return { content: JSON.stringify(o.value) }
    case 'error-json':
      return { content: JSON.stringify(o.value), is_error: true }
    case 'execution-denied':
      return { content: o.reason ? `Not run: ${o.reason}` : 'Not run: the person declined.', is_error: true }
    default:
      return { content: JSON.stringify(o.value ?? null) }
  }
}

/** The AI SDK prompt as the Core API's system and messages. Parts it cannot send become warnings. */
export function toCoreMessages(prompt: LanguageModelV4Prompt, warnings: SharedV4Warning[]): { system?: string; messages: Message[] } {
  const system: string[] = []
  const messages: Message[] = []
  const push = (m: Message) => {
    const last = messages[messages.length - 1]
    // The Core API takes alternating turns; tool results ride on a user turn.
    if (last && last.role === m.role && !last.tool_calls?.length) {
      last.content = [last.content, m.content].filter(Boolean).join('\n\n')
      if (m.images) last.images = [...(last.images ?? []), ...m.images]
      if (m.tool_results) last.tool_results = [...(last.tool_results ?? []), ...m.tool_results]
      if (m.tool_calls) last.tool_calls = [...(last.tool_calls ?? []), ...m.tool_calls]
    } else messages.push(m)
  }
  for (const msg of prompt) {
    if (msg.role === 'system') {
      system.push(msg.content)
      continue
    }
    if (msg.role === 'user') {
      const text: string[] = []
      const images: Image[] = []
      for (const part of msg.content) {
        if (part.type === 'text') text.push(part.text)
        else if (part.type === 'file' && IMAGE_TYPES.has(part.mediaType)) {
          const d = part.data
          if (d.type === 'url') images.push({ url: d.url.toString() })
          else if (d.type === 'data') images.push({ data: typeof d.data === 'string' ? d.data : base64(d.data), media_type: part.mediaType as 'image/png' })
          else warnings.push({ type: 'unsupported', feature: `file data of type ${d.type}` })
        } else warnings.push({ type: 'unsupported', feature: `user part ${(part as { mediaType?: string }).mediaType ?? (part as { type: string }).type}` })
      }
      push({ role: 'user', content: text.join('\n'), ...(images.length ? { images } : {}) })
      continue
    }
    if (msg.role === 'assistant') {
      const text: string[] = []
      const calls: ToolCall[] = []
      const results: ToolResult[] = []
      for (const part of msg.content) {
        if (part.type === 'text') text.push(part.text)
        else if (part.type === 'tool-call') calls.push({ id: part.toolCallId, name: part.toolName, input: part.input })
        else if (part.type === 'tool-result') results.push({ call_id: part.toolCallId, ...toolOutputText(part.output) })
        else if (part.type !== 'reasoning') warnings.push({ type: 'unsupported', feature: `assistant part ${part.type}` })
      }
      push({ role: 'assistant', content: text.join('\n'), ...(calls.length ? { tool_calls: calls } : {}) })
      if (results.length) push({ role: 'user', content: '', tool_results: results })
      continue
    }
    // role: 'tool'
    const results: ToolResult[] = []
    for (const part of msg.content) {
      if (part.type === 'tool-result') results.push({ call_id: part.toolCallId, ...toolOutputText(part.output) })
      else warnings.push({ type: 'unsupported', feature: 'tool approval responses' })
    }
    if (results.length) push({ role: 'user', content: '', tool_results: results })
  }
  return { ...(system.length ? { system: system.join('\n\n') } : {}), messages }
}

/** The AI SDK call options as a gateway request. The unit owns the model, temperature and cache; other settings are warned about. */
export function toModelRequest(options: LanguageModelV4CallOptions): { req: ModelRequest; warnings: SharedV4Warning[] } {
  const warnings: SharedV4Warning[] = []
  const { system, messages } = toCoreMessages(options.prompt, warnings)
  const req: ModelRequest = { ...(system ? { system } : {}), messages }
  if (options.maxOutputTokens !== undefined) req.max_tokens = options.maxOutputTokens
  if (options.temperature !== undefined) warnings.push({ type: 'unsupported', feature: 'temperature', details: "The unit's manifest sets the temperature." })
  for (const k of ['topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'seed', 'stopSequences'] as const) {
    if (options[k] !== undefined) warnings.push({ type: 'unsupported', feature: k })
  }
  if (options.reasoning !== undefined && options.reasoning !== 'provider-default') warnings.push({ type: 'unsupported', feature: 'reasoning' })
  const tools = (options.tools ?? []).flatMap((t) => {
    if (t.type === 'function') return [{ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.inputSchema as Record<string, unknown> }]
    warnings.push({ type: 'unsupported', feature: `provider tool ${t.name}` })
    return []
  })
  if (tools.length) req.tools = tools
  const tc = options.toolChoice
  if (tc && tools.length) {
    req.tool_choice = tc.type === 'auto' ? 'auto' : tc.type === 'none' ? 'none' : tc.type === 'required' ? 'any' : { type: 'tool', name: tc.toolName }
  }
  const rf = options.responseFormat
  if (rf?.type === 'json') {
    req.response_format = rf.schema
      ? { type: 'json_schema', json_schema: { name: rf.name ?? 'output', schema: rf.schema as Record<string, unknown> } }
      : { type: 'json_object' }
  }
  return { req, warnings }
}

export function finishReasonOf(stop: string | undefined): LanguageModelV4FinishReason {
  const s = (stop ?? '').toLowerCase()
  const unified: LanguageModelV4FinishReason['unified'] =
    s === 'stop' || s === 'end_turn' || s === 'stop_sequence'
      ? 'stop'
      : s === 'max_tokens' || s === 'length'
        ? 'length'
        : s === 'tool_use' || s === 'tool_calls'
          ? 'tool-calls'
          : s === 'content_filter'
            ? 'content-filter'
            : 'other'
  return { unified, raw: stop }
}

export function usageOf(res: Pick<CompleteResult, 'usage'>): LanguageModelV4Usage {
  const u = res.usage ?? { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }
  const cached = u.cached_input_tokens ?? 0
  return {
    inputTokens: { total: u.input_tokens, noCache: (u.input_tokens ?? 0) - cached, cacheRead: cached, cacheWrite: undefined },
    outputTokens: { total: u.output_tokens, text: u.output_tokens, reasoning: undefined },
  }
}

function contentOf(res: CompleteResult): LanguageModelV4Content[] {
  const out: LanguageModelV4Content[] = []
  if (res.text) out.push({ type: 'text', text: res.text })
  for (const c of res.tool_calls ?? []) out.push({ type: 'tool-call', toolCallId: c.id, toolName: c.name, input: JSON.stringify(c.input ?? {}) })
  return out
}

const metadataOf = (scope: RunScope<any>, res: CompleteResult) => ({
  omazy: { runId: scope.id, unit: scope.unit.id, model: res.model, ...(res.role ? { role: res.role } : {}), cacheHit: res.cache_hit === true },
})

/**
 * A LanguageModelV4 whose every call is a call of this run. Pass it to
 * `generateText`, `streamText` or `Agent` from `ai`.
 *
 * ```ts
 * const run = await ai.start(ctx, copilot)
 * const { text } = await generateText({ model: omazyModel(run), prompt: question })
 * await run.finish('ok')
 * ```
 */
export function omazyModel<C extends BaseCtx>(scope: RunScope<C>, o: OmazyModelOptions = {}): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'omazy',
    modelId: `role:${scope.unit.model.use}`,
    // Images go to the Core API as URLs, which the provider fetches.
    supportedUrls: { 'image/*': [/^https:\/\//] },

    async doGenerate(options): Promise<LanguageModelV4GenerateResult> {
      const { req, warnings } = toModelRequest(options)
      const res = await scope.complete(req, { signal: options.abortSignal, ...(o.live !== undefined ? { live: o.live } : {}) })
      return {
        content: contentOf(res),
        ...(res.output !== undefined ? { structuredOutputText: JSON.stringify(res.output) } : {}),
        finishReason: finishReasonOf(res.stop_reason),
        usage: usageOf(res),
        providerMetadata: metadataOf(scope, res),
        request: { body: req },
        response: { modelId: res.model },
        warnings,
      }
    },

    async doStream(options): Promise<LanguageModelV4StreamResult> {
      const { req, warnings } = toModelRequest(options)
      const events = scope.stream(req, { signal: options.abortSignal, ...(o.live !== undefined ? { live: o.live } : {}) })
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings })
          let open = false
          try {
            for await (const ev of events) {
              if (ev.type === 'delta') {
                if (!open) controller.enqueue({ type: 'text-start', id: 'text' })
                open = true
                controller.enqueue({ type: 'text-delta', id: 'text', delta: ev.text })
                continue
              }
              const res = ev.result
              if (!open && res.text) {
                // A reply that arrived whole (a cache hit, a JSON reply) still reads as text.
                controller.enqueue({ type: 'text-start', id: 'text' })
                controller.enqueue({ type: 'text-delta', id: 'text', delta: res.text })
                open = true
              }
              if (open) controller.enqueue({ type: 'text-end', id: 'text' })
              for (const c of res.tool_calls ?? []) {
                controller.enqueue({ type: 'tool-call', toolCallId: c.id, toolName: c.name, input: JSON.stringify(c.input ?? {}) })
              }
              controller.enqueue({ type: 'response-metadata', modelId: res.model })
              controller.enqueue({ type: 'finish', finishReason: finishReasonOf(res.stop_reason), usage: usageOf(res), providerMetadata: metadataOf(scope, res) })
            }
          } catch (e) {
            controller.enqueue({ type: 'error', error: e })
          }
          controller.close()
        },
      })
      return { stream, request: { body: req } }
    },
  }
}

// ---------------------------------------------------------------- tools

/**
 * An AI SDK tool as `generateText` and `streamText` take it: a description,
 * an input schema (a Standard Schema with its JSON Schema, which the AI SDK
 * reads as is) and `execute`.
 */
export interface AiSdkTool {
  description: string
  inputSchema: StandardSchemaV1<unknown, unknown> & StandardJSONSchemaV1<unknown, unknown>
  execute: (input: unknown, options?: { toolCallId?: string; abortSignal?: AbortSignal }) => Promise<ToolAnswer>
}

/** What the model reads back from a tool: the result, or what happened instead, never a confirm token. */
export type ToolAnswer =
  | { status: 'ok'; result: unknown }
  | { status: 'confirm_required'; summary: string; message: string }
  | { status: 'pending_approval'; decider: string; expiresAt: string; message: string; reviewUrl?: string }
  | { status: 'refused'; outcome: string; message: string }

export interface AiSdkToolsOptions<C extends BaseCtx = BaseCtx> {
  /** The capabilities to offer. Default: the unit's `tools.allow`. */
  names?: readonly string[]
  /**
   * Every guard outcome, as it happened, with the tool call's id. Use it to
   * show the confirm card for `confirm_required` (it carries the token) and
   * the approval for `pending_approval`.
   */
  onOutcome?: (name: string, outcome: RunCallOutcome, toolCallId: string | undefined, run: RunScope<C>) => void | Promise<void>
}

/** The guard's outcome as the model may read it. */
export function toolAnswer(out: RunCallOutcome): ToolAnswer {
  switch (out.outcome) {
    case 'ok':
      return { status: 'ok', result: out.result }
    case 'confirm_required':
      return {
        status: 'confirm_required',
        summary: out.preview.summary,
        message: 'Not done yet. A person must confirm this on the card shown to them. Do not say it is done.',
      }
    case 'pending_approval':
      return {
        status: 'pending_approval',
        decider: out.approval.decider,
        expiresAt: out.approval.expiresAt,
        message: `Not done yet. It waits for approval by ${out.approval.decider}. Do not say it is done.`,
        ...(out.approval.reviewUrl ? { reviewUrl: out.approval.reviewUrl } : {}),
      }
    default:
      return { status: 'refused', outcome: out.outcome, message: out.message }
  }
}

/**
 * AI SDK tools for capabilities in the registry, each one's `execute` going
 * through `run.call()`: the unit's allow list and tier, the guard, and the
 * effects ledger. Tools built by hand, with their own `execute`, skip all of
 * that; build every tool that acts on the product with this.
 *
 * ```ts
 * const run = await ai.start(ctx, copilot)
 * const result = streamText({ model: omazyModel(run), tools: aiSdkTools(run, reg), messages })
 * ```
 */
export function aiSdkTools<C extends BaseCtx>(run: RunScope<C>, registry: Registry<any, any, any>, opts: AiSdkToolsOptions<C> = {}): Record<string, AiSdkTool> {
  const names = opts.names ?? run.unit.tools?.allow ?? []
  const tools: Record<string, AiSdkTool> = {}
  for (const name of names) {
    const cap = registry.get(name)
    if (!cap) throw new Error(`aiSdkTools: ${name} is not in the registry`)
    const json = cap.inputJson
    tools[name] = {
      description: registry.describe(name),
      // The guard validates the arguments; the schema here only describes them.
      inputSchema: {
        '~standard': {
          version: 1,
          vendor: 'omazy',
          validate: (value: unknown) => ({ value }),
          jsonSchema: { input: () => structuredClone(json), output: () => structuredClone(json) },
        },
      },
      async execute(input, options) {
        const out = await run.call(name, input)
        await opts.onOutcome?.(name, out, options?.toolCallId, run)
        return toolAnswer(out)
      },
    }
  }
  return tools
}
