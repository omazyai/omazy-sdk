import { OmazyError } from './errors.js'
import type { TranscriptFinal, TranscriptionDone, TranscriptionEvent, TranscriptionStreamOptions } from './types.js'

/**
 * The part of a WebSocket the session uses: the browser and Node `WebSocket`,
 * Bun's, Deno's and a Cloudflare Worker's all have it.
 */
export interface SocketLike {
  binaryType?: string
  readyState?: number
  send(data: string | ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: any) => void): void
}

/** Opens a socket to `url` that sends `headers` on the upgrade. */
export type WebSocketFactory = (url: string, headers: Record<string, string>) => SocketLike | Promise<SocketLike>

/**
 * The default way to open the socket. In a Cloudflare Worker the upgrade is a
 * fetch with an Upgrade header. Elsewhere the runtime's WebSocket is given the
 * headers as its second argument, which Node 22 and later, Bun and Deno take.
 */
export function defaultWebSocket(fetcher: typeof fetch): WebSocketFactory {
  return async (url, headers) => {
    if (typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== 'undefined') {
      const res = await fetcher(url.replace(/^ws/, 'http'), { headers: { ...headers, upgrade: 'websocket' } })
      const ws = (res as Response & { webSocket?: SocketLike & { accept(): void } }).webSocket
      if (!ws) throw await refusal(res)
      ws.accept()
      return ws
    }
    const WS = (globalThis as { WebSocket?: new (url: string, init?: unknown) => SocketLike }).WebSocket
    if (!WS) throw new OmazyError('this runtime has no WebSocket; pass the webSocket option', 0, 'NETWORK_ERROR')
    return new WS(url, { headers })
  }
}

async function refusal(res: Response): Promise<OmazyError> {
  const text = await res.text().catch(() => '')
  let code = `HTTP_${res.status}`
  let message = text.slice(0, 300) || `the upgrade was answered with ${res.status}`
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string } }
    if (body.error?.code) code = body.error.code
    if (body.error?.message) message = body.error.message
  } catch {
    // not JSON
  }
  return new OmazyError(message, res.status, code, res.headers.get('x-request-id') ?? undefined)
}

type Waiter<T> = { resolve: (v: T) => void; reject: (e: OmazyError) => void }

/**
 * One live transcription. Send audio as it is captured; `commit()` after each
 * utterance (a button let go) resolves with its text; `end()` finishes the
 * session and resolves with every final joined.
 */
export class TranscriptionSession {
  private readonly queue: TranscriptionEvent[] = []
  private readonly readers: Waiter<IteratorResult<TranscriptionEvent>>[] = []
  private readonly commits: Waiter<TranscriptFinal>[] = []
  private done?: Waiter<TranscriptionDone>
  private finished = false
  private failure?: OmazyError

  /** The request id of the session, from its `ready` frame. */
  requestId?: string

  constructor(
    private readonly ws: SocketLike,
    private readonly onEvent?: (e: TranscriptionEvent) => void,
  ) {
    ws.addEventListener('message', (ev: { data: unknown }) => {
      if (typeof ev.data !== 'string') return
      let e: TranscriptionEvent
      try {
        e = JSON.parse(ev.data) as TranscriptionEvent
      } catch {
        return
      }
      this.dispatch(e)
    })
    ws.addEventListener('close', (ev: { code?: number; reason?: string }) => {
      this.finish(new OmazyError(`the session closed before it was done${ev?.reason ? `: ${ev.reason}` : ''}`, 0, 'STREAM_ERROR', this.requestId))
    })
    ws.addEventListener('error', () => {
      this.finish(new OmazyError('the session failed', 0, 'NETWORK_ERROR', this.requestId))
    })
  }

  /** Audio, in the format the session was opened with, as it is captured. */
  send(audio: ArrayBuffer | ArrayBufferView): void {
    this.ws.send(audio)
  }

  /** Ends the current utterance and keeps the session open. Resolves with its final, whose text may be empty. */
  commit(): Promise<TranscriptFinal> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure)
      this.commits.push({ resolve, reject })
      this.ws.send(JSON.stringify({ type: 'commit' }))
    })
  }

  /** Holds the session while no audio flows. Omazy closes a session silent for 60 s. */
  keepalive(): void {
    this.ws.send(JSON.stringify({ type: 'keepalive' }))
  }

  /** No more audio. Resolves with the whole transcript; the socket then closes. */
  end(): Promise<TranscriptionDone> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure)
      this.done = { resolve, reject }
      this.ws.send(JSON.stringify({ type: 'end' }))
    })
  }

  /** Closes the socket without waiting for an answer. */
  close(): void {
    try {
      this.ws.close(1000, 'client closed')
    } catch {
      // already closed
    }
  }

  /** Every frame from Omazy, in order. Ends after `done`; throws on an `error` frame. */
  events(): AsyncIterableIterator<TranscriptionEvent> {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next(): Promise<IteratorResult<TranscriptionEvent>> {
        const e = self.queue.shift()
        if (e) return Promise.resolve({ value: e, done: false })
        if (self.failure) return Promise.reject(self.failure)
        if (self.finished) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => self.readers.push({ resolve, reject }))
      },
    }
  }

  private dispatch(e: TranscriptionEvent) {
    if (e.type === 'ready') this.requestId = e.request_id
    this.onEvent?.(e)
    if (e.type === 'error') {
      this.finish(new OmazyError(e.message, 0, e.code, e.request_id ?? this.requestId))
      return
    }
    const reader = this.readers.shift()
    if (reader) reader.resolve({ value: e, done: false })
    else this.queue.push(e)
    if (e.type === 'final' && e.committed) this.commits.shift()?.resolve(e)
    if (e.type === 'done') {
      this.done?.resolve(e)
      this.done = undefined
      this.finish()
    }
  }

  private finish(err?: OmazyError) {
    if (this.finished) return
    this.finished = true
    if (err) {
      this.failure = err
      for (const c of this.commits.splice(0)) c.reject(err)
      this.done?.reject(err)
      this.done = undefined
    }
    for (const r of this.readers.splice(0)) {
      if (err) r.reject(err)
      else r.resolve({ value: undefined, done: true })
    }
  }
}

/** Opens the socket and sends the start frame. */
export async function openTranscription(
  factory: WebSocketFactory,
  url: string,
  headers: Record<string, string>,
  opts: TranscriptionStreamOptions,
): Promise<TranscriptionSession> {
  const ws = await factory(url, headers)
  ws.binaryType = 'arraybuffer'
  // A Worker's accepted socket is open already; a constructed one is not.
  if (ws.readyState !== 1) {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new OmazyError('could not open the transcription socket', 0, 'NETWORK_ERROR')))
      ws.addEventListener('close', (ev: { code?: number; reason?: string }) =>
        reject(new OmazyError(`the transcription socket was refused${ev?.reason ? `: ${ev.reason}` : ''}`, 0, 'NETWORK_ERROR')),
      )
    })
  }
  const session = new TranscriptionSession(ws, opts.onEvent)
  ws.send(
    JSON.stringify({
      type: 'start',
      language: opts.language,
      terms: opts.terms,
      audio_format: opts.audioFormat,
      sample_rate: opts.sampleRate,
      num_channels: opts.numChannels,
    }),
  )
  return session
}
