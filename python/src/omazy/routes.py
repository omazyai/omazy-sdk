"""Every Core API route this client covers, keyed by the name the contract
gives it (contracts/core-api.routes.json). The client builds each request from
this table and nowhere else, and the tests hold the table to the contract: a
route added to the platform and not here fails them."""

ROUTES = {
    "whoami": ("GET", "/whoami"),
    "contract": ("GET", "/contract"),
    "ai.complete": ("POST", "/ai/complete"),
    "ai.embed": ("POST", "/ai/embeddings"),
    "ai.models": ("GET", "/ai/models"),
    "ai.roles.list": ("GET", "/ai/roles"),
    "ai.roles.set": ("PUT", "/ai/roles/{name}"),
    "ai.roles.delete": ("DELETE", "/ai/roles/{name}"),
    "knowledge.search": ("POST", "/knowledge/search"),
    "knowledge.documents.list": ("GET", "/knowledge/documents"),
    "knowledge.documents.create": ("POST", "/knowledge/documents"),
    "knowledge.documents.get": ("GET", "/knowledge/documents/{id}"),
    "knowledge.documents.update": ("PATCH", "/knowledge/documents/{id}"),
    "knowledge.documents.delete": ("DELETE", "/knowledge/documents/{id}"),
    "knowledge.import_file": ("POST", "/knowledge/import"),
    "knowledge.sources.list": ("GET", "/knowledge/sources"),
    "knowledge.sources.create": ("POST", "/knowledge/sources"),
    "knowledge.sources.crawl": ("POST", "/knowledge/sources/{id}/crawl"),
    "knowledge.export": ("GET", "/knowledge/export"),
    "agent.turn": ("POST", "/agent/turn"),
    "agent.settings.get": ("GET", "/agent/settings"),
    "agent.settings.update": ("PATCH", "/agent/settings"),
    "agent.mcp_servers.list": ("GET", "/agent/mcp-servers"),
    "agent.mcp_servers.create": ("POST", "/agent/mcp-servers"),
    "agent.mcp_servers.get": ("GET", "/agent/mcp-servers/{id}"),
    "agent.mcp_servers.update": ("PATCH", "/agent/mcp-servers/{id}"),
    "agent.mcp_servers.delete": ("DELETE", "/agent/mcp-servers/{id}"),
    "voice.speak": ("POST", "/voice/speak"),
    "voice.transcribe": ("POST", "/voice/transcribe"),
    "voice.transcribe_stream": ("GET", "/voice/transcribe/stream"),
    "voice.calls.place": ("POST", "/voice/calls"),
    "voice.calls.get": ("GET", "/voice/calls/{ref}"),
    "voice.jobs.create": ("POST", "/voice/jobs"),
    "voice.jobs.get": ("GET", "/voice/jobs/{id}"),
    "customers.get": ("GET", "/customers/{id}"),
    "customers.update": ("PATCH", "/customers/{id}"),
    "conversations.post_message": ("POST", "/conversations/{id}/messages"),
    "channels.linkedin_publish": ("POST", "/channels/linkedin/publish"),
    "sessions.bind_credential": ("PUT", "/sessions/{sid}/mcp-credentials/{server}"),
    "sessions.unbind_credential": ("DELETE", "/sessions/{sid}/mcp-credentials/{server}"),
    "usage.get": ("GET", "/usage"),
    "budgets.list": ("GET", "/budgets"),
    "budgets.set": ("PUT", "/budgets"),
    "budgets.delete": ("DELETE", "/budgets/{id}"),
    "mcp": ("POST", "/mcp"),
}

# Routes that are safe to send again after a 429, a gateway error or a dropped
# connection: they read, or they compute an answer and change nothing. Placing a
# call, posting a message, publishing, running an agent turn (which may fire a
# tool) and adding knowledge are never retried by the client, unless the
# caller gives the request an idempotency key (IDEMPOTENT below).
RETRYABLE = frozenset(
    {
        "whoami",
        "contract",
        "ai.complete",
        "ai.embed",
        "ai.models",
        "ai.roles.list",
        "ai.roles.set",
        "knowledge.search",
        "knowledge.documents.list",
        "knowledge.documents.get",
        # Changing a document and deleting one. The same change sent twice
        # leaves the same document, and a deleted document stays deleted. A
        # delete sent again after the first one went through answers 404
        # NOT_FOUND: the document is gone either way.
        "knowledge.documents.update",
        "knowledge.documents.delete",
        "knowledge.sources.list",
        "knowledge.export",
        # Reading the agent's settings, and changing them: the same change
        # sent twice leaves the same settings.
        "agent.settings.get",
        "agent.settings.update",
        # The agent's MCP servers: reads, a change, which leaves the same
        # server when it is sent twice, and a removal, which leaves it
        # removed. A removal sent again after the first one went through
        # answers 404 NOT_FOUND.
        "agent.mcp_servers.list",
        "agent.mcp_servers.get",
        "agent.mcp_servers.update",
        "agent.mcp_servers.delete",
        "voice.speak",
        "voice.transcribe",
        "voice.calls.get",
        "voice.jobs.get",
        "customers.get",
        "usage.get",
        "budgets.list",
        "budgets.set",
    }
)

# Routes that take an Idempotency-Key. Each one changes something every time it
# runs, so the client never repeats it on its own. Given a key, it does: the
# platform runs the request once and answers a repeat with the first answer.
IDEMPOTENT = frozenset(
    {
        "knowledge.documents.create",
        "knowledge.import_file",
        "knowledge.sources.create",
        "knowledge.sources.crawl",
        "agent.turn",
        "agent.mcp_servers.create",
        "voice.calls.place",
        "voice.jobs.create",
        "conversations.post_message",
        "channels.linkedin_publish",
    }
)

# Routes that are a WebSocket: the client opens them with an Upgrade request
# carrying the same token, and never retries one.
WEBSOCKET = frozenset({"voice.transcribe_stream"})
