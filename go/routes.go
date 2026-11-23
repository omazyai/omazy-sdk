package omazy

// route is one Core API route: its method and its path under the base URL.
type route struct{ method, path string }

// Routes is every Core API route this client covers, keyed by the name the
// contract gives it (contracts/core-api.routes.json). The client builds each
// request from this table and nowhere else, and the tests hold the table to
// the contract: a route added to the platform and not here fails them.
var routes = map[string]route{
	"whoami":                     {"GET", "/whoami"},
	"contract":                   {"GET", "/contract"},
	"ai.complete":                {"POST", "/ai/complete"},
	"ai.embed":                   {"POST", "/ai/embeddings"},
	"ai.models":                  {"GET", "/ai/models"},
	"ai.roles.list":              {"GET", "/ai/roles"},
	"ai.roles.set":               {"PUT", "/ai/roles/{name}"},
	"ai.roles.delete":            {"DELETE", "/ai/roles/{name}"},
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
	"agent.settings.get":         {"GET", "/agent/settings"},
	"agent.settings.update":      {"PATCH", "/agent/settings"},
	"agent.mcp_servers.list":     {"GET", "/agent/mcp-servers"},
	"agent.mcp_servers.create":   {"POST", "/agent/mcp-servers"},
	"agent.mcp_servers.get":      {"GET", "/agent/mcp-servers/{id}"},
	"agent.mcp_servers.update":   {"PATCH", "/agent/mcp-servers/{id}"},
	"agent.mcp_servers.delete":   {"DELETE", "/agent/mcp-servers/{id}"},
	"voice.speak":                {"POST", "/voice/speak"},
	"voice.transcribe":           {"POST", "/voice/transcribe"},
	"voice.transcribe_stream":    {"GET", "/voice/transcribe/stream"},
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
	"usage.get":                  {"GET", "/usage"},
	"budgets.list":               {"GET", "/budgets"},
	"budgets.set":                {"PUT", "/budgets"},
	"budgets.delete":             {"DELETE", "/budgets/{id}"},
	"mcp":                        {"POST", "/mcp"},
}

// retryable lists the routes that are safe to send again after a 429, a
// gateway error or a dropped connection: they read, or they compute an answer
// and change nothing. Placing a call, posting a message, publishing, running an
// agent turn (which may fire a tool) and adding knowledge are never retried by
// the client, unless the caller gives the request an idempotency key
// (idempotent below).
var retryable = map[string]bool{
	"whoami":      true,
	"contract":    true,
	"ai.complete": true,
	"ai.embed":    true,
	"ai.models":   true,
	// Model roles: the list, and a mapping, which leaves the same mapping
	// sent twice. A delete is not here: a second one answers 404.
	"ai.roles.list":            true,
	"ai.roles.set":             true,
	"knowledge.search":         true,
	"knowledge.documents.list": true,
	"knowledge.documents.get":  true,
	// Changing a document and deleting one. The same change sent twice leaves
	// the same document, and a deleted document stays deleted. A delete sent
	// again after the first one went through answers 404 NOT_FOUND: the
	// document is gone either way.
	"knowledge.documents.update": true,
	"knowledge.documents.delete": true,
	"knowledge.sources.list":     true,
	"knowledge.export":           true,
	// Reading the agent's settings, and changing them: the same change sent
	// twice leaves the same settings.
	"agent.settings.get":    true,
	"agent.settings.update": true,
	// The agent's MCP servers: reads, a change, which leaves the same server
	// when it is sent twice, and a removal, which leaves it removed. A removal
	// sent again after the first one went through answers 404 NOT_FOUND.
	"agent.mcp_servers.list":   true,
	"agent.mcp_servers.get":    true,
	"agent.mcp_servers.update": true,
	"agent.mcp_servers.delete": true,
	"voice.speak":              true,
	"voice.transcribe":         true,
	"voice.calls.get":          true,
	"voice.jobs.get":           true,
	"customers.get":            true,
	"usage.get":                true,
	// Spend caps: the list, and a cap, which the same request sent twice
	// leaves the same. A delete is not here: a second one answers 404.
	"budgets.list": true,
	"budgets.set":  true,
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
	"agent.mcp_servers.create":   true,
	"voice.calls.place":          true,
	"voice.jobs.create":          true,
	"conversations.post_message": true,
	"channels.linkedin_publish":  true,
}

// websocket lists the routes that are a WebSocket: the client opens them with
// an Upgrade request carrying the same token, and never retries one.
var websocket = map[string]bool{
	"voice.transcribe_stream": true,
}
