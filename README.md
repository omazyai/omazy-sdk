# Omazy SDKs

Clients for the [Omazy Core API](https://docs.omazy.ai/reference/core-api/): models, your knowledge base, your agent, speech and phone calls, called from your own backend with one scoped token.

| SDK | Folder | Runs on | Dependencies |
|---|---|---|---|
| TypeScript | [`typescript/`](typescript/) | Node 20+, Bun, Deno, Cloudflare Workers | none |
| Python | [`python/`](python/) | Python 3.9+ | none (standard library) |
| Go | [`go/`](go/) | Go 1.22+ | none (standard library) |

The three clients cover the same routes under the same names, over HTTP and over the Core API's MCP server.

To start a new AI product on the TypeScript kits, [`create-omazy-app/`](create-omazy-app/) writes a Cloudflare Worker with capabilities, the guard and an MCP door, pinned to the SDK of the same version: `npm create omazy-app@latest my-product`.

## Install

**TypeScript.** The package is `@omazyai/sdk` on GitHub Packages.

```sh
# .npmrc, with a GitHub token that can read packages
@omazyai:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```sh
npm install @omazyai/sdk
```

Without a GitHub token, install the same build from the release:

```sh
npm install https://github.com/omazyai/omazy-sdk/releases/download/v0.5.1/omazyai-sdk-0.5.1.tgz
```

**Python.**

```sh
pip install https://github.com/omazyai/omazy-sdk/releases/download/v0.5.1/omazy-0.5.1-py3-none-any.whl
```

**Go.**

```sh
go get github.com/omazyai/omazy-sdk/go@v0.5.1
```

## Your account and your token

Every call is made as one Omazy workspace. You need two things.

1. **A workspace.** Sign in at [workspace.omazy.ai](https://workspace.omazy.ai). Every plan can use the Core API, the free plan included.
2. **A token.** A workspace owner creates it, signed in to the console API, and chooses what it may do:

```sh
curl -X POST https://mw.omazy.ai/api/v1/workspace/$HANDLE/installs \
  -H "Authorization: Bearer $OWNER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"app_slug":"backoffice","scopes":["ai:complete","kb:search"],"expires_in_days":90}'
```

The answer holds the token once, as `cai_<prefix>.<rest>`. Omazy keeps only a hash of it. The same API lists, rotates and revokes tokens. The full reference is [Core API authentication](https://docs.omazy.ai/reference/core-api/authentication/).

Keep the token on a server, in an environment variable or a secrets manager. Never ship it in a browser bundle or a mobile app.

To see what a token is, ask:

```ts
const me = await omazy.whoami()
// me.scopes            what the token may do
// me.token_expires_at  when it stops working
// me.plan              the workspace's plan, its rate per minute, and the AI turns and voice minutes used and included
```

## First call

```ts
import { Omazy } from '@omazyai/sdk'

const omazy = new Omazy({ token: process.env.OMAZY_CORE_TOKEN! })
const answer = await omazy.ai.complete({
  messages: [{ role: 'user', content: 'What is a webhook?' }],
})
console.log(answer.text)
```

```python
import os
from omazy import Omazy

omazy = Omazy(os.environ["OMAZY_CORE_TOKEN"])
answer = omazy.ai.complete([{"role": "user", "content": "What is a webhook?"}])
print(answer["text"])
```

```go
c := omazy.New(os.Getenv("OMAZY_CORE_TOKEN"))
res, err := c.AI.Complete(ctx, omazy.CompleteRequest{
	Messages: []omazy.Message{{Role: "user", Content: "What is a webhook?"}},
})
```

Each folder's README lists every method and the scope it needs.

## What every client does

- **Errors.** A refusal is one error type carrying the HTTP status, a stable `code`, the message and the request id.
- **Retries.** A 429, 502, 503, 504 or a dropped connection is retried twice, only on routes that read or compute. Placing a call, posting a message, publishing, running an agent turn and adding knowledge are never sent twice on the client's own decision. A `Retry-After` over 30 seconds is handed back to the caller.
- **Idempotency keys.** Give a request that changes something a key and it becomes safe to send again: the platform runs it once and answers a repeat with the first answer. With a key the client retries it like a read.
- **Streaming.** A completion can be read as it is written. A stream that reports an error or stops before it is done is an error, never a short answer.
- **Response headers.** The request id, the rate limit, the token's deadline and whether the answer was a replay are readable after each call.
- **MCP.** List and call the tools the token's scopes allow, or get the URL and headers to hand to another MCP client.
- **Signatures.** Verify a request the platform sent to your server (`X-Omazy-Signature`). All three test against the same vector.

The TypeScript package also has what your own Worker needs (`@omazyai/sdk/server`): the flow and context request shapes, block builders and an MCP tool server.

`@omazyai/sdk/capabilities` (experimental, TypeScript only) defines each action your product offers once and generates its MCP tools, model tools, forms and tools changelog from that one definition.

## Plans and limits

The workspace's plan decides how much a token may do. Three numbers matter, and `whoami` reports them.

- **Rate.** Each token has a number of calls per 10 minutes in each bucket, sized by the plan. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. Past it the API answers `429`.
- **AI turns.** A completion or an agent turn uses one AI turn from the plan's allowance for the period. When the allowance is used up the API answers `402 PLAN_LIMIT_REACHED` until the period resets or the plan changes.
- **Voice minutes.** Speech, voice jobs and phone calls draw on the plan's voice minutes, and stop with the same `402 PLAN_LIMIT_REACHED` when they are used up.

Details: [Errors and limits](https://docs.omazy.ai/reference/core-api/errors-and-limits/).

## One workspace per customer

A product that serves many customers gives each of them a workspace of their own: their knowledge, their agent, their conversations and their usage, apart from every other customer's. The Enterprise API creates and runs those workspaces, and each client has a second entry point for it.

| | Core API | Enterprise API |
|---|---|---|
| Key | An install token, `cai_...`, one per workspace | An account key, `eak_...`, one per product |
| Does | Models, knowledge, the agent, speech and calls of one workspace | Creates, lists, suspends and closes workspaces, and rotates their install tokens |
| Client | `Omazy` | `OmazyEnterprise` (`NewEnterprise` in Go) |

```ts
import { OmazyEnterprise } from '@omazyai/sdk'

const account = new OmazyEnterprise({ token: process.env.OMAZY_ACCOUNT_KEY! })

// Once per customer. Safe to repeat: your own id names the workspace.
const { workspace, token } = await account.workspaces.create({ external_id: 'cust_42', name: 'Acme Bank' })
if (token) await saveTokenFor('cust_42', token) // shown once

// From then on, work as that customer.
const acme = account.core(await tokenFor('cust_42'))
await acme.knowledge.documents.create({ title: 'Opening hours', content: '9 to 5, Sunday to Thursday.' })
const { text } = await acme.agent.turn({ message: 'When are you open?' })
```

Things to know:

- **The token is shown once.** `create` returns the customer's install token on the call that made it and never again. Store it then. If it is lost, `rotateInstall` gives a new one.
- **An account key cannot call a model.** It manages workspaces. Each customer's own token does the work, so usage and limits are counted per customer.
- **Suspending takes up to 30 seconds** to reach the Core API. Closing a workspace erases nothing; `resume` reopens it.
- **An account key is issued by Omazy** to a product. There is no self-serve way to get one yet.

## One contract

[`contracts/core-api.routes.json`](contracts/core-api.routes.json) lists every Core API route with its scope, its SDK method and its MCP tool, and [`contracts/enterprise-api.routes.json`](contracts/enterprise-api.routes.json) does the same for the Enterprise API. The API's own tests and each SDK's tests are held to them, so a client cannot drift from the API it calls.

```sh
cd typescript && npm install && npm run check
cd python && python3 -m unittest discover -s tests
cd go && go test ./...
```

Each folder has `examples/smoke` to check a real workspace with a token.

## Versions

The three clients share one version number. Changes are in [CHANGELOG.md](CHANGELOG.md), and changes to the API itself are in the [Core API changelog](https://docs.omazy.ai/reference/core-api/changelog/).

## Author and license

Written and maintained by Mosthofa Imran. MIT license, see [LICENSE](LICENSE).
