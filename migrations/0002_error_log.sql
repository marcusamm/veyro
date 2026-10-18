-- Fejllog, så fejl fra Stripe m.fl. kan ses uden adgang til Cloudflare-loggen.
-- Ingen persondata: kun sted, tidspunkt og fejlbesked.
CREATE TABLE IF NOT EXISTS error_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  place   TEXT NOT NULL,
  detail  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_log_at ON error_log(at);
