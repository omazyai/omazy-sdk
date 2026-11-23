-- The flows kit's tables, from @omazyai/sdk. Additive and idempotent.

-- 0001_flows
CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  automation TEXT,
  tenant TEXT,
  person TEXT,
  reason TEXT,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  reported INTEGER NOT NULL DEFAULT 0,
  report TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS flow_runs_automation ON flow_runs (automation, tenant, started_at);
CREATE INDEX IF NOT EXISTS flow_runs_tenant ON flow_runs (tenant, started_at);

CREATE TABLE IF NOT EXISTS flow_links (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);

CREATE TABLE IF NOT EXISTS flow_automations (
  id TEXT NOT NULL,
  tenant TEXT NOT NULL DEFAULT '',
  on_ INTEGER NOT NULL,
  mode TEXT NOT NULL,
  role TEXT NOT NULL,
  enabled_by TEXT NOT NULL,
  seat TEXT,
  enabled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_reason TEXT,
  PRIMARY KEY (id, tenant)
);
