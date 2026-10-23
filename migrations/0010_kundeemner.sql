-- Kundeemner (virksomheder, Veyro selv finder), kontakthistorik, blokeringer og intern registrering
-- af tid og udgifter på kundeemner og kunder. Kun for Veyro-administratorer; intet her vises i kundepanelet.
-- Migrationen opretter kun nye tabeller og kolonner. Eksisterende data ændres ikke.

CREATE TABLE prospects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company         TEXT NOT NULL,
  cvr             TEXT,
  industry        TEXT,                       -- branche
  city            TEXT,
  address         TEXT,
  area            TEXT,                       -- område, fx "Sjælland" eller "Slagelse og omegn"
  website         TEXT,
  domain          TEXT,                       -- hjemmesidens domæne uden www (dublet- og mailsignal)
  contact_name    TEXT,
  source          TEXT,                       -- fx "Festival", "Google", "Anbefaling"
  source_url      TEXT,
  found_on        TEXT,                       -- funddato (YYYY-MM-DD, dansk tid)
  needs           TEXT,                       -- konkrete forbedringsmuligheder og behov
  services        TEXT,                       -- relevante Veyro-ydelser
  priority        TEXT NOT NULL DEFAULT 'mellem' CHECK (priority IN ('hoej', 'mellem', 'lav')),
  owner           TEXT,                       -- ansvarlig Veyro-medarbejder (e-mail)
  status          TEXT NOT NULL DEFAULT 'undersoeges'
                  CHECK (status IN ('undersoeges', 'klar', 'afventer', 'dialog', 'afslag', 'kunde')),
  status_set_at   INTEGER,                    -- seneste manuelle statusbeslutning (automatik må ikke overskrive en nyere)
  status_set_by   TEXT,
  next_action     TEXT,
  follow_up_on    TEXT,                       -- opfølgningsdato (YYYY-MM-DD, dansk tid)
  follow_up_review INTEGER NOT NULL DEFAULT 0, -- 1 = der er kommet svar; opfølgningen skal gennemgås
  suggested_status TEXT,                      -- forslag fra mailautomatik (fx 'dialog'), vises til godkendelse
  suggested_owner TEXT,
  notes           TEXT,
  last_contact_at INTEGER,
  archived_at     INTEGER,
  archived_by     TEXT,
  blacklisted     INTEGER NOT NULL DEFAULT 0, -- afledt af en aktiv blokering knyttet til emnet
  customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  lead_id         INTEGER,                    -- tilknyttet forespørgsel fra hjemmesiden
  merged_into     INTEGER,                    -- sat, når emnet er lagt sammen med et andet
  unverified      TEXT NOT NULL DEFAULT '[]', -- JSON: felter hentet maskinelt og endnu ikke bekræftet
  fetched_from    TEXT,
  fetched_at      INTEGER,
  assessment      TEXT,                       -- JSON: vurdering af hjemmesiden
  assessment_approved_at INTEGER,
  assessment_approved_by TEXT,
  version         INTEGER NOT NULL DEFAULT 1, -- til samtidige ændringer
  created_at      INTEGER NOT NULL,
  created_by      TEXT,
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT
);
CREATE INDEX idx_prospects_status ON prospects(status, follow_up_on);
CREATE INDEX idx_prospects_owner ON prospects(owner, status);
CREATE INDEX idx_prospects_follow ON prospects(follow_up_on);
CREATE INDEX idx_prospects_domain ON prospects(domain);
CREATE INDEX idx_prospects_cvr ON prospects(cvr);
CREATE INDEX idx_prospects_customer ON prospects(customer_id);
CREATE INDEX idx_prospects_updated ON prospects(updated_at DESC);

-- Mailadresser og telefonnumre på et kundeemne
CREATE TABLE prospect_contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('email', 'phone')),
  value       TEXT NOT NULL,                  -- e-mail med små bogstaver; telefon som indtastet
  label       TEXT,                           -- fx navnet på personen
  unverified  INTEGER NOT NULL DEFAULT 0,
  bounced_at  INTEGER,                        -- leveringsfejl registreret
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_prospect_contacts_p ON prospect_contacts(prospect_id);
CREATE INDEX idx_prospect_contacts_v ON prospect_contacts(kind, value);

CREATE TABLE prospect_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);
CREATE INDEX idx_prospect_links_p ON prospect_links(prospect_id);

-- Skærmbilleder og bilag som dokumentation (kun billeder og PDF)
CREATE TABLE prospect_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  data        BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);
CREATE INDEX idx_prospect_files_p ON prospect_files(prospect_id);

-- Tidslinje: kontakter, noter og ændringer (status, ansvarlig, blokering, arkivering, sammenlægning ...)
CREATE TABLE prospect_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id    INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  at             INTEGER NOT NULL,            -- hvornår det skete (for kontakter: kontakttidspunktet)
  kind           TEXT NOT NULL,               -- contact | note | status | owner | blacklist | unblacklist | archive | restore | merge | created | followup | offer | customer | lead | mail | edit | auto
  channel        TEXT,                        -- for kontakt: mail | telefon | moede | andet
  actor          TEXT,                        -- Veyro-medarbejder (e-mail) eller 'system'
  contact_person TEXT,
  body           TEXT,
  old_value      TEXT,
  new_value      TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_prospect_events_p ON prospect_events(prospect_id, at DESC);
