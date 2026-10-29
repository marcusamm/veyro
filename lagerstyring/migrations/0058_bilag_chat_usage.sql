-- Only operational request counts; questions and model responses are not stored.
CREATE TABLE bilag_chat_usage (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX bilag_chat_usage_at ON bilag_chat_usage(created_at);
CREATE INDEX bilag_chat_usage_actor_at ON bilag_chat_usage(actor, created_at);
