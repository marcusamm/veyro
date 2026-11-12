PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS factory_plans (
  id INTEGER PRIMARY KEY NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE factory_users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('admin', 'player')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  auth_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (username = lower(username)),
  CHECK ((username = 'marcus' AND role = 'admin' AND active = 1) OR (username <> 'marcus' AND role = 'player'))
);
CREATE TABLE factory_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES factory_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  auth_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX factory_sessions_user ON factory_sessions(user_id);
CREATE INDEX factory_sessions_expiry ON factory_sessions(expires_at);

CREATE TABLE factory_login_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL,
  resets_at INTEGER NOT NULL
);
CREATE INDEX factory_login_limits_expiry ON factory_login_limits(resets_at);

CREATE TABLE factory_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE private_documents (
  name TEXT PRIMARY KEY NOT NULL,
  content BLOB NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/pdf',
  updated_at TEXT NOT NULL
);
