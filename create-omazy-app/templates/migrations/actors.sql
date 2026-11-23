-- The actors kit's tables, from @omazyai/sdk. Additive and idempotent.

-- 0001_actor_sessions
CREATE TABLE IF NOT EXISTS actor_sessions (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  actor_version INTEGER NOT NULL,
  tenant_key TEXT NOT NULL,
  person TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS actor_sessions_open ON actor_sessions (tenant_key, person, state, updated_at);
CREATE INDEX IF NOT EXISTS actor_sessions_expires ON actor_sessions (state, expires_at);
