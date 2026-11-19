# omazy (Go)

Go client for the [Omazy Core API](https://docs.omazy.ai/reference/core-api/). Standard library only. Go 1.22+.

## Install

```sh
go get github.com/omazyai/omazy-sdk/go@v0.3.0
```

```go
import omazy "github.com/omazyai/omazy-sdk/go"
```

## Use

```go
c := omazy.New(os.Getenv("OMAZY_CORE_TOKEN"))

res, err := c.AI.Complete(ctx, omazy.CompleteRequest{
	System:   "You answer in one sentence.",
	Messages: []omazy.Message{{Role: "user", Content: "What is a webhook?"}},
})
if err != nil {
	return err
}
fmt.Println(res.Text)
```

The token is a Core API token (`cai_...`). A workspace owner creates it and chooses its scopes: see [Core API authentication](https://docs.omazy.ai/reference/core-api/authentication/). Keep it on a server.

`c.Whoami(ctx)` says what a token is: its scopes, when it expires, and the workspace's plan with the rate per minute and the AI turns used and included.

## Calls

| Method | Scope |
|---|---|
| `c.Whoami` | none |
| `c.AI.Complete`, `c.AI.Stream` | `ai:complete` |
| `c.Knowledge.Search` | `kb:search` |
| `c.Knowledge.ListDocuments`, `GetDocument`, `ListSources`, `Export` | `kb:read` |
| `c.Knowledge.CreateDocument`, `UpdateDocument`, `DeleteDocument`, `ImportFile`, `CreateSource`, `CrawlSource` | `kb:write` |
| `c.Agent.Turn` | `agent:run` |
| `c.Voice.Speak`, `c.Voice.Transcribe` | `voice:speech` |
| `c.Voice.PlaceCall`, `c.Voice.GetCall` | `voice:calls` |
| `c.Voice.CreateJob`, `c.Voice.GetJob` | `voice:tasks` |
| `c.Customers.Get` | `core:read` |
| `c.Customers.Update` | `memory:write` |
| `c.Conversations.PostMessage` | `core:write` |
| `c.Channels.LinkedInPublish` | `channels:publish` |
| `c.Sessions.BindCredential`, `c.Sessions.UnbindCredential` | `sessions:credentials` |
| `c.MCP.ListTools`, `c.MCP.CallTool`, `c.MCP.Config` | the tool's own scope |

## Streaming

```go
res, err := c.AI.Stream(ctx, req, func(text string) { fmt.Print(text) })
```

`res` is the full result once the stream is done.

## Sending a request again

A read is retried for you. A request that changes something is not: placing a call, posting a message, publishing, running an agent turn and adding knowledge are sent once. Give one a key and it becomes safe to repeat. The platform runs it once and answers a repeat with the first answer, so the client retries it like a read.

```go
ctx := omazy.WithIdempotencyKey(ctx, orderID) // or a new UUID, kept with the order

res, err := c.Voice.PlaceCall(ctx, omazy.CallRequest{
	To: "+447700900123", Purpose: "confirmation", ConsentBasis: "transaction",
	Opening: "Hello, this is Nordwell.",
})
```

Use a new key for each new request, and the same key when you send one again, also from another process or after a restart. A successful answer is remembered for 24 hours. A failed request is not remembered. The same key with a different request is refused with `IDEMPOTENCY_KEY_REUSED`. `c.Last().Replayed` is true when the answer was a remembered one.

The calls that read the key: `Knowledge.CreateDocument`, `Knowledge.ImportFile`, `Knowledge.CreateSource`, `Knowledge.CrawlSource`, `Agent.Turn`, `Voice.PlaceCall`, `Voice.CreateJob`, `Conversations.PostMessage` and `Channels.LinkedInPublish`. On any other call a key on the context is ignored.

## Errors

```go
var e *omazy.Error
if errors.As(err, &e) && (e.Code == "PLAN_LIMIT_REACHED" || e.Code == "PAYMENT_REQUIRED") {
	// the plan's AI turns or a spend budget are used up: stop calling and tell the workspace's owner
}
```

`Status`, `Code`, `Message`, `RequestID` and `RetryAfter` are set from the response. After any call, `c.Last()` holds the request id, the rate limit and the token's deadline.

## Requests the platform sends to you

```go
if !omazy.VerifySignature(secret, rawBody, r.Header.Get("X-Omazy-Signature")) {
	http.Error(w, "unauthorized", http.StatusUnauthorized)
	return
}
```

## Develop

```sh
go test ./...
OMAZY_CORE_TOKEN=cai_... go run ./examples/smoke   # against a real deployment
```

## Author and license

Written and maintained by Mosthofa Imran. MIT license.
