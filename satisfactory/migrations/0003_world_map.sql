-- Actual server snapshots and proposed changes are deliberately separate.
CREATE TABLE IF NOT EXISTS factory_world_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_hash TEXT,
  created_at TEXT,
  created_by TEXT REFERENCES factory_users(id),
  world_id TEXT,
  sequence INTEGER NOT NULL DEFAULT -1,
  observed_at TEXT,
  snapshot_id TEXT,
  received_at TEXT
);
INSERT OR IGNORE INTO factory_world_connection(id) VALUES(1);

-- Each chunk is below D1's individual TEXT/row limit. Publication is one atomic batch.
CREATE TABLE IF NOT EXISTS factory_world_chunks (
  snapshot_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, part)
);

CREATE TABLE IF NOT EXISTS factory_world_plans (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT REFERENCES factory_users(id)
);
INSERT OR IGNORE INTO factory_world_plans(id,data) VALUES(1,'{"version":1,"worldId":null,"markers":[]}');
