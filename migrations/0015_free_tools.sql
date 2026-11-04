-- Free planning workspaces use the existing verified Veyro account.
-- No Stripe, subscription, inventory or purchasing records are created here.
CREATE TABLE IF NOT EXISTS tool_projects (
  id TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  currency TEXT NOT NULL CHECK (currency IN ('DKK', 'EUR', 'SEK')),
  data_json TEXT NOT NULL CHECK (json_valid(data_json) AND length(data_json) <= 50000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_projects_owner ON tool_projects(customer_id, archived_at, updated_at);
