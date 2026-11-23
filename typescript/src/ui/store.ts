// A small external store for one loaded thing (a list, a row) that a
// framework subscribes to: React through `useSyncExternalStore`, Preact
// through its own hook, plain code through `subscribe`. It loads on the
// first subscriber and, with `pollMs`, reloads while anyone is subscribed.

export interface ResourceState<T> {
  status: 'loading' | 'ready' | 'error'
  data: T | undefined
  error: Error | undefined
}

export interface Resource<T> {
  getSnapshot(): ResourceState<T>
  subscribe(listener: () => void): () => void
  /** Loads again. Keeps the old data while it loads. */
  refresh(): Promise<void>
  /** Replaces the data, as after a change the server confirmed. */
  set(update: T | ((cur: T | undefined) => T)): void
}

export function createResource<T>(load: () => Promise<T>, opts: { pollMs?: number; lazy?: boolean } = {}): Resource<T> {
  let state: ResourceState<T> = { status: 'loading', data: undefined, error: undefined }
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | null = null
  let started = false
  let seq = 0
  const emit = (next: ResourceState<T>) => {
    state = next
    for (const l of [...listeners]) l()
  }
  const r: Resource<T> = {
    getSnapshot: () => state,
    subscribe(l) {
      listeners.add(l)
      if (!started && !opts.lazy) {
        started = true
        void r.refresh()
      }
      if (opts.pollMs && !timer) timer = setInterval(() => void r.refresh(), opts.pollMs)
      return () => {
        listeners.delete(l)
        if (!listeners.size && timer) {
          clearInterval(timer)
          timer = null
        }
      }
    },
    async refresh() {
      started = true
      const mine = ++seq
      if (state.status === 'error') emit({ ...state, status: 'loading' })
      try {
        const data = await load()
        if (mine === seq) emit({ status: 'ready', data, error: undefined })
      } catch (e) {
        if (mine === seq) emit({ status: 'error', data: state.data, error: e instanceof Error ? e : new Error(String(e)) })
      }
    },
    set(update) {
      seq++
      const data = typeof update === 'function' ? (update as (c: T | undefined) => T)(state.data) : update
      emit({ status: 'ready', data, error: undefined })
    },
  }
  return r
}
