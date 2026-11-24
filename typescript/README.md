# @omazyai/sdk

TypeScript client for the [Omazy Core API](https://docs.omazy.ai/reference/core-api/). No dependencies. Runs on Node 20+, Bun, Deno and Cloudflare Workers.

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
npm install https://github.com/omazyai/omazy-sdk/releases/download/v0.5.3/omazyai-sdk-0.5.3.tgz
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
| `agent.turn(req)`, `agent.stream(req)` | `agent:run` |
| `agent.settings.get(opts)`, `agent.settings.update(change)` | `agent:configure` |
| `agent.mcpServers.list()`, `.get(id)`, `.create(server)`, `.update(id, change)`, `.delete(id)` | `agent:tools` |
| `voice.speak(text, opts)`, `voice.transcribe(audio, opts)`, `voice.transcribeStream(opts)` | `voice:speech` |
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

## The agent's settings

Read and change how the agent runs: its model, the cap on a reply, the temperature and the loop switches.

```ts
const settings = await omazy.agent.settings.get()
settings.model.id          // 'openai/gpt-4o-mini'
settings.models            // what the plan allows

await omazy.agent.settings.update({ model: 'openai/gpt-4o', max_tokens: 1200 })
await omazy.agent.settings.update({ loop: { stream: true, redact: null } }) // null: back to the default
await omazy.agent.settings.update({ model: null })                          // back to the inherited model
```

A field left out is left as it is. `null` puts it back to what the agent inherits. A new model is tested with one real call before it is saved, so allow up to 90 seconds: `MODEL_NOT_AVAILABLE` is a model off the plan, `MODEL_NOT_SERVING` one that did not answer, and in both cases nothing changes. Setting `max_tokens` or `temperature` on an agent that inherits its model pins it to the model it runs on now.

## The agent's MCP servers

Connect the tool servers the agent may call. This is the other direction from `omazy.mcp`, which is Omazy as an MCP server for your own agent.

```ts
const server = await omazy.agent.mcpServers.create(
  { name: 'front-desk', endpoint_url: 'https://tools.example.com/mcp', auth_type: 'bearer', credentials: token },
  { idempotencyKey: `front-desk-${tenantId}` },
)

await omazy.agent.mcpServers.update(server.id, { credentials: newToken }) // rotate
await omazy.agent.mcpServers.update(server.id, { is_active: false })      // keep it, stop calling it
await omazy.agent.mcpServers.delete(server.id)
```

The agent offers the server's tools to the model from its next turn, as `mcp_<name>__<tool>`. A name is unique within the app: a second server with it is `409 CONFLICT`. The endpoint must be https on a public host. The credential is stored encrypted and never returned; `has_credentials` says whether one is stored. `write_mode` defaults to `confirm`: the visitor agrees on a card before a tool that changes data runs.

## Streaming

```ts
for await (const ev of omazy.ai.stream({ messages })) {
  if (ev.type === 'delta') process.stdout.write(ev.text)
  else console.log('\n', ev.result.usage)
}
```

An agent turn streams the same way, and `context` tells the agent where the person is:

```ts
for await (const ev of omazy.agent.stream({ message: 'Is my meeting today?', context: { interaction: 'voice' } })) {
  if (ev.type === 'delta') speak(ev.text)
  else history.push({ role: 'assistant', text: ev.result.text })
}
```

The agent's own reply markup (quick replies, images) is held back from the pieces. Keep the text of the whole turn at the end: it is the one the agent finished with. When the agent's settings turn streaming off or masking of personal data on, only the whole turn arrives. An agent with connected tools sends its whole reply as one piece for now. A streamed turn is not retried, and an idempotency key does not replay it.

## Live speech to text

```ts
const s = await omazy.voice.transcribeStream({ language: 'bn', terms: ['Rashed Karim'], audioFormat: 'pcm_s16le', sampleRate: 16000 })
mic.on('data', (chunk) => s.send(chunk))         // while the button is held
const { text } = await s.commit()                 // the button is let go
const done = await s.end()                        // the conversation is over
```

Open the session when the person starts speaking, or once for a whole conversation, and send audio as it is captured. The vendor session opens while they speak, so the text is ready a few hundred milliseconds after they stop. `commit` after each utterance (a hold-to-talk button let go) returns its final, whose text may be empty; `end` finishes the session and returns every final joined with the audio length it is billed by. Voice minutes are counted once per session, rounded up with a one-minute floor, so hold one session for a conversation rather than one per utterance, and send `keepalive` between utterances: a session silent for 60 seconds is closed. `terms` (at most 200) are names and words to expect; `transcribe` takes them too. The token goes on the upgrade, so this runs on your server: a browser streams to your backend, which relays. A session is never retried. An `error` frame arrives as an error with its `code` and request id. Watch every frame with `onEvent` or `for await (const ev of s.events())`. The default socket works in a Cloudflare Worker, Node 22 and later, Bun and Deno; pass `webSocket` to `new Omazy` for another runtime.

## Sending a request again

A read is retried for you. A request that changes something is not: placing a call, posting a message, publishing, running an agent turn and adding knowledge are sent once. Give one a key and it becomes safe to repeat. The platform runs it once and answers a repeat with the first answer, so the client retries it like a read.

```ts
const key = crypto.randomUUID() // keep it with the order, the visit, the job

await omazy.voice.calls.place(
  { to: '+447700900123', purpose: 'confirmation', consent_basis: 'transaction', opening: 'Hello, this is Nordwell.' },
  { idempotencyKey: key },
)
```

Use a new key for each new request, and the same key when you send one again, also from another process or after a restart. A successful answer is remembered for 24 hours. A failed request is not remembered. The same key with a different request is refused with `IDEMPOTENCY_KEY_REUSED`. `omazy.last.replayed` is true when the answer was a remembered one.

The methods that take a key: `knowledge.documents.create`, `knowledge.importFile`, `knowledge.sources.create`, `knowledge.sources.crawl`, `agent.turn`, `voice.calls.place`, `voice.jobs.create`, `conversations.postMessage` and `channels.linkedinPublish`.

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

`e.status`, `e.code`, `e.message`, `e.requestId` and `e.retryAfter` are set from the response. `omazy.withResponse((o) => o.ai.complete(req))` resolves with `{ result, response }`: `response` holds the request id, the rate limit and the token's deadline of that call alone. `omazy.last` holds the same for the client's most recent response, whichever call it answered, so in a Worker or a server that runs requests at once it can belong to another request. Read it only where one call runs at a time.

## MCP

```ts
const tools = await omazy.mcp.listTools()
const hit = await omazy.mcp.callTool('knowledge_search', { query: 'opening hours' })

// or hand the server to an MCP client of your own
const server = omazy.mcp.config() // { type: 'http', url, headers }
```

## One workspace per customer

For a product that serves many customers. `OmazyEnterprise` takes an account key (`eak_...`) and creates and runs a workspace for each customer. `core(token)` is the client for one of them.

```ts
import { OmazyEnterprise } from '@omazyai/sdk'

const account = new OmazyEnterprise({ token: process.env.OMAZY_ACCOUNT_KEY! })

const made = await account.workspaces.create({ external_id: 'cust_42', name: 'Acme Bank' })
if (made.token) await saveTokenFor('cust_42', made.token) // shown once, on the call that minted it

const acme = account.core(await tokenFor('cust_42'))
await acme.knowledge.documents.create({ title: 'Opening hours', content: '9 to 5' })
```

| Method | Does | Scope |
|---|---|---|
| `account()` | The account, its limits, how many workspaces it manages, and the key | none |
| `workspaces.create(req)` | The customer's workspace, agent, plan and install. Safe to repeat by `external_id` | `workspaces:manage` (the install needs `installs:manage` too) |
| `workspaces.list(query)`, `workspaces.all(query)` | One page, or every workspace page by page | `workspaces:manage` |
| `workspaces.get(id)`, `workspaces.findByExternalId(id)` | One workspace, by its id or by your own | `workspaces:manage` |
| `workspaces.update(id, req)`, `suspend(id)`, `resume(id)` | Name, brand and status. `resume` also reopens a closed workspace | `workspaces:manage` |
| `workspaces.close(id)` | Closes it. Nothing is erased | `workspaces:manage` |
| `workspaces.rotateInstall(id, req)` | A new install token, the old one kept for `overlap_hours` | `installs:manage` |
| `core(token, options)` | The `Omazy` client for one customer | the customer's token |

Refusals to branch on: `HANDLE_TAKEN` (the message lists free handles), `WORKSPACE_LIMIT_REACHED`, `WORKSPACE_CLOSED` (reopen it with `resume`), `ACCOUNT_SUSPENDED`. Every call except `rotateInstall` is sent again after a 429, a gateway error or a dropped connection.

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
