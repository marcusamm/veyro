-- Expand supported tools while preserving every existing saved record and version.
-- No tables reference logistics_calculations. The customer FK and owner index are retained.
CREATE TABLE logistics_calculations_expanded (
  id TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL CHECK (tool_id IN ('tco', 'eoq', 'genbestilling', 'abc', 'ladmeter', 'luftfragt', 'palletransport', 'containertransport', 'biltransport')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  input_json TEXT NOT NULL CHECK (json_valid(input_json) AND length(CAST(input_json AS BLOB)) <= 131072),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

INSERT INTO logistics_calculations_expanded
  (id, customer_id, tool_id, name, input_json, schema_version, version, created_at, updated_at, archived_at)
SELECT id, customer_id, tool_id, name, input_json, schema_version, version, created_at, updated_at, archived_at
FROM logistics_calculations;

DROP TABLE logistics_calculations;
ALTER TABLE logistics_calculations_expanded RENAME TO logistics_calculations;
CREATE INDEX idx_logistics_calculations_owner ON logistics_calculations(customer_id, archived_at, updated_at);
