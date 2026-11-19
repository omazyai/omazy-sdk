# Changelog

The TypeScript, Python and Go clients share one version number.

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
