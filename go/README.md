# omazy (Go)

Go client for the [Omazy Core API](https://docs.omazy.ai/reference/core-api/). Standard library only. Go 1.22+.

## Install

```sh
go get github.com/omazyai/omazy-sdk/go@v0.4.0
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
| `c.Agent.Turn`, `c.Agent.Stream` | `agent:run` |
| `c.Agent.Settings`, `c.Agent.UpdateSettings` | `agent:configure` |
| `c.Agent.ListMCPServers`, `GetMCPServer`, `CreateMCPServer`, `UpdateMCPServer`, `DeleteMCPServer` | `agent:tools` |
| `c.Voice.Speak`, `c.Voice.Transcribe`, `c.Voice.TranscribeStream` | `voice:speech` |
| `c.Voice.PlaceCall`, `c.Voice.GetCall` | `voice:calls` |
| `c.Voice.CreateJob`, `c.Voice.GetJob` | `voice:tasks` |
| `c.Customers.Get` | `core:read` |
| `c.Customers.Update` | `memory:write` |
| `c.Conversations.PostMessage` | `core:write` |
| `c.Channels.LinkedInPublish` | `channels:publish` |
| `c.Sessions.BindCredential`, `c.Sessions.UnbindCredential` | `sessions:credentials` |
| `c.MCP.ListTools`, `c.MCP.CallTool`, `c.MCP.Config` | the tool's own scope |

## The agent's settings

Read and change how the agent runs: its model, the cap on a reply, the temperature and the loop switches.

```go
settings, err := c.Agent.Settings(ctx, "")
// settings.Model.ID, settings.Models (what the plan allows)

_, err = c.Agent.UpdateSettings(ctx, omazy.AgentSettingsUpdate{
	Model:     omazy.Set("openai/gpt-4o"),
	MaxTokens: omazy.Set(1200),
})
_, err = c.Agent.UpdateSettings(ctx, omazy.AgentSettingsUpdate{
	Loop: &omazy.AgentLoopUpdate{Stream: omazy.Set(true), Redact: omazy.Clear[bool]()}, // Clear: back to the default
})
_, err = c.Agent.UpdateSettings(ctx, omazy.AgentSettingsUpdate{Model: omazy.Clear[string]()}) // back to the inherited model
```

A nil field is left as it is. `Clear` puts it back to what the agent inherits. A new model is tested with one real call before it is saved, so allow up to 90 seconds: `MODEL_NOT_AVAILABLE` is a model off the plan, `MODEL_NOT_SERVING` one that did not answer, and in both cases nothing changes. Setting `MaxTokens` or `Temperature` on an agent that inherits its model pins it to the model it runs on now.

## The agent's MCP servers

Connect the tool servers the agent may call. This is the other direction from `c.MCP`, which is Omazy as an MCP server for your own agent.

```go
server, err := c.Agent.CreateMCPServer(omazy.WithIdempotencyKey(ctx, "front-desk-"+tenantID), omazy.MCPServerInput{
	Name: "front-desk", EndpointURL: "https://tools.example.com/mcp", AuthType: "bearer", Credentials: token,
})

_, err = c.Agent.UpdateMCPServer(ctx, server.ID, omazy.MCPServerUpdate{Credentials: &newToken}) // rotate
off := false
_, err = c.Agent.UpdateMCPServer(ctx, server.ID, omazy.MCPServerUpdate{IsActive: &off}) // keep it, stop calling it
err = c.Agent.DeleteMCPServer(ctx, server.ID, "")
```

The agent offers the server's tools to the model from its next turn, as `mcp_<name>__<tool>`. A name is unique within the app: a second server with it is `409 CONFLICT`. The endpoint must be https on a public host. The credential is stored encrypted and never returned; `HasCredentials` says whether one is stored. `WriteMode` defaults to `confirm`: the visitor agrees on a card before a tool that changes data runs.

## Streaming

```go
res, err := c.AI.Stream(ctx, req, func(text string) { fmt.Print(text) })
```

`res` is the full result once the stream is done.

An agent turn streams the same way, and `Context` tells the agent where the person is:

```go
turn, err := c.Agent.Stream(ctx, omazy.AgentTurnRequest{
	Message: "Is my meeting today?",
	Context: map[string]any{"interaction": "voice"},
}, speak)
```

The agent's own reply markup (quick replies, images) is held back from the pieces. Keep the text of the whole turn at the end: it is the one the agent finished with. When the agent's settings turn streaming off or masking of personal data on, only the whole turn arrives. An agent with connected tools sends its whole reply as one piece for now. A streamed turn is not retried, and an idempotency key does not replay it.

## Live speech to text

```go
s, err := c.Voice.TranscribeStream(ctx, omazy.TranscribeStreamOptions{
	Language: "bn", Terms: []string{"Rashed Karim"}, AudioFormat: "pcm_s16le", SampleRate: 16000})
for chunk := range micWhileHeld { s.Send(chunk) }
fin, err := s.Commit(ctx) // the button is let go
done, err := s.End(ctx)   // the conversation is over
```

Open the session when the person starts speaking, or once for a whole conversation, and send audio as it is captured. The vendor session opens while they speak, so the text is ready a few hundred milliseconds after they stop. `commit` after each utterance (a hold-to-talk button let go) returns its final, whose text may be empty; `end` finishes the session and returns every final joined with the audio length it is billed by. Voice minutes are counted once per session, rounded up with a one-minute floor, so hold one session for a conversation rather than one per utterance, and send `keepalive` between utterances: a session silent for 60 seconds is closed. `terms` (at most 200) are names and words to expect; `transcribe` takes them too. The token goes on the upgrade, so this runs on your server: a browser streams to your backend, which relays. A session is never retried. An `error` frame arrives as an error with its `code` and request id. `ctx` bounds the whole session. `Events()` carries every frame for watching; it drops frames when 256 wait unread, and `Commit` and `End` get their answers either way. `Transcribe` takes terms as trailing arguments.

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

## One workspace per customer

For a product that serves many customers. `NewEnterprise` takes an account key (`eak_...`) and creates and runs a workspace for each customer. `Core(token)` is the client for one of them.

```go
account := omazy.NewEnterprise(os.Getenv("OMAZY_ACCOUNT_KEY"))

made, err := account.CreateWorkspace(ctx, omazy.CreateWorkspaceRequest{ExternalID: "cust_42", Name: "Acme Bank"})
if err != nil {
	return err
}
if made.Token != "" {
	saveTokenFor("cust_42", made.Token) // shown once, on the call that minted it
}

acme := account.Core(tokenFor("cust_42"))
_, err = acme.Knowledge.CreateDocument(ctx, omazy.DocumentInput{Title: "Opening hours", Content: "9 to 5"})
```

| Method | Does | Scope |
|---|---|---|
| `Account` | The account, its limits, how many workspaces it manages, and the key | none |
| `CreateWorkspace` | The customer's workspace, agent, plan and install. Safe to repeat by `ExternalID` | `workspaces:manage` (the install needs `installs:manage` too) |
| `ListWorkspaces`, `AllWorkspaces` | One page, or every workspace page by page | `workspaces:manage` |
| `GetWorkspace`, `FindWorkspaceByExternalID` | One workspace, by its id or by your own | `workspaces:manage` |
| `UpdateWorkspace`, `SuspendWorkspace`, `ResumeWorkspace` | Name, brand and status. Resume also reopens a closed workspace | `workspaces:manage` |
| `CloseWorkspace` | Closes it. Nothing is erased | `workspaces:manage` |
| `RotateInstall` | A new install token, the old one kept for the overlap | `installs:manage` |
| `Core(token, options...)` | The `*Client` for one customer | the customer's token |

Refusals to branch on, in `(*omazy.Error).Code`: `HANDLE_TAKEN` (the message lists free handles), `WORKSPACE_LIMIT_REACHED`, `WORKSPACE_CLOSED` (reopen it with `ResumeWorkspace`), `ACCOUNT_SUSPENDED`. Every call except `RotateInstall` is sent again after a 429, a gateway error or a dropped connection.

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
