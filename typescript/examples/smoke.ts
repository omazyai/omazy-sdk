// A live check against a real deployment. Reads OMAZY_CORE_TOKEN (and
// OMAZY_BASE_URL, if set). Spends a few tokens. Run: bun examples/smoke.ts
import { Omazy } from '../src/index'

const omazy = new Omazy({ token: process.env.OMAZY_CORE_TOKEN!, baseUrl: process.env.OMAZY_BASE_URL })

const me = await omazy.whoami()
console.log('whoami      ', me.app_slug, me.scopes.length, 'scopes, token', me.token, '| request', omazy.last.requestId)

const done = await omazy.ai.complete({ messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 8 })
console.log('complete    ', JSON.stringify(done.text), done.model, '| remaining', omazy.last.rateLimit?.remaining)

let streamed = ''
let deltas = 0
for await (const ev of omazy.ai.stream({ messages: [{ role: 'user', content: 'Count from 1 to 5.' }], max_tokens: 30 })) {
  if (ev.type === 'delta') { streamed += ev.text; deltas++ }
  else console.log('stream      ', JSON.stringify(streamed), `${deltas} deltas, done matches: ${ev.result.text === streamed}`)
}

const passages = await omazy.knowledge.search('What does the company do?', { top_k: 2 })
console.log('knowledge   ', passages.length, 'passages, first:', passages[0]?.title)

const tools = await omazy.mcp.listTools()
console.log('mcp tools   ', tools.map((t) => t.name).join(', '))
const viaMcp = await omazy.mcp.callTool('knowledge_search', { query: 'What does the company do?', top_k: 1 })
console.log('mcp call    ', 'isError', viaMcp.isError, '| passages', (viaMcp.data?.passages as unknown[])?.length)

const refused = await omazy.customers.get('00000000-0000-0000-0000-000000000000').catch((e) => e)
console.log('refusal     ', refused.status, refused.code, '|', refused.message)
