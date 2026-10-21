-- Digitale fuldmagter i kundeportalen (se docs/FULDMAGTER.md).
-- Kun nye tabeller; eksisterende data røres ikke.

-- Veyros egne oplysninger og funktionens indstillinger (redigeres i admin, ét sted).
-- Kun oplysninger, der allerede står på veyro.dk, er udfyldt. Juridisk navn og kontaktperson udfyldes af Veyro.
CREATE TABLE poa_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
INSERT INTO poa_settings (key, value, updated_at) VALUES
  ('veyro_legal_name', '', 0),
  ('veyro_cvr', '46857569', 0),
  ('veyro_address', 'Albert Ibsensvej 28, 2. tv, 4200 Slagelse', 0),
  ('veyro_contact_name', '', 0),
  ('veyro_contact_email', 'kontakt@veyro.dk', 0),
  ('require_veyro_acceptance', '1', 0),
  ('text_approved', '0', 0),
  ('launched', '0', 0),
  ('pilot_emails', '', 0);

-- Én række pr. fuldmagtsversion. En ændring af en godkendt fuldmagt er en ny række med samme nummer og version + 1.
CREATE TABLE poas (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  number           TEXT NOT NULL,                  -- fx FM-2026-0001 (fælles for alle versioner)
  version          INTEGER NOT NULL DEFAULT 1,
  customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- Gyldighed: kladde, afventer Veyros accept, aktiv, tilbagekaldt, udløbet
  status           TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'active', 'revoked', 'expired')),
  -- Sletning holdes adskilt fra gyldigheden
  deletion_status  TEXT NOT NULL DEFAULT 'none' CHECK (deletion_status IN ('none', 'requested', 'retained')),
  company_name     TEXT,                           -- til listen; kopi fra formularen
  project          TEXT,
  expires_on       TEXT,                           -- YYYY-MM-DD (gyldig til og med dagen, dansk tid)
  draft_json       TEXT,                           -- formularens indhold, mens den er kladde
  idem_key         TEXT UNIQUE,                    -- forhindrer dubletter ved dobbeltklik
  -- Godkendt version (skrives én gang, derefter låst af triggeren nedenfor)
  snapshot_json    TEXT,
  content_hash     TEXT,                           -- SHA-256 af snapshot_json
  text_version     TEXT,
  approver_name    TEXT,
  approver_title   TEXT,
  approver_email   TEXT,                           -- den indloggede konto, der godkendte
  approval_method  TEXT,
  approved_at      INTEGER,
  veyro_accepted_at INTEGER,
  veyro_accepted_by TEXT,
  activated_at     INTEGER,
  revoked_at       INTEGER,
  expired_at       INTEGER,
  retain_until     INTEGER,                        -- sat, når data opbevares efter en sletteanmodning
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (number, version)
);
CREATE INDEX idx_poas_customer ON poas(customer_id, created_at);
CREATE INDEX idx_poas_status ON poas(status, expires_on);

-- En godkendt version kan ikke ændres
CREATE TRIGGER poas_snapshot_locked BEFORE UPDATE OF snapshot_json, content_hash, text_version, approver_name, approver_title,
  approver_email, approval_method, approved_at, company_name, project, expires_on, number, version, customer_id ON poas
WHEN OLD.snapshot_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'En godkendt fuldmagt kan ikke ændres');
END;

-- Tilbagekaldt eller udløbet kan ikke genaktiveres
CREATE TRIGGER poas_no_reactivation BEFORE UPDATE OF status ON poas
WHEN OLD.status IN ('revoked', 'expired') AND NEW.status != OLD.status
BEGIN
  SELECT RAISE(ABORT, 'En tilbagekaldt eller udløbet fuldmagt kan ikke genaktiveres');
END;

-- Gemte PDF'er. Laves én gang ud fra den godkendte version og ændres aldrig.
CREATE TABLE poa_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  poa_id      INTEGER NOT NULL REFERENCES poas(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('approved', 'activated')),
  sha256      TEXT NOT NULL,
  pdf         BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (poa_id, kind)
);

-- Engangskoder til godkendelse (kun hash gemmes)
CREATE TABLE poa_otps (
  poa_id      INTEGER PRIMARY KEY REFERENCES poas(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Hændelsesforløb. Ingen personoplysninger i detail; aktøren er "kunde", "system" eller en Veyro-medarbejders e-mail.
CREATE TABLE poa_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  poa_id      INTEGER NOT NULL REFERENCES poas(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  type        TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX idx_poa_events_poa ON poa_events(poa_id, at);

-- Sletteanmodninger. Overlever selve fuldmagten, så kunden kan se resultatet.
CREATE TABLE poa_deletion_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  poa_id        INTEGER,                            -- NULL når fuldmagten er slettet
  poa_label     TEXT NOT NULL,                      -- fx "FM-2026-0001 v1"
  status        TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'retained', 'completed')),
  requested_at  INTEGER NOT NULL,
  handled_at    INTEGER,
  handled_by    TEXT,
  result_text   TEXT,
  retain_until  INTEGER
);
CREATE INDEX idx_poa_del_customer ON poa_deletion_requests(customer_id, requested_at);

-- Udgående mails (kvitteringer og beskeder til Veyro). Kan sendes igen uden at oprette en ny fuldmagt.
CREATE TABLE poa_mails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  poa_id        INTEGER REFERENCES poas(id) ON DELETE CASCADE,
  deletion_request_id INTEGER REFERENCES poa_deletion_requests(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'not_configured')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  sent_at       INTEGER
);
CREATE INDEX idx_poa_mails_status ON poa_mails(status, created_at);
CREATE INDEX idx_poa_mails_poa ON poa_mails(poa_id);

-- Handlinger, Veyro udfører eller planlægger under en fuldmagt. Kontrolleres mod fuldmagten på serveren.
CREATE TABLE poa_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  poa_id        INTEGER NOT NULL REFERENCES poas(id) ON DELETE CASCADE,
  power         TEXT NOT NULL,
  party         TEXT NOT NULL,                       -- leverandør, system eller konto
  description   TEXT NOT NULL,
  amount_oere   INTEGER,                             -- kun bestillinger, inkl. moms
  status        TEXT NOT NULL CHECK (status IN ('planned', 'done', 'cancelled')),
  planned_for   TEXT,                                -- YYYY-MM-DD for planlagte handlinger
  month_key     TEXT NOT NULL,                       -- YYYY-MM (dansk tid) til månedsgrænsen for bestillinger
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  done_at       INTEGER,
  cancelled_at  INTEGER,
  cancel_reason TEXT
);
CREATE INDEX idx_poa_actions_poa ON poa_actions(poa_id, status);

-- Opfølgning efter tilbagekaldelse: Veyros opgaver og underretning af tredjeparter
CREATE TABLE poa_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  poa_id        INTEGER NOT NULL REFERENCES poas(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('followup', 'third_party')),
  party         TEXT,
  responsible   TEXT NOT NULL CHECK (responsible IN ('veyro', 'kunde')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  note          TEXT,
  created_at    INTEGER NOT NULL,
  done_at       INTEGER,
  done_by       TEXT
);
CREATE INDEX idx_poa_tasks_open ON poa_tasks(status, created_at);
