-- Optional first-party analytics: populated only after current-version statistics consent.
-- No IP addresses, raw user agents, query strings, form contents or cross-site identities.
CREATE TABLE site_analytics_visitors (
  id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  consent_version INTEGER NOT NULL CHECK (consent_version = 2)
);
CREATE INDEX idx_site_analytics_visitors_retention ON site_analytics_visitors(last_seen_at);

CREATE TABLE site_analytics_sessions (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL REFERENCES site_analytics_visitors(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  is_returning INTEGER NOT NULL CHECK (is_returning IN (0, 1)),
  country TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT 'unknown',
  browser TEXT NOT NULL DEFAULT 'unknown',
  os TEXT NOT NULL DEFAULT 'unknown',
  source TEXT NOT NULL DEFAULT 'Direkte / ukendt',
  entry_path TEXT NOT NULL,
  exit_path TEXT NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 0 CHECK (pageviews >= 0),
  active_seconds INTEGER NOT NULL DEFAULT 0 CHECK (active_seconds >= 0)
);
CREATE INDEX idx_site_analytics_sessions_started ON site_analytics_sessions(started_at);
CREATE INDEX idx_site_analytics_sessions_visitor ON site_analytics_sessions(visitor_id, last_seen_at);

CREATE TABLE site_analytics_pageviews (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES site_analytics_sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  active_seconds INTEGER NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
  scroll_depth INTEGER NOT NULL DEFAULT 0 CHECK (scroll_depth BETWEEN 0 AND 100)
);
CREATE INDEX idx_site_analytics_pageviews_session ON site_analytics_pageviews(session_id, viewed_at);
CREATE INDEX idx_site_analytics_pageviews_time ON site_analytics_pageviews(viewed_at);
