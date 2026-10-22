-- Kundeopsætning: virksomheder, deres hjemmesider/projekter, tjenester, versioner, publiceringer og domæner.
-- Kun nye tabeller; intet eksisterende ændres.

-- Virksomheden (kunden). id er et fast internt id, der aldrig ændres, selvom navn, CVR eller domæne ændres.
CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,                -- fx 'v_3k9...'
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL,                   -- navnet normaliseret (små bogstaver, uden ApS/A/S osv.) til dubletkontrol
  cvr           TEXT,                            -- 8 cifre eller NULL
  contact_name  TEXT,
  email         TEXT,
  phone         TEXT,
  address       TEXT,
  postal_code   TEXT,
  city          TEXT,
  website       TEXT,                            -- nuværende hjemmeside, hvis den har en
  industry      TEXT,
  description   TEXT,                            -- kort beskrivelse fra kunden (intern, kopieres ikke automatisk ud)
  internal_note TEXT,                            -- kun til Veyro
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  created_by    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_cvr ON companies (cvr) WHERE cvr IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_name_key ON companies (name_key);

-- Et projekt er én hjemmeside eller én samling interne systemer for en virksomhed. En virksomhed kan have flere.
CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,            -- fx 'p_8fj...', fast
  company_id        TEXT NOT NULL REFERENCES companies(id),
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,        -- teknisk adresse (fx 'nordlys' → nordlys.veyro.dk). Låses ved første publicering/udrulning
  slug_locked       INTEGER NOT NULL DEFAULT 0,
  kind              TEXT NOT NULL CHECK (kind IN ('skabelon', 'tilsluttet', 'intern')),
  template          TEXT,                        -- startpunktet, kun for 'skabelon'
  external_url      TEXT,                        -- kun for 'tilsluttet': den færdige sides adresse
  public_key        TEXT NOT NULL UNIQUE,        -- offentlig nøgle til formularer og konfiguration (ikke hemmelig)
  onboarding_step   TEXT NOT NULL DEFAULT 'type',
  draft             TEXT NOT NULL DEFAULT '{}',  -- hjemmesidens kladde (JSON)
  draft_updated_at  INTEGER NOT NULL,
  draft_updated_by  TEXT,
  live_version_id   INTEGER,                     -- den publicerede version
  previous_version_id INTEGER,                   -- versionen før, til tilbagerulning
  offline           INTEGER NOT NULL DEFAULT 0,  -- 1 = midlertidigt taget offline (data bevares)
  publish_lock      TEXT,                        -- igangværende publicering (forhindrer dobbeltklik)
  publish_lock_at   INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  created_by        TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_company ON projects (company_id);

-- Tjenester pr. projekt. Slås en tjeneste fra, bevares rækken og dens data (enabled = 0).
CREATE TABLE IF NOT EXISTS project_services (
  project_id     TEXT NOT NULL REFERENCES projects(id),
  service        TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  config         TEXT NOT NULL DEFAULT '{}',     -- kun ikke-hemmelige indstillinger
  status         TEXT NOT NULL DEFAULT 'mangler',-- mangler | klar | afventer | forbundet | blokeret
  status_detail  TEXT,
  provision_requested_at INTEGER,                -- "Udrul tjenester" er valgt (varebestilling/lagerstyring)
  provisioned_at INTEGER,
  provisioned_url TEXT,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (project_id, service)
);

-- Låste versioner af hjemmesiden. Godkendelse gælder præcis én version (content_hash).
CREATE TABLE IF NOT EXISTS project_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  number       INTEGER NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  approved_at  INTEGER,
  approved_by  TEXT,
  published_at INTEGER,
  UNIQUE (project_id, number),
  UNIQUE (project_id, content_hash)
);

-- Publiceringer (forsøg). Detaljer er renset for persondata og hemmeligheder.
CREATE TABLE IF NOT EXISTS publications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  version_id   INTEGER NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'publicering' CHECK (kind IN ('publicering', 'tilbagerulning')),
  status       TEXT NOT NULL CHECK (status IN ('koerer', 'faerdig', 'fejlet')),
  steps        TEXT NOT NULL DEFAULT '[]',
  error        TEXT,
  actor        TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_publications_project ON publications (project_id, id DESC);

-- Domæner. Et værtsnavn kan kun være knyttet til ét projekt ad gangen.
CREATE TABLE IF NOT EXISTS project_domains (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  hostname      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('veyro', 'eget')),
  method        TEXT,                            -- workers_domain | saas | NULL (ingen understøttet metode endnu)
  status        TEXT NOT NULL DEFAULT 'afventer' CHECK (status IN ('afventer', 'verificerer', 'aktiv', 'fejlet', 'blokeret', 'fjernet')),
  provider_id   TEXT,
  records       TEXT NOT NULL DEFAULT '[]',      -- DNS-poster, som Cloudflare har oplyst (JSON)
  detail        TEXT,
  last_check_at INTEGER,
  verified_at   INTEGER,
  created_at    INTEGER NOT NULL,
  created_by    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_domains_host ON project_domains (hostname) WHERE status != 'fjernet';
CREATE INDEX IF NOT EXISTS idx_project_domains_project ON project_domains (project_id);

-- Forhåndsvisningslinks. Kun SHA-256 af tokenet gemmes. Kan tilbagekaldes.
CREATE TABLE IF NOT EXISTS preview_links (
  token_hash  TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  label       TEXT NOT NULL,                     -- 'admin' eller fx 'Til kunden'
  created_at  INTEGER NOT NULL,
  created_by  TEXT,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_preview_links_project ON preview_links (project_id);

-- Billeder til kundehjemmesider (logo og sektioner). Tilhører altid ét projekt.
CREATE TABLE IF NOT EXISTS project_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  data        BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files (project_id);

-- Henvendelser fra kundernes hjemmesider (adskilt fra Veyros egne forespørgsler i leads)
CREATE TABLE IF NOT EXISTS project_leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  name         TEXT,
  email        TEXT NOT NULL,
  phone        TEXT,
  message      TEXT,
  page         TEXT,
  test         INTEGER NOT NULL DEFAULT 0,       -- 1 = sendt fra en forhåndsvisning (testdata, sendes ikke videre)
  notified_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_leads_project ON project_leads (project_id, created_at DESC);

-- Kundens egne brugere i kundepanelet (login via engangslink). Giver kun adgang til egen virksomhed.
CREATE TABLE IF NOT EXISTS company_members (
  company_id  TEXT NOT NULL REFERENCES companies(id),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'ejer',
  invited_at  INTEGER NOT NULL,
  invited_by  TEXT,
  PRIMARY KEY (company_id, email)
);
CREATE INDEX IF NOT EXISTS idx_company_members_email ON company_members (email);

-- Aktivitetslog: hvem ændrede hvad, hvornår og for hvilken kunde. Ingen hemmeligheder eller unødige persondata.
CREATE TABLE IF NOT EXISTS customer_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  company_id  TEXT,
  project_id  TEXT,
  action      TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_customer_audit_company ON customer_audit (company_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_customer_audit_project ON customer_audit (project_id, id DESC);
