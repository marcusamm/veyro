-- Blokering på afsenderens navn (spamrobotter skifter mailadresse, men bruger samme navn).
-- SQLite kan ikke ændre en CHECK-regel, så tabellen genopbygges med de samme kolonner og data.
CREATE TABLE lead_blocks_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('email', 'domain', 'ip', 'name')),
  value       TEXT NOT NULL,
  label       TEXT,
  lead_id     INTEGER,
  hits        INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  created_at  INTEGER NOT NULL,
  created_by  TEXT,
  UNIQUE (kind, value)
);
INSERT INTO lead_blocks_new (id, kind, value, label, lead_id, hits, last_hit_at, created_at, created_by)
  SELECT id, kind, value, label, lead_id, hits, last_hit_at, created_at, created_by FROM lead_blocks;
DROP TABLE lead_blocks;
ALTER TABLE lead_blocks_new RENAME TO lead_blocks;
