-- Shared production targets/settings stay independent from layouts and world plans.
CREATE TABLE IF NOT EXISTS factory_production_plans (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT REFERENCES factory_users(id)
);
