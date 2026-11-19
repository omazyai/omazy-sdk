export interface SseFrame {
  event: string
  data: string
}

/**
 * Reads a server-sent event stream into frames. Bytes are decoded as a stream,
 * so a character or a frame split across two chunks is put back together.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buf += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      let cut: number
      while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, cut)
        buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '')
        const frame = parseFrame(raw)
        if (frame) yield frame
      }
      if (done) break
    }
    const last = parseFrame(buf)
    if (last) yield last
  } finally {
    reader.releaseLock()
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = 'message'
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return data.length ? { event, data: data.join('\n') } : null
}
