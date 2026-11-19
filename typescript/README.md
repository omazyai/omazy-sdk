# @omazyai/sdk

TypeScript client for the [Omazy Core API](https://docs.omazy.ai/reference/core-api/). No dependencies. Runs on Node 18+, Bun, Deno and Cloudflare Workers.

## Install

The package is on GitHub Packages. Add this to `.npmrc`, with a GitHub token that can read packages:

```sh
@omazyai:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```sh
npm install @omazyai/sdk
```

Without a GitHub token, install the same build from the release:

```sh
npm install https://github.com/omazyai/omazy-sdk/releases/download/v0.2.0/omazyai-sdk-0.2.0.tgz
```

## Use

```ts
import { Omazy } from '@omazyai/sdk'

const omazy = new Omazy({ token: process.env.OMAZY_CORE_TOKEN! })

const answer = await omazy.ai.complete({
  system: 'You answer in one sentence.',
  messages: [{ role: 'user', content: 'What is a webhook?' }],
})
console.log(answer.text)
```

The token is a Core API token (`cai_...`). A workspace owner creates it and chooses its scopes: see [Core API authentication](https://docs.omazy.ai/reference/core-api/authentication/). Keep it on a server. Never ship it to a browser or a phone.

`await omazy.whoami()` says what a token is: its scopes, when it expires, and the workspace's plan with the rate per minute and the AI turns used and included.

## Calls

| Method | Scope |
|---|---|
| `whoami()` | none |
| `ai.complete(req)`, `ai.stream(req)` | `ai:complete` |
| `knowledge.search(query, opts)` | `kb:search` |
| `knowledge.documents.list(opts)`, `knowledge.documents.get(id)`, `knowledge.sources.list()`, `knowledge.export(opts)` | `kb:read` |
| `knowledge.documents.create(doc)`, `.update(id, patch)`, `.delete(id)`, `knowledge.importFile(file, opts)`, `knowledge.sources.create(req)`, `.crawl(id)` | `kb:write` |
| `agent.turn(req)` | `agent:run` |
| `voice.speak(text, opts)`, `voice.transcribe(audio, opts)` | `voice:speech` |
| `voice.calls.place(req)`, `voice.calls.get(ref)` | `voice:calls` |
| `voice.jobs.create(req)`, `voice.jobs.get(id)` | `voice:tasks` |
| `customers.get(id)` | `core:read` |
| `customers.update(id, fields)` | `memory:write` |
| `conversations.postMessage(id, blocks)` | `core:write` |
| `channels.linkedinPublish(req)` | `channels:publish` |
| `sessions.bindCredential(...)`, `sessions.unbindCredential(...)` | `sessions:credentials` |
| `mcp.listTools()`, `mcp.callTool(name, args)`, `mcp.config()` | the tool's own scope |

## Writing knowledge

A document is indexed in the background. `index.status` goes from `queued` to `ready`, or to `failed` with a reason.

```ts
const doc = await omazy.knowledge.documents.create({ title: 'Opening hours', content: 'Open 9 to 5, Sunday to Thursday.' })
const file = await omazy.knowledge.importFile(pdfBytes, { filename: 'handbook.pdf', contentType: 'application/pdf' })

const { index } = await omazy.knowledge.documents.get(doc.id) // index.status
```

To keep your own copy of the knowledge base, export everything once, then only what changed:

```ts
let cursor: string | undefined
let version = 0
do {
  const page = await omazy.knowledge.export({ since: saved, cursor })
  for (const d of page.documents) d.is_active ? store(d) : drop(d.id)
  for (const d of page.deleted) drop(d.id)
  version = page.version
  cursor = page.next_cursor || undefined
} while (cursor)
saved = version // pass it as since next time; leave since out the first time
```

## Streaming

```ts
for await (const ev of omazy.ai.stream({ messages })) {
  if (ev.type === 'delta') process.stdout.write(ev.text)
  else console.log('\n', ev.result.usage)
}
```

## Errors

```ts
import { OmazyError } from '@omazyai/sdk'

try {
  await omazy.agent.turn({ message: 'hello' })
} catch (e) {
  if (e instanceof OmazyError && (e.code === 'PLAN_LIMIT_REACHED' || e.code === 'PAYMENT_REQUIRED')) {
    // the plan's AI turns or a spend budget are used up: stop calling and tell the workspace's owner
  }
  throw e
}
```

`e.status`, `e.code`, `e.message`, `e.requestId` and `e.retryAfter` are set from the response. After any call, `omazy.last` holds the request id, the rate limit and the token's deadline.

## MCP

```ts
const tools = await omazy.mcp.listTools()
const hit = await omazy.mcp.callTool('knowledge_search', { query: 'opening hours' })

// or hand the server to an MCP client of your own
const server = omazy.mcp.config() // { type: 'http', url, headers }
```

## On your own server

`@omazyai/sdk/server` is for the requests the platform sends to you.

```ts
import { readSigned, reply, text, type FlowRequest } from '@omazyai/sdk/server'

const signed = await readSigned<FlowRequest>(request, env.OMAZY_HMAC_SECRET)
if (!signed.ok) return new Response(null, { status: signed.status })
return reply({ blocks: [text('Booked.')], state: null, done: true })
```

It also has `serveMcp`, an MCP tool server for a Worker, so an agent can call your tools.

## Develop

```sh
npm install
npm run check                                   # type-check and tests
OMAZY_CORE_TOKEN=cai_... bun examples/smoke.ts  # against a real deployment
```

## Author and license

Written and maintained by Mosthofa Imran. MIT license.
