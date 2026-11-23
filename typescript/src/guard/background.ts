// Work that runs after the response: the request log and approval notices.
// It never delays a call and never fails one.

export type WaitUntil = (p: Promise<unknown>) => void

export function runAfter(task: () => Promise<unknown>, waitUntil: WaitUntil | undefined, onError: (err: unknown, where: string) => void, where: string): void {
  // A microtask later, so even a hook that blocks synchronously starts after the caller has its result.
  const p = Promise.resolve()
    .then(task)
    .catch((err) => {
      try {
        onError(err, where)
      } catch {
        // nothing more to do
      }
    })
  if (waitUntil) {
    try {
      waitUntil(p)
    } catch (err) {
      onError(err, `${where}: waitUntil`)
    }
  }
}
