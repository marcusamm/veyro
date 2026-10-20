-- Hjemmesiden veyro.dk kører i samme Worker som kundepanelet.
-- Indhold redigeret i admin gemmes her. Uden en række bruges standardindholdet fra koden.

CREATE TABLE IF NOT EXISTS site_content (
  key TEXT PRIMARY KEY,            -- fx 'template:index', 'group:header-group', 'settings', 'page:kontakt', 'menus', 'product:starter'
  value TEXT NOT NULL,             -- JSON
  updated_at INTEGER NOT NULL,     -- millisekunder
  updated_by TEXT
);

-- Tidligere versioner, så alle ændringer kan rulles tilbage.
CREATE TABLE IF NOT EXISTS site_content_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  value TEXT,                      -- NULL = standardindholdet fra koden
  replaced_at INTEGER NOT NULL,    -- sekunder
  replaced_by TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_history_key ON site_content_history (key, id DESC);

-- Uploadede billeder (logo, billeder i sektioner)
CREATE TABLE IF NOT EXISTS site_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  alt TEXT,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

-- Forespørgsler fra hjemmesidens formularer og kurv
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('kontakt', 'vurdering', 'kurv')),
  form_name TEXT,
  name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  website TEXT,
  service TEXT,
  message TEXT,
  fields TEXT NOT NULL DEFAULT '{}',   -- alle felter som JSON
  cart TEXT,                           -- kurvens linjer som JSON
  page TEXT,
  status TEXT NOT NULL DEFAULT 'ny' CHECK (status IN ('ny', 'besvaret', 'tilbud', 'kunde', 'lukket', 'spam')),
  note TEXT,
  offer_id INTEGER,
  notified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status, created_at DESC);

-- Sidevisninger pr. dag og side (ingen cookies, ingen IP-adresser)
CREATE TABLE IF NOT EXISTS site_views (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);

-- Færdiggengivne sider (HTML) for den aktuelle indholdsversion, så siderne ikke gengives igen ved hvert besøg
CREATE TABLE IF NOT EXISTS site_cache (
  key TEXT PRIMARY KEY,            -- <version>|<vært>|<sti>
  html TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
