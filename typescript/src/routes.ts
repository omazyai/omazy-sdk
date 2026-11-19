// Every Core API route this client covers, keyed by the name the contract
// gives it (contracts/core-api.routes.json). The client builds each request
// from this table and nowhere else, and the tests hold the table to the
// contract: a route added to the platform and not here fails them.
export const ROUTES = {
  whoami: ['GET', '/whoami'],
  'ai.complete': ['POST', '/ai/complete'],
  'knowledge.search': ['POST', '/knowledge/search'],
  'knowledge.documents.list': ['GET', '/knowledge/documents'],
  'knowledge.documents.create': ['POST', '/knowledge/documents'],
  'knowledge.documents.get': ['GET', '/knowledge/documents/{id}'],
  'knowledge.documents.update': ['PATCH', '/knowledge/documents/{id}'],
  'knowledge.documents.delete': ['DELETE', '/knowledge/documents/{id}'],
  'knowledge.import_file': ['POST', '/knowledge/import'],
  'knowledge.sources.list': ['GET', '/knowledge/sources'],
  'knowledge.sources.create': ['POST', '/knowledge/sources'],
  'knowledge.sources.crawl': ['POST', '/knowledge/sources/{id}/crawl'],
  'knowledge.export': ['GET', '/knowledge/export'],
  'agent.turn': ['POST', '/agent/turn'],
  'voice.speak': ['POST', '/voice/speak'],
  'voice.transcribe': ['POST', '/voice/transcribe'],
  'voice.calls.place': ['POST', '/voice/calls'],
  'voice.calls.get': ['GET', '/voice/calls/{ref}'],
  'voice.jobs.create': ['POST', '/voice/jobs'],
  'voice.jobs.get': ['GET', '/voice/jobs/{id}'],
  'customers.get': ['GET', '/customers/{id}'],
  'customers.update': ['PATCH', '/customers/{id}'],
  'conversations.post_message': ['POST', '/conversations/{id}/messages'],
  'channels.linkedin_publish': ['POST', '/channels/linkedin/publish'],
  'sessions.bind_credential': ['PUT', '/sessions/{sid}/mcp-credentials/{server}'],
  'sessions.unbind_credential': ['DELETE', '/sessions/{sid}/mcp-credentials/{server}'],
  mcp: ['POST', '/mcp'],
} as const satisfies Record<string, readonly [string, string]>

export type RouteName = keyof typeof ROUTES

// Routes that are safe to send again after a 429, a gateway error or a dropped
// connection: they read, or they compute an answer and change nothing. Placing
// a call, posting a message, publishing, running an agent turn (which may fire
// a tool) and writing knowledge are never retried by the client, unless the
// caller gives the request an idempotency key (IDEMPOTENT below).
export const RETRYABLE: ReadonlySet<RouteName> = new Set<RouteName>([
  'whoami',
  'ai.complete',
  'knowledge.search',
  'knowledge.documents.list',
  'knowledge.documents.get',
  'knowledge.sources.list',
  'knowledge.export',
  'voice.speak',
  'voice.transcribe',
  'voice.calls.get',
  'voice.jobs.get',
  'customers.get',
])

// Routes that take an Idempotency-Key. Each one changes something every time
// it runs, so the client never repeats it on its own. Given a key, it does: the
// platform runs the request once and answers a repeat with the first answer.
export const IDEMPOTENT: ReadonlySet<RouteName> = new Set<RouteName>([
  'knowledge.documents.create',
  'knowledge.import_file',
  'knowledge.sources.create',
  'knowledge.sources.crawl',
  'agent.turn',
  'voice.calls.place',
  'voice.jobs.create',
  'conversations.post_message',
  'channels.linkedin_publish',
])
