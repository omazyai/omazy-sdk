// A chat on the AI SDK UI message stream, without React and without `ai`.
// `createChat` keeps the same state `useChat` from `@ai-sdk/react` keeps
// (messages, status, error) and has the same verbs (sendMessage,
// setMessages, stop), so the panel takes either. A product on Preact or no
// framework subscribes to it directly.

/** One part of a message. Loose on purpose: the AI SDK's parts and the copilot's both fit. */
export interface ChatPart {
  type: string
  id?: string
  text?: string
  state?: string
  data?: unknown
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  [extra: string]: unknown
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: ChatPart[]
  metadata?: unknown
}

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

/** What `useChat` returns, as far as the panel reads it. */
export interface ChatLike {
  messages: ChatMessage[]
  status: ChatStatus
  error?: Error | undefined
  sendMessage(message: { text: string }): unknown
  setMessages(messages: ChatMessage[] | ((m: ChatMessage[]) => ChatMessage[])): void
  stop?(): unknown
}

export interface ChatState {
  messages: ChatMessage[]
  status: ChatStatus
  error: Error | undefined
}

export interface ChatOptions {
  /** The chat route, such as `/copilot/chat`. */
  api: string
  /** The chat id: the copilot's thread. */
  id: string
  messages?: ChatMessage[]
  fetch?: typeof fetch
  headers?: Record<string, string> | (() => Record<string, string>)
  /** Extra body fields on every send, such as `{ screen: { name, id } }`. */
  body?: () => Record<string, unknown>
  /** Called with each transient data part, which is not kept on the message. */
  onData?: (part: ChatPart) => void
  newId?: () => string
}

export interface ChatStore extends Omit<ChatLike, 'messages' | 'status' | 'error'> {
  getSnapshot(): ChatState
  subscribe(listener: () => void): () => void
  sendMessage(message: { text: string }): Promise<void>
  stop(): void
  clearError(): void
}

/** Reads server-sent events from a stream, one JSON chunk per `data:` frame, until `[DONE]`. */
export async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buf += done ? dec.decode() : dec.decode(value, { stream: true })
      buf = buf.replace(/\r\n/g, '\n')
      let at: number
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, at)
        buf = buf.slice(at + 2)
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n')
        if (!data) continue
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data) as Record<string, unknown>
        } catch {
          // A frame that is not JSON is skipped, as the AI SDK does.
        }
      }
      if (done) return
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Builds one assistant message from stream chunks, as `useChat` does. Each
 * call returns a new message object with new part objects where they changed,
 * so a renderer that compares by identity sees the change.
 */
export function messageBuilder(start: ChatMessage) {
  let msg: ChatMessage = { ...start, parts: [...start.parts] }
  const texts = new Map<string, number>()
  const tools = new Map<string, number>()
  const put = (i: number, part: ChatPart) => {
    const parts = [...msg.parts]
    parts[i] = part
    msg = { ...msg, parts }
  }
  const push = (part: ChatPart) => {
    msg = { ...msg, parts: [...msg.parts, part] }
    return msg.parts.length - 1
  }
  return {
    get message() {
      return msg
    },
    /** Applies one chunk. Returns the error text for an `error` chunk, `transient` for a transient data part. */
    apply(c: Record<string, unknown>): { error?: string; transient?: ChatPart } {
      const type = String(c.type ?? '')
      switch (type) {
        case 'start':
          if (typeof c.messageId === 'string') msg = { ...msg, id: c.messageId }
          if (c.messageMetadata !== undefined) msg = { ...msg, metadata: c.messageMetadata }
          return {}
        case 'finish':
        case 'message-metadata':
          if (c.messageMetadata !== undefined) msg = { ...msg, metadata: c.messageMetadata }
          return {}
        case 'text-start':
          texts.set(String(c.id), push({ type: 'text', text: '', state: 'streaming' }))
          return {}
        case 'text-delta': {
          let i = texts.get(String(c.id))
          if (i === undefined) texts.set(String(c.id), (i = push({ type: 'text', text: '', state: 'streaming' })))
          const p = msg.parts[i]!
          put(i, { ...p, text: (p.text ?? '') + String(c.delta ?? '') })
          return {}
        }
        case 'text-end': {
          const i = texts.get(String(c.id))
          if (i !== undefined) put(i, { ...msg.parts[i]!, state: 'done' })
          return {}
        }
        case 'tool-input-start':
        case 'tool-input-available': {
          const id = String(c.toolCallId)
          const part: ChatPart = c.dynamic
            ? { type: 'dynamic-tool', toolName: String(c.toolName), toolCallId: id, state: type === 'tool-input-start' ? 'input-streaming' : 'input-available', input: c.input }
            : { type: `tool-${String(c.toolName)}`, toolCallId: id, state: type === 'tool-input-start' ? 'input-streaming' : 'input-available', input: c.input }
          const i = tools.get(id)
          if (i === undefined) tools.set(id, push(part))
          else put(i, { ...msg.parts[i]!, ...part })
          return {}
        }
        case 'tool-output-available':
        case 'tool-output-error': {
          const i = tools.get(String(c.toolCallId))
          if (i === undefined) return {}
          const p = msg.parts[i]!
          put(i, type === 'tool-output-error' ? { ...p, state: 'output-error', errorText: c.errorText } : { ...p, state: 'output-available', output: c.output })
          return {}
        }
        case 'error':
          return { error: typeof c.errorText === 'string' ? c.errorText : 'error' }
        default:
          if (type.startsWith('data-')) {
            const part: ChatPart = { type, ...(typeof c.id === 'string' ? { id: c.id } : {}), data: c.data }
            if (c.transient) return { transient: part }
            const i = typeof c.id === 'string' ? msg.parts.findIndex((p) => p.type === type && p.id === c.id) : -1
            if (i >= 0) put(i, part)
            else push(part)
          }
          // start-step, finish-step, reasoning and sources are not shown.
          return {}
      }
    },
  }
}

