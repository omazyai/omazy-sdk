// The product's own data: notes, one table per tenant's rows. The kits never
// see this table; capabilities reach it through a store, D1 in the Worker and
// memory in tests.

import type { D1DatabaseLike } from '@omazyai/sdk/guard'

export interface Note {
  id: string
  title: string
  createdAt: string
}

export interface NotesStore {
  get(tenant: string, id: string): Promise<Note | null>
  add(tenant: string, title: string): Promise<Note>
  /** The tenant a note belongs to, for the guard's tenant check. Null when there is no such note. */
  tenantOf(id: string): Promise<string | null>
  /** Every row, so a test can see whether anything was written. */
  count(): Promise<number>
}

const newId = () => `n_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

interface Row {
  id: string
  tenant: string
  title: string
  created_at: string
}

export function d1Notes(db: D1DatabaseLike): NotesStore {
  const one = async (sql: string, ...bind: unknown[]) => ((await db.prepare(sql).bind(...bind).all()).results?.[0] as Row | undefined) ?? null
  return {
    async get(tenant, id) {
      const r = await one('SELECT id, tenant, title, created_at FROM notes WHERE tenant = ? AND id = ?', tenant, id)
      return r ? { id: r.id, title: r.title, createdAt: r.created_at } : null
    },
    async add(tenant, title) {
      const note = { id: newId(), title, createdAt: new Date().toISOString() }
      await db.prepare('INSERT INTO notes (id, tenant, title, created_at) VALUES (?, ?, ?, ?)').bind(note.id, tenant, title, note.createdAt).run()
      return note
    },
    async tenantOf(id) {
      return (await one('SELECT tenant FROM notes WHERE id = ?', id))?.tenant ?? null
    },
    async count() {
      const r = (await db.prepare('SELECT COUNT(*) AS n FROM notes').all()).results?.[0] as { n: number } | undefined
      return r?.n ?? 0
    },
  }
}

export function memoryNotes(): NotesStore & { rows: Row[] } {
  const rows: Row[] = []
  return {
    rows,
    async get(tenant, id) {
      const r = rows.find((x) => x.tenant === tenant && x.id === id)
      return r ? { id: r.id, title: r.title, createdAt: r.created_at } : null
    },
    async add(tenant, title) {
      const note = { id: newId(), title, createdAt: new Date().toISOString() }
      rows.push({ id: note.id, tenant, title, created_at: note.createdAt })
      return note
    },
    async tenantOf(id) {
      return rows.find((x) => x.id === id)?.tenant ?? null
    },
    async count() {
      return rows.length
    },
  }
}
