-- Factory layouts are independent from the original checklist / recipe documents.
CREATE TABLE IF NOT EXISTS factory_layouts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT REFERENCES factory_users(id)
);
