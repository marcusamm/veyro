-- Import af kundeemner fra Excel/CSV med importoversigt, sletning af originalfilen og fortrydelse,
-- samt flere statusser og historik på forespørgsler fra hjemmesiden.
-- Eksisterende kundeemner og forespørgsler bevares uændret.

-- ---------- Importer ----------

CREATE TABLE prospect_imports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name        TEXT NOT NULL,
  file_type        TEXT NOT NULL CHECK (file_type IN ('csv', 'xlsx')),
  file_size        INTEGER NOT NULL,
  file_sha256      TEXT NOT NULL,
  file_deleted_at  INTEGER,                    -- originalfilen er slettet (kundeemnerne bevares)
  file_deleted_by  TEXT,
  status           TEXT NOT NULL DEFAULT 'uploadet'
                   CHECK (status IN ('uploadet', 'importerer', 'importeret', 'delvist_fortrudt', 'fortrudt', 'annulleret')),
  options          TEXT,                       -- JSON: ark, kolonnevalg og valg ved bekræftelsen
  rows_total       INTEGER,
  created_count    INTEGER NOT NULL DEFAULT 0,
  skipped_duplicates INTEGER NOT NULL DEFAULT 0,
  skipped_errors   INTEGER NOT NULL DEFAULT 0,
  skipped_blocked  INTEGER NOT NULL DEFAULT 0,
  undone_count     INTEGER NOT NULL DEFAULT 0,
  uploaded_at      INTEGER NOT NULL,
  uploaded_by      TEXT NOT NULL,
  started_at       INTEGER,                    -- lås mod samtidige bekræftelser
  imported_at      INTEGER,
  imported_by      TEXT,
  undone_at        INTEGER,
  undone_by        TEXT
);
CREATE INDEX idx_prospect_imports_at ON prospect_imports(uploaded_at DESC);

-- Originalfilen i stykker (D1 tillader højst ca. 2 MB pr. række). Slettes med "Slet fil".
CREATE TABLE prospect_import_chunks (
  import_id  INTEGER NOT NULL REFERENCES prospect_imports(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  data       BLOB NOT NULL,
  PRIMARY KEY (import_id, seq)
);

-- Hvert importeret kundeemne kender sin import og rækken i filen. Dubletter, der blot blev genkendt, får ingen import.
ALTER TABLE prospects ADD COLUMN import_id INTEGER;
ALTER TABLE prospects ADD COLUMN import_row INTEGER;
CREATE UNIQUE INDEX idx_prospects_import ON prospects(import_id, import_row) WHERE import_id IS NOT NULL;

-- ---------- Forespørgsler: flere statusser ----------
-- SQLite kan ikke ændre en CHECK-regel, så tabellen genopbygges med de samme kolonner og data.

CREATE TABLE leads_new (
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
  fields TEXT NOT NULL DEFAULT '{}',
  cart TEXT,
  page TEXT,
  status TEXT NOT NULL DEFAULT 'ny'
         CHECK (status IN ('ny', 'besvaret', 'dialog', 'demo', 'proeve', 'tilbud', 'kunde', 'lukket', 'spam')),
  note TEXT,
  offer_id INTEGER,
  notified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO leads_new (id, kind, form_name, name, email, phone, company, website, service, message, fields, cart, page, status, note, offer_id, notified_at, created_at, updated_at)
  SELECT id, kind, form_name, name, email, phone, company, website, service, message, fields, cart, page, status, note, offer_id, notified_at, created_at, updated_at FROM leads;
-- Bevar løbenummeret, så numre på slettede forespørgsler ikke genbruges
INSERT INTO leads_new (id, kind, email, created_at, updated_at)
  SELECT seq, 'kontakt', '-', 0, 0 FROM sqlite_sequence WHERE name = 'leads' AND seq > (SELECT COALESCE(MAX(id), 0) FROM leads);
DELETE FROM leads_new WHERE email = '-' AND created_at = 0 AND updated_at = 0;
DROP TABLE leads;
ALTER TABLE leads_new RENAME TO leads;
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status, created_at DESC);

-- Historik på forespørgsler: statusændringer med tidspunkt og bruger
CREATE TABLE lead_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL,
  kind       TEXT NOT NULL,                    -- status | note
  actor      TEXT,                             -- Veyro-medarbejder (e-mail)
  old_value  TEXT,
  new_value  TEXT
);
CREATE INDEX idx_lead_events_lead ON lead_events(lead_id, at DESC);