const randomId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 24)

async function errorOf(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string }
    const m = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message
    if (m) return new Error(m)
  } catch {
    // not JSON
  }
  return new Error(`HTTP ${res.status}`)
}

/**
 * A chat on a UI message stream route. Sends only the new user message (the
 * copilot keeps the history on the server), then reads the reply as it
 * streams.
 */
export function createChat(o: ChatOptions): ChatStore {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const newId = o.newId ?? randomId
  let state: ChatState = { messages: o.messages ?? [], status: 'ready', error: undefined }
  const listeners = new Set<() => void>()
  let abort: AbortController | null = null
  const set = (patch: Partial<ChatState>) => {
    state = { ...state, ...patch }
    for (const l of [...listeners]) l()
  }

  const store: ChatStore = {
    getSnapshot: () => state,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    setMessages(m) {
      set({ messages: typeof m === 'function' ? m(state.messages) : m })
    },
    clearError() {
      if (state.error) set({ error: undefined, status: 'ready' })
    },
    stop() {
      abort?.abort()
    },
    async sendMessage({ text }) {
      const t = text.trim()
      if (!t || state.status === 'submitted' || state.status === 'streaming') return
      const user: ChatMessage = { id: newId(), role: 'user', parts: [{ type: 'text', text: t }] }
      set({ messages: [...state.messages, user], status: 'submitted', error: undefined })
      const ctl = (abort = new AbortController())
      let builder: ReturnType<typeof messageBuilder> | null = null
      let at = -1
      let error: Error | undefined
      const show = () => {
        if (!builder) return
        const messages = [...state.messages]
        if (at < 0) {
          at = messages.length
          messages.push(builder.message)
        } else messages[at] = builder.message
        set({ messages, status: 'streaming' })
      }
      try {
        const headers = typeof o.headers === 'function' ? o.headers() : o.headers ?? {}
        const res = await doFetch(o.api, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ ...(o.body?.() ?? {}), id: o.id, trigger: 'submit-message', messageId: user.id, messages: [user] }),
          signal: ctl.signal,
        })
        if (!res.ok || !res.body) throw await errorOf(res)
        builder = messageBuilder({ id: newId(), role: 'assistant', parts: [] })
        for await (const chunk of readSse(res.body)) {
          const r = builder.apply(chunk)
          if (r.error) error = new Error(r.error)
          if (r.transient) o.onData?.(r.transient)
          else show()
        }
        show()
      } catch (e) {
        if (!ctl.signal.aborted) error = e instanceof Error ? e : new Error(String(e))
      } finally {
        if (abort === ctl) abort = null
        set(error ? { status: 'error', error } : { status: 'ready' })
      }
    },
  }
  return store
}
