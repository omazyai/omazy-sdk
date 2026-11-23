// The AI SDK UI message stream, written by hand. A copilot turn is sent as
// server-sent events whose `data` is one UI message chunk each, ending with
// `[DONE]`, under the `x-vercel-ai-ui-message-stream: v1` header. `useChat`
// from `@ai-sdk/react` (or any client of the protocol) reads it as is. The
// kit does not import `ai`: the chunk shapes are small and written here.

/** The chunks the copilot sends. A subset of the AI SDK's `UIMessageChunk`. */
export type UiChunk =
  | { type: 'start'; messageId?: string; messageMetadata?: unknown }
  | { type: 'start-step' }
  | { type: 'finish-step' }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown; dynamic: true; title?: string }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown; dynamic: true }
  | { type: `data-${string}`; id?: string; data: unknown; transient?: boolean }
  | { type: 'error'; errorText: string }
  | { type: 'finish'; finishReason?: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'; messageMetadata?: unknown }

/** The headers the AI SDK sends with a UI message stream. */
export const UI_STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
})

/** One part of a stored UI message, as `useChat` keeps it. */
export type UiPart =
  | { type: 'text'; text: string; state?: 'done' }
  | { type: 'dynamic-tool'; toolName: string; toolCallId: string; state: 'output-available'; input: unknown; output: unknown; title?: string }
  | { type: `data-${string}`; id?: string; data: unknown }

/** A stored message, in the AI SDK's `UIMessage` shape, so `useChat` can start from it. */
export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  parts: UiPart[]
  metadata?: Record<string, unknown>
}

/**
 * Writes chunks to a stream and builds the same message as a client would,
 * so the thread keeps exactly what the person saw.
 */
export interface UiWriter {
  readonly stream: ReadableStream<Uint8Array>
  /** The assistant message so far. */
  readonly message: UiMessage
  write(chunk: UiChunk): void
  text(delta: string): void
  /** Closes an open text part. */
  endText(): void
  /** A data part, such as a consent card. A part with an id replaces the earlier one with that id. */
  data(name: string, data: unknown, id?: string): void
  tool(toolCallId: string, toolName: string, input: unknown, output: unknown): void
  error(message: string): void
  /** Sends `finish` and `[DONE]` and closes the stream. Idempotent. */
  close(finishReason?: 'stop' | 'error' | 'other'): void
}

export function uiWriter(messageId: string): UiWriter {
  const enc = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const queued: Uint8Array[] = []
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      for (const q of queued) c.enqueue(q)
      queued.length = 0
    },
    cancel() {
      // The client went away. The turn still finishes and is saved.
      closed = true
    },
  })
  const send = (payload: string) => {
    if (closed) return
    const bytes = enc.encode(`data: ${payload}\n\n`)
    if (controller) {
      try {
        controller.enqueue(bytes)
      } catch {
        closed = true
      }
    } else queued.push(bytes)
  }
  const message: UiMessage = { id: messageId, role: 'assistant', parts: [] }
  let textId: string | null = null
  let textPart: { type: 'text'; text: string; state?: 'done' } | null = null
  let n = 0

  const w: UiWriter = {
    stream,
    message,
    write(chunk) {
      send(JSON.stringify(chunk))
    },
    text(delta) {
      if (!delta) return
      if (!textId) {
        textId = `t${++n}`
        textPart = { type: 'text', text: '' }
        message.parts.push(textPart)
        w.write({ type: 'text-start', id: textId })
      }
      textPart!.text += delta
      w.write({ type: 'text-delta', id: textId, delta })
    },
    endText() {
      if (!textId) return
      w.write({ type: 'text-end', id: textId })
      textPart!.state = 'done'
      textId = null
      textPart = null
    },
    data(name, data, id) {
      w.endText()
      const type = `data-${name}` as const
      const at = id === undefined ? -1 : message.parts.findIndex((p) => p.type === type && (p as { id?: string }).id === id)
      const part = { type, ...(id !== undefined ? { id } : {}), data } as UiPart
      if (at >= 0) message.parts[at] = part
      else message.parts.push(part)
      w.write({ type, ...(id !== undefined ? { id } : {}), data })
    },
    tool(toolCallId, toolName, input, output) {
      w.endText()
      message.parts.push({ type: 'dynamic-tool', toolName, toolCallId, state: 'output-available', input, output })
      w.write({ type: 'tool-input-available', toolCallId, toolName, input, dynamic: true })
      w.write({ type: 'tool-output-available', toolCallId, output, dynamic: true })
    },
    error(text) {
      w.endText()
      w.write({ type: 'error', errorText: text })
    },
    close(finishReason = 'stop') {
      if (closed) return
      w.endText()
      w.write({ type: 'finish', finishReason })
      send('[DONE]')
      closed = true
      try {
        controller?.close()
      } catch {
        // already closed by the client
      }
    },
  }
  w.write({ type: 'start', messageId })
  return w
}

/** A whole stream as a Response with the AI SDK's headers. */
export function uiResponse(stream: ReadableStream<Uint8Array>, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(stream, { status: init.status ?? 200, headers: { ...UI_STREAM_HEADERS, ...(init.headers ?? {}) } })
}

/** Reads a UI message stream back into its chunks. For tests and for a server that relays one. */
export async function readUiChunks(stream: ReadableStream<Uint8Array>): Promise<UiChunk[]> {
  const text = await new Response(stream).text()
  const out: UiChunk[] = []
  for (const frame of text.split('\n\n')) {
    const line = frame.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    const payload = line.slice(6)
    if (payload === '[DONE]') break
    out.push(JSON.parse(payload) as UiChunk)
  }
  return out
}
