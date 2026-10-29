-- An upload request and its unapproved draft are claimed atomically. A retry
-- can return the same draft, but may never associate that request with new bytes.
CREATE TABLE bilag_chat_uploads (
  actor TEXT NOT NULL,
  op TEXT NOT NULL CHECK (length(op) BETWEEN 16 AND 64),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  bilag_id INTEGER UNIQUE REFERENCES bilag(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor, op)
);