CREATE INDEX idx_prospect_events_kind ON prospect_events(kind, at);

-- Blokeringer (blacklisting). Rækken bevares minimalt, også hvis kundeemnet slettes.
CREATE TABLE prospect_blocks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope        TEXT NOT NULL CHECK (scope IN ('email', 'domain', 'company')),
  value        TEXT NOT NULL,                 -- e-mail, domæne, "cvr:12345678" eller "navn:<normaliseret navn>"
  company      TEXT,                          -- navnet, så blokeringen kan genkendes efter sletning
  reason       TEXT NOT NULL,
  prospect_id  INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL,
  lifted_at    INTEGER,
  lifted_by    TEXT,
  lift_reason  TEXT
);
CREATE INDEX idx_prospect_blocks_v ON prospect_blocks(scope, value, lifted_at);
CREATE INDEX idx_prospect_blocks_p ON prospect_blocks(prospect_id);

-- Interne notifikationer i admin (fx svar på en mail til et kundeemne)
CREATE TABLE admin_notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient   TEXT,                           -- e-mail; NULL = alle administratorer
  prospect_id INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);
CREATE INDEX idx_admin_notifications_r ON admin_notifications(recipient, read_at);

-- Tilbud oprettet fra et kundeemne
ALTER TABLE offers ADD COLUMN prospect_id INTEGER;

-- ---------- Intern tid og omkostninger ----------

-- Indstillinger (fx standard-timesatsen). Ændring påvirker kun nye registreringer.
CREATE TABLE cost_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Tidsregistreringer: på et kundeemne eller en kunde. Timesatsen gemmes på posten.
CREATE TABLE time_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  subject_label TEXT,                         -- navnet på emnet/kunden, så posten kan genkendes efter sletning
  work_date   TEXT NOT NULL,                  -- dato for arbejdet (YYYY-MM-DD)
  staff       TEXT NOT NULL,                  -- medarbejder (e-mail)
  minutes     INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  category    TEXT NOT NULL CHECK (category IN ('salg', 'oprettelse', 'drift', 'udvikling')),
  description TEXT NOT NULL,
  rate        INTEGER NOT NULL CHECK (rate >= 0), -- intern timesats i øre ekskl. moms
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT,
  deleted_at  INTEGER,
  deleted_by  TEXT
);
CREATE INDEX idx_time_prospect ON time_entries(prospect_id, work_date);
CREATE INDEX idx_time_customer ON time_entries(customer_id, work_date);
CREATE INDEX idx_time_date ON time_entries(work_date);

-- Eksterne udgifter: engangs eller tilbagevendende. Uden kundeemne og kunde = fælles udgift med fordeling.
CREATE TABLE expenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  subject_label TEXT,
  shared      INTEGER NOT NULL DEFAULT 0,     -- 1 = fælles udgift, fordeles på flere
  basis       TEXT,                           -- fordelingsgrundlag (vises)
  spent_on    TEXT NOT NULL,                  -- dato (engangs) eller startdato (tilbagevendende)
  description TEXT NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount > 0), -- øre ekskl. moms (pr. interval for tilbagevendende)
  type        TEXT NOT NULL CHECK (type IN ('domaene', 'hosting', 'software', 'ekstern', 'materiale', 'andet')),
  purpose     TEXT NOT NULL CHECK (purpose IN ('salg', 'oprettelse', 'drift', 'udvikling')),
  supplier    TEXT,
  recurring   INTEGER NOT NULL DEFAULT 0,
  interval    TEXT CHECK (interval IN ('month', 'quarter', 'year')),
  end_on      TEXT,                           -- eventuel slutdato for tilbagevendende
  registered_by TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT,
  deleted_at  INTEGER,
  deleted_by  TEXT
);
CREATE INDEX idx_expenses_prospect ON expenses(prospect_id);
CREATE INDEX idx_expenses_customer ON expenses(customer_id);

-- Faktisk registrerede perioder for en tilbagevendende udgift. Én pr. periode (ingen dobbelt optælling).
CREATE TABLE expense_periods (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  period      TEXT NOT NULL,                  -- periodens startdato (YYYY-MM-DD)
  amount      INTEGER NOT NULL CHECK (amount > 0),
  note        TEXT,
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  UNIQUE (expense_id, period)
);

-- Fordeling af en fælles udgift. Summen må ikke overstige udgiftens beløb.
CREATE TABLE expense_allocations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  subject_label TEXT,
  amount      INTEGER NOT NULL CHECK (amount > 0), -- øre pr. udgiftsbeløb (pr. interval for tilbagevendende)
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL
);
CREATE INDEX idx_alloc_expense ON expense_allocations(expense_id);
CREATE INDEX idx_alloc_prospect ON expense_allocations(prospect_id);
CREATE INDEX idx_alloc_customer ON expense_allocations(customer_id);

-- Bilag til udgifter
CREATE TABLE expense_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  data        BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL
);

-- Ændringshistorik for tids- og udgiftsposter
CREATE TABLE cost_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL CHECK (entity IN ('time', 'expense', 'period', 'allocation', 'setting')),
  entity_id  INTEGER NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('oprettet', 'rettet', 'slettet')),
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  before     TEXT,                            -- JSON
  after      TEXT                             -- JSON
);
CREATE INDEX idx_cost_history ON cost_history(entity, entity_id, at);
