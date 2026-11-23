// Tool search. A copilot sends the model a small core set of tools and a
// search tool; the model searches by what the person said and gets the rest.
// BM25 over name, title, description and synonyms, with the name and the
// synonyms weighted up. No dependencies, no embeddings, runs on a Worker.

export interface Searchable {
  name: string
  title: string
  description: string
  synonyms?: readonly string[]
  audiences: readonly string[]
}

export interface SearchOptions<A extends string = string> {
  /** Only capabilities this door may see. */
  audience?: A
  /** At most this many hits. Default 8. */
  limit?: number
  /** Names already sent, left out of the hits. */
  exclude?: readonly string[]
}

export interface SearchHit {
  name: string
  score: number
}

export interface SearchIndex {
  search(query: string, opts?: SearchOptions): SearchHit[]
}

const STOP = new Set(
  'a an and are as at be by can do does for from has have how i in is it its me my not of on or our so that the their them then this to use was we what when which with you your'.split(' '),
)

/** Lower case words and numbers in any script, with a light plural strip. `tenant_list` gives `tenant`, `list`. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
}

const WEIGHTS = { name: 3, synonyms: 2, title: 2, description: 1 }
const K1 = 1.2
const B = 0.75

export function searchIndex(items: readonly Searchable[]): SearchIndex {
  const docs = items.map((it) => {
    const tf = new Map<string, number>()
    let len = 0
    const add = (text: string, w: number) => {
      for (const t of tokenize(text)) {
        tf.set(t, (tf.get(t) ?? 0) + w)
        len += w
      }
    }
    add(it.name, WEIGHTS.name)
    add((it.synonyms ?? []).join(' '), WEIGHTS.synonyms)
    add(it.title, WEIGHTS.title)
    add(it.description, WEIGHTS.description)
    return { it, tf, len }
  })
  const n = docs.length
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, n)
  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const idf = (t: string) => {
    const f = df.get(t) ?? 0
    return Math.log(1 + (n - f + 0.5) / (f + 0.5))
  }

  return {
    search(query, opts = {}) {
      const terms = [...new Set(tokenize(query))]
      if (!terms.length) return []
      const skip = new Set(opts.exclude ?? [])
      const hits: SearchHit[] = []
      for (const d of docs) {
        if (skip.has(d.it.name)) continue
        if (opts.audience !== undefined && !d.it.audiences.includes(opts.audience)) continue
        let score = 0
        for (const t of terms) {
          const f = d.tf.get(t)
          if (!f) continue
          score += idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avg)))
        }
        if (score > 0) hits.push({ name: d.it.name, score: Math.round(score * 1000) / 1000 })
      }
      hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      return hits.slice(0, opts.limit ?? 8)
    },
  }
}
