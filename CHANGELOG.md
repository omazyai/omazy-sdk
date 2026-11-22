# Changelog

The TypeScript, Python and Go clients share one version number.

## 0.4.0 (2026-11-23)

The Enterprise API: one workspace per customer. Nothing in 0.3.0 changed its name or its shape.

- A second client for a product that serves many customers, each in a workspace of their own: `OmazyEnterprise` in TypeScript and Python, `omazy.NewEnterprise` in Go. It takes an account key (`eak_...`), not an install token.
- Create the workspace of a customer, with its agent, its plan and its install, and get that customer's Core API token once. Your own id for the customer (`external_id`) makes the call safe to repeat: a repeat returns the same workspace and no token, so the client retries it like a read.
- List the account's workspaces page by page or all at once, find one by your own id, read one, rename and rebrand it, suspend and resume it, close it and reopen it.
- Rotate a customer's install token, with the old one kept for an overlap. This is never sent twice by the client.
- `core(token)` (`Core` in Go) gives the Core API client for one customer on the same deployment, so a product picks a customer's token and calls models, knowledge and the agent as that customer.
- An account key never reaches the Core API, and an install token never reaches the Enterprise API.
- The routes are listed in a contract of their own, `contracts/enterprise-api.routes.json`, and each client's tests are held to it.
- An account key is issued by Omazy to a product. There is no self-serve way to get one yet.

The agent's settings, under a new scope `agent:configure`:

- Read how the agent runs and change it from your backend: the model it answers on, the cap on one reply, the temperature, and the loop switches (the shared agent loop, streaming, masking of personal data, `memory`, which gives the agent remember and forget tools, and `files`, which gives it a create_file tool). `agent.settings.get` and `agent.settings.update` in TypeScript and Python, `Agent.Settings` and `Agent.UpdateSettings` in Go.
- A change names only what changes. Null puts a setting back to what the agent inherits: `null` in TypeScript, `None` in Python (an argument left out is `UNSET`), `omazy.Clear` in Go beside `omazy.Set`.
- A new model is tested with one real call before it is saved. `403 MODEL_NOT_AVAILABLE` is a model the plan does not allow; `422 MODEL_NOT_SERVING` is one that did not answer. Nothing changes in either case.
- The same change sent twice leaves the same settings, so the client sends it again after a 429, a gateway error or a dropped connection.
- A token made before this release does not hold `agent:configure`. Scopes are fixed when a token is made, so make a new one.

Live speech to text, on the existing scope `voice:speech`:

- `voice.transcribeStream` in TypeScript, `voice.transcribe_stream` in Python, `Voice.TranscribeStream` in Go: a WebSocket session that hears audio while the person speaks, so the text is ready a few hundred milliseconds after they stop instead of after the whole recording is uploaded and heard.
- Send audio as it is captured (`pcm_s16le`, `mulaw`, `alaw` with a sample rate, or `auto` for WebM/Opus, Ogg or WAV). `commit` after each utterance returns its final; `end` returns every final joined and the audio length it is billed by; `keepalive` holds a quiet session. Frames are `ready`, `partial`, `final` and `done`; an `error` frame arrives as the client's error with its code and request id.
- Voice minutes are counted once per session with a one-minute floor. Hold one session for a conversation and commit per utterance.
- The token goes on the upgrade: run it on your server, and relay from a browser. Zero dependencies: TypeScript uses the runtime's WebSocket (Cloudflare Workers, Node 22 and later, Bun, Deno; `webSocket` to bring another), Python and Go carry a small client of their own.
- `terms` on `voice.transcribe` (trailing arguments in Go): names and words to expect, so "Rashed Karim" is not heard as "Rasht Kareem". At most 200; more is refused, never cut.
- The contract marks a WebSocket route with `websocket`, and each client's tests hold its list to it.

Control over the gateway's response cache on completions:

- `cache_ttl` on `ai.complete` and `ai.stream` (`CacheTTL` in Go): leave it out for the gateway's own setting, `0` for a reply that never comes from the cache, or 60 to 2592000 seconds to bound how long a stored reply may be served again. Send `0` on any request that carries live data.
- `cache_hit` on the result (`CacheHit` in Go) says the reply came from the cache. Such a reply cost nothing and used no AI turn.

Agent turns that stream and take the person's context, on the existing scope `agent:run`:

- `agent.stream` in TypeScript and Python, `Agent.Stream` in Go: the reply arrives in pieces as the agent writes it, then the whole turn. The frames are a streamed completion's. In TypeScript `StreamEvent` takes the result type, `StreamEvent<AgentTurnResult>`; `StreamEvent` alone is still a completion's.
- The agent's markup for quick replies and images is held back from the pieces, so a piece is safe to read aloud. Keep the text of the whole turn.
- When the agent's settings turn streaming off or masking of personal data on, only the whole turn arrives. An agent with connected tools sends its whole reply as one piece for now: its tool loop does not stream a turn made through the Core API yet.
- `context` on a turn (`Context` in Go): one object of at most 2048 bytes about where the person is, read by the agent as a hint, as a widget page's context is. `{"interaction": "voice"}` makes it answer for the ear.
- Nothing changed for `agent.turn`.

