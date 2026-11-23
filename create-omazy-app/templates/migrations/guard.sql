-- The guard kit's tables, from @omazyai/sdk. Additive and idempotent.

-- 0001_guard
CREATE TABLE IF NOT EXISTS guard_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guard_nonces_expiry ON guard_nonces (expires_at);

CREATE TABLE IF NOT EXISTS guard_approvals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  action_version INTEGER NOT NULL,
  tier TEXT NOT NULL,
  requester_kind TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  requester_name TEXT,
  seat TEXT,
  door TEXT,
  channel TEXT NOT NULL,
  tenant TEXT,
  target TEXT,
  args_sealed TEXT,
  args_hash TEXT NOT NULL,
  state_version TEXT,
  preview TEXT NOT NULL,
  policy TEXT NOT NULL,
  rule TEXT NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decider_kind TEXT,
  decider_id TEXT,
  decider_name TEXT,
  decider_seat TEXT,
  verification TEXT,
  reason TEXT,
  executed_at TEXT,
  result TEXT,
  error TEXT,
  audit_id TEXT
);
CREATE INDEX IF NOT EXISTS guard_approvals_status ON guard_approvals (status, expires_at);
CREATE INDEX IF NOT EXISTS guard_approvals_tenant ON guard_approvals (tenant, status, created_at);

CREATE TABLE IF NOT EXISTS guard_challenges (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  person TEXT NOT NULL,
  channel TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS guard_switches (
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  is_on INTEGER NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (scope, subject, key)
);

CREATE TABLE IF NOT EXISTS guard_requests (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  door TEXT,
  seat TEXT,
  principal_kind TEXT,
  principal_id TEXT,
  tenant TEXT,
  channel TEXT NOT NULL,
  client_id TEXT,
  client_name TEXT,
  client_version TEXT,
  method TEXT NOT NULL,
  tool TEXT,
  tier TEXT,
  args TEXT,
  args_hash TEXT,
  outcome TEXT NOT NULL,
  error_code TEXT,
  approval_id TEXT,
  ms INTEGER NOT NULL,
  country TEXT,
  sample_rate INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS guard_requests_at ON guard_requests (at);
CREATE INDEX IF NOT EXISTS guard_requests_tenant ON guard_requests (tenant, at);
CREATE INDEX IF NOT EXISTS guard_requests_request ON guard_requests (request_id);
