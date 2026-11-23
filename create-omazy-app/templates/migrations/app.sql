-- The product's own tables. Add a new numbered file for each change; never
-- edit one that has been applied.

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_tenant ON notes (tenant, created_at);
