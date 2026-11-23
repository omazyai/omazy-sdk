-- The copilot kit's tables, from @omazyai/sdk. Additive and idempotent.

-- Standing grants.
-- 0001_copilot_grants
CREATE TABLE IF NOT EXISTS copilot_grants (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  person TEXT NOT NULL,
  capability TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  daily_cap INTEGER NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS copilot_grants_owner ON copilot_grants (tenant_key, person, capability);
CREATE TABLE IF NOT EXISTS copilot_grant_uses (
  grant_id TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (grant_id, day)
);
