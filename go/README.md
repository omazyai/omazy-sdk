# omazy (Go)

Go client for the [Omazy Core API](https://docs.omazy.ai/reference/core-api/). Standard library only. Go 1.22+.

## Install

```sh
go get github.com/omazyai/omazy-sdk/go@v0.1.0
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
