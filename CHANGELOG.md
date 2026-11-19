# Changelog

The TypeScript, Python and Go clients share one version number.

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
