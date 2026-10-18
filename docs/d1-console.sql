CREATE TABLE customers ( id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT, stripe_customer_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
CREATE TABLE subscriptions ( id TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, status TEXT NOT NULL, plan TEXT, price_id TEXT, item_id TEXT, amount INTEGER, currency TEXT, started_at INTEGER, current_period_end INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, cancel_at INTEGER, canceled_at INTEGER, payment_failed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL );
CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
CREATE TABLE login_tokens ( token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL );
CREATE INDEX idx_login_tokens_expires ON login_tokens(expires_at);
CREATE TABLE sessions ( id_hash TEXT PRIMARY KEY, email TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL );
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_email ON sessions(email);
CREATE TABLE rate_limits ( key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL );
CREATE TABLE requests ( id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, type TEXT NOT NULL CHECK (type IN ('content', 'bug', 'question')), title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_progress', 'resolved')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
CREATE INDEX idx_requests_customer ON requests(customer_id, created_at);
CREATE INDEX idx_requests_status ON requests(status, created_at);
CREATE TABLE webhook_events ( id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL );
CREATE TABLE IF NOT EXISTS error_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  place   TEXT NOT NULL,
  detail  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_log_at ON error_log(at);
