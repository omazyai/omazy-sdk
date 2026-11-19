package omazy

// route is one Core API route: its method and its path under the base URL.
type route struct{ method, path string }

// Routes is every Core API route this client covers, keyed by the name the
// contract gives it (contracts/core-api.routes.json). The client builds each
// request from this table and nowhere else, and the tests hold the table to
// the contract: a route added to the platform and not here fails them.
var routes = map[string]route{
	"whoami":                     {"GET", "/whoami"},
	"ai.complete":                {"POST", "/ai/complete"},
	"knowledge.search":           {"POST", "/knowledge/search"},
	"knowledge.documents.list":   {"GET", "/knowledge/documents"},
	"knowledge.documents.create": {"POST", "/knowledge/documents"},
	"knowledge.documents.get":    {"GET", "/knowledge/documents/{id}"},
	"knowledge.documents.update": {"PATCH", "/knowledge/documents/{id}"},
	"knowledge.documents.delete": {"DELETE", "/knowledge/documents/{id}"},
	"knowledge.import_file":      {"POST", "/knowledge/import"},
	"knowledge.sources.list":     {"GET", "/knowledge/sources"},
	"knowledge.sources.create":   {"POST", "/knowledge/sources"},
	"knowledge.sources.crawl":    {"POST", "/knowledge/sources/{id}/crawl"},
	"knowledge.export":           {"GET", "/knowledge/export"},
	"agent.turn":                 {"POST", "/agent/turn"},
	"voice.speak":                {"POST", "/voice/speak"},
	"voice.transcribe":           {"POST", "/voice/transcribe"},
	"voice.calls.place":          {"POST", "/voice/calls"},
	"voice.calls.get":            {"GET", "/voice/calls/{ref}"},
	"voice.jobs.create":          {"POST", "/voice/jobs"},
	"voice.jobs.get":             {"GET", "/voice/jobs/{id}"},
	"customers.get":              {"GET", "/customers/{id}"},
	"customers.update":           {"PATCH", "/customers/{id}"},
	"conversations.post_message": {"POST", "/conversations/{id}/messages"},
	"channels.linkedin_publish":  {"POST", "/channels/linkedin/publish"},
	"sessions.bind_credential":   {"PUT", "/sessions/{sid}/mcp-credentials/{server}"},
	"sessions.unbind_credential": {"DELETE", "/sessions/{sid}/mcp-credentials/{server}"},
	"mcp":                        {"POST", "/mcp"},
}

// retryable lists the routes that are safe to send again after a 429, a
// gateway error or a dropped connection: they read, or they compute an answer
// and change nothing. Placing a call, posting a message, publishing, running an
// agent turn (which may fire a tool) and writing knowledge are never retried by
// the client, unless the caller gives the request an idempotency key
// (idempotent below).
var retryable = map[string]bool{
	"whoami":                   true,
	"ai.complete":              true,
	"knowledge.search":         true,
	"knowledge.documents.list": true,
	"knowledge.documents.get":  true,
	"knowledge.sources.list":   true,
	"knowledge.export":         true,
	"voice.speak":              true,
	"voice.transcribe":         true,
	"voice.calls.get":          true,
	"voice.jobs.get":           true,
	"customers.get":            true,
}

// idempotent lists the routes that take an Idempotency-Key. Each one changes
// something every time it runs, so the client never repeats it on its own.
// Given a key (WithIdempotencyKey), it does: the platform runs the request
// once and answers a repeat with the first answer.
var idempotent = map[string]bool{
	"knowledge.documents.create": true,
	"knowledge.import_file":      true,
	"knowledge.sources.create":   true,
	"knowledge.sources.crawl":    true,
	"agent.turn":                 true,
	"voice.calls.place":          true,
	"voice.jobs.create":          true,
	"conversations.post_message": true,
	"channels.linkedin_publish":  true,
}
