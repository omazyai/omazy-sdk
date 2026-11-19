# Changelog

The TypeScript, Python and Go clients share one version number.

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