The agent's MCP servers, under a new scope `agent:tools`:

- Connect, list, read, change and remove the MCP tool servers the agent may call: `agent.mcpServers` in TypeScript, `agent.mcp_servers` in Python, `Agent.ListMCPServers` and its siblings in Go. For a product with a workspace per customer, this is how each customer's agent gets that customer's tools.
- A server's name is unique within the app, ignoring case. A second one is `409 CONFLICT`.
- The endpoint must be https on a public host, or the call is refused with `400`.
- The credential is write-only. No call returns it.
- Connecting a server takes an idempotency key and is sent again only with one. A change is sent again like a read. A removal is never sent twice.
- `subject_check` on a `session_bearer` server: `whoami` (the default) asks the server whose token it is, `host` takes your backend's word for a server that has no `whoami`, such as Notion's, Slack's or Microsoft 365's. Each conversation stays locked to one person either way. Binding a token now answers `verified` with the one that was used.

Usage and cost, under a new scope `usage:read`:

- `usage.get` in TypeScript and Python, `Usage.Get` in Go: what the workspace used and what it cost, per UTC day, with totals. Model calls, replies from the gateway's response cache (free), tokens, speech sessions and seconds, cost in millionths of a US dollar, and the plan's counters (conversations, AI turns, API calls, voice minutes).
- A range is two days as `YYYY-MM-DD`, both included, at most 90 days; the last 30 days when you name none. It is a read, so the client sends it again after a 429 or a gateway error.
- Text to speech is priced from a list price per character until it is checked against an invoice; that part of the cost is in `estimated_cost_micros`.
- A token made before this release does not hold `usage:read`. A managed workspace's install gets it by default.
- Across an enterprise account: `usage()` on `OmazyEnterprise` (`Usage` in Go) gives a page of the account's workspaces, each with its totals and days, and the account's totals over every workspace. Needs the account scope `usage:read`, which has the same name.

## 0.3.0 (2026-11-20)

Idempotency keys. Nothing in 0.2.0 changed its name or its shape.

- A request that changes something takes an idempotency key: placing a call, posting a message, publishing, running an agent turn, starting a voice job, adding a document, importing a file, adding a source and crawling one. With a key the platform runs the request once and answers a repeat with the first answer, and the client retries the request the way it retries a read. Without a key these are still sent once.
  - TypeScript: a last argument `{ idempotencyKey }`. `agent.turn` takes an `AbortSignal` as before, or `{ signal, idempotencyKey }`.
  - Python: a keyword argument `idempotency_key`.
  - Go: `omazy.WithIdempotencyKey(ctx, key)`.
- A repeat that arrives while the first request is still running (`409 IDEMPOTENCY_IN_PROGRESS`) is waited out and sent again. The same key with a different request (`422 IDEMPOTENCY_KEY_REUSED`) is an error.
- The last response says whether it was a replay: `last.replayed` in TypeScript and Python, `Last().Replayed` in Go.
- `whoami` reports the plan's voice minutes next to its AI turns. Speech, voice jobs and call placement answer `402 PLAN_LIMIT_REACHED` when the minutes are used up.
- The error of a failed stream carries the API's own error code.
- Fixed: a voice job named its app in the request body, where the API did not read it, so a workspace with more than one app always got its default app. The app now goes in the query string.

## 0.2.0 (2026-11-20)

Knowledge documents. Nothing in 0.1.0 changed its name or its shape.

- Read and write the agent's knowledge base: list, read, add, change and delete a document, with how its indexing stands (`queued`, `indexing`, `ready`, `failed`). Reads need `kb:read`, writes `kb:write`.
- Upload a file (PDF, spreadsheet, image or text) as a document.
- List the websites a knowledge base is crawled from, add one, and crawl it again.
- Export what changed in the knowledge base since a version, with the passages search uses, to keep a copy of your own.
- The body of the `kb.updated` event is typed in the TypeScript client (`KnowledgeUpdatedEvent`). Verify it with the signature helper every client already has.
- Knowledge writes are never sent again by a client after a failure. The reads are, as other reads are.
- Fixed: the TypeScript and Go types named a voice job kind `notes`. The API takes `transcribe` and `meeting_notes`.

## 0.1.0 (2026-11-19)

First release.

- Every Core API route over HTTP: completions (whole or streamed), knowledge search, agent turns, speech, outbound calls, voice jobs, customers, conversation messages, page publishing and session credentials.
- The Core API's MCP server: list tools, call a tool, or get the URL and headers for another MCP client.
- One error type with the status, the stable code, the message and the request id.
- Retries on 429, 502, 503, 504 and dropped connections, only for routes that are safe to send twice.
- The request id, the rate limit and the token's deadline readable after each call.
- `whoami` reports the workspace's plan: its rate per minute and the AI turns used and included.
- Signature verification for requests the platform sends to your server.
- TypeScript only: `@omazyai/sdk/server` with the flow and context request shapes, block builders and an MCP tool server for a Worker.
