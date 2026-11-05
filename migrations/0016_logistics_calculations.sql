-- Free logistics calculations share verified Veyro identities, never subscriptions.
-- Inputs are independent of inventory, purchasing and the older /tools models.
CREATE TABLE logistics_calculations (
  id TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL CHECK (tool_id IN ('tco', 'eoq', 'genbestilling', 'abc')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  input_json TEXT NOT NULL CHECK (json_valid(input_json) AND length(CAST(input_json AS BLOB)) <= 131072),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX idx_logistics_calculations_owner ON logistics_calculations(customer_id, archived_at, updated_at);
