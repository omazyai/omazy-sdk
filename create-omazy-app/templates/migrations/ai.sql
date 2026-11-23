-- The ai kit's tables, from @omazyai/sdk. Additive and idempotent.

-- 0001_ai
CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  unit TEXT NOT NULL,
  unit_kind TEXT NOT NULL,
  unit_version INTEGER NOT NULL,
  prompt_template TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  language TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT,
  seat TEXT,
  tenant TEXT,
  person TEXT,
  channel TEXT NOT NULL,
  request_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT NOT NULL,
  error_code TEXT,
  error TEXT,
  calls INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  cost_estimated INTEGER NOT NULL DEFAULT 0,
  unpriced_calls INTEGER NOT NULL DEFAULT 0,
  context TEXT
);
CREATE INDEX IF NOT EXISTS ai_runs_spend ON ai_runs (started_at, tenant, unit);
CREATE INDEX IF NOT EXISTS ai_runs_tenant ON ai_runs (tenant, started_at);
CREATE INDEX IF NOT EXISTS ai_runs_person ON ai_runs (person, started_at);

CREATE TABLE IF NOT EXISTS ai_effects (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  capability TEXT NOT NULL,
  tier TEXT,
  mode TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  code TEXT,
  approval_id TEXT,
  request_id TEXT NOT NULL,
  at TEXT NOT NULL,
  ms INTEGER NOT NULL,
  step TEXT,
  step_kind TEXT,
  message TEXT,
  ref TEXT,
  preview INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ai_effects_run ON ai_effects (run_id, seq);
CREATE INDEX IF NOT EXISTS ai_effects_key ON ai_effects (idempotency_key);

CREATE TABLE IF NOT EXISTS ai_memory (
  id TEXT PRIMARY KEY,
  tenant TEXT,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  unit TEXT,
  run_id TEXT,
  mentions TEXT NOT NULL DEFAULT '[]',
  proposed_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS ai_memory_owner ON ai_memory (tenant, scope, subject, status);

CREATE TABLE IF NOT EXISTS ai_memory_mentions (
  memory_id TEXT NOT NULL,
  tenant TEXT,
  ref TEXT NOT NULL,
  PRIMARY KEY (memory_id, ref)
);
CREATE INDEX IF NOT EXISTS ai_memory_mentions_ref ON ai_memory_mentions (ref);

-- A thread is keyed by its tenant, its person and its id: two people may use
-- the same id and each has their own. A person with no tenant is stored with
-- tenant '' (a key column cannot be NULL and still be unique).
CREATE TABLE IF NOT EXISTS ai_threads (
  tenant TEXT NOT NULL,
  person TEXT NOT NULL,
  id TEXT NOT NULL,
  summary TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, person, id)
);
CREATE INDEX IF NOT EXISTS ai_threads_owner ON ai_threads (tenant, person, updated_at);

CREATE TABLE IF NOT EXISTS ai_turns (
  tenant TEXT NOT NULL,
  person TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (tenant, person, thread_id, seq)
);
