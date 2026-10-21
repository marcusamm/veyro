-- Digitale fortrolighedsaftaler (NDA) i kundeportalen (se docs/FORTROLIGHEDSAFTALER.md).
-- Kun nye tabeller; eksisterende data røres ikke. Veyros oplysninger hentes fra poa_settings (fælles med fuldmagter).

-- Standardskabelonen. En ny version bruges kun til nye aftaler; eksisterende aftaler har deres egen kopi af teksten.
CREATE TABLE nda_templates (
  version     INTEGER PRIMARY KEY,
  body        TEXT NOT NULL,
  footnote    TEXT NOT NULL DEFAULT '',
  note        TEXT,                                 -- Veyros interne bemærkning til versionen
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL
);

-- Én række pr. aftale. Status er aftalens gyldighed; sletning holdes adskilt.
CREATE TABLE ndas (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  number           TEXT NOT NULL UNIQUE,            -- fx NDA-2026-0001
  customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN ('draft', 'awaiting_customer', 'awaiting_veyro', 'active', 'terminated')),
  deletion_status  TEXT NOT NULL DEFAULT 'none' CHECK (deletion_status IN ('none', 'requested', 'retained')),
  current_version  INTEGER NOT NULL DEFAULT 1,
  company_name     TEXT,                            -- til lister; kopi fra den aktuelle version
  project          TEXT,
  effective_at     INTEGER,                         -- ikrafttræden = sidste godkendelse
  -- Ophør for fremtidig udveksling
  terminated_at    INTEGER,
  terminated_by    TEXT,                            -- kontoens e-mail
  terminated_party TEXT CHECK (terminated_party IN ('kunde', 'veyro')),
  termination_notice TEXT,                          -- den skriftlige meddelelse, som den er sendt til modparten
  -- Samarbejdets ophør registreres særskilt (bruges til den vejledende femårsfrist)
  cooperation      TEXT NOT NULL DEFAULT 'unknown' CHECK (cooperation IN ('unknown', 'ongoing', 'ended', 'never_started')),
  cooperation_ended_on TEXT,                        -- YYYY-MM-DD
  cooperation_updated_at INTEGER,
  cooperation_updated_by TEXT,
  retain_until     INTEGER,                         -- sat, når dokumentation opbevares efter en sletteanmodning
  idem_key         TEXT UNIQUE,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_ndas_customer ON ndas(customer_id, created_at);
CREATE INDEX idx_ndas_status ON ndas(status, updated_at);

-- Ophør kan ikke fortrydes
CREATE TRIGGER ndas_no_reactivation BEFORE UPDATE OF status ON ndas
WHEN OLD.status = 'terminated' AND NEW.status != 'terminated'
BEGIN
  SELECT RAISE(ABORT, 'En ophørt fortrolighedsaftale kan ikke genaktiveres');
END;

-- Versioner. Formularen kan ændres, mens versionen er kladde. Når den sendes til godkendelse, gemmes den præcise
-- tekst og alle oplysninger i snapshot_json. Efter første godkendelse kan versionen ikke ændres; en ændring er en ny version.
CREATE TABLE nda_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  nda_id           INTEGER NOT NULL REFERENCES ndas(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('draft', 'sent', 'approved', 'superseded')),
  form_json        TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  snapshot_json    TEXT,
  content_hash     TEXT,                            -- SHA-256 af snapshot_json
  sent_at          INTEGER,
  sent_by          TEXT,
  customer_name    TEXT,
  customer_title   TEXT,
  customer_company TEXT,
  customer_email   TEXT,                            -- den indloggede konto, der godkendte
  customer_method  TEXT,
  customer_approved_at INTEGER,
  veyro_name       TEXT,
  veyro_title      TEXT,
  veyro_company    TEXT,
  veyro_email      TEXT,
  veyro_method     TEXT,
  veyro_approved_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (nda_id, version)
);

-- Når én part har godkendt, er teksten og oplysningerne låst
CREATE TRIGGER nda_versions_locked BEFORE UPDATE OF snapshot_json, content_hash, form_json, template_version, version, nda_id ON nda_versions
WHEN OLD.customer_approved_at IS NOT NULL OR OLD.veyro_approved_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'En godkendt version af fortrolighedsaftalen kan ikke ændres');
END;

-- En godkendelse kan ikke ændres eller fjernes
CREATE TRIGGER nda_versions_customer_approval BEFORE UPDATE OF customer_name, customer_title, customer_company, customer_email, customer_method, customer_approved_at ON nda_versions
WHEN OLD.customer_approved_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Kundens godkendelse kan ikke ændres');
END;
CREATE TRIGGER nda_versions_veyro_approval BEFORE UPDATE OF veyro_name, veyro_title, veyro_company, veyro_email, veyro_method, veyro_approved_at ON nda_versions
WHEN OLD.veyro_approved_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Veyros godkendelse kan ikke ændres');
END;

-- Gemte PDF'er: den endelige aftale og kvitteringen for ophør. Laves én gang ud fra de gemte data.
CREATE TABLE nda_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nda_id      INTEGER NOT NULL REFERENCES ndas(id) ON DELETE CASCADE,
  version_id  INTEGER REFERENCES nda_versions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('final', 'termination')),
  sha256      TEXT NOT NULL,
  pdf         BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (nda_id, kind)
);

-- Engangskoder til godkendelse (kun hash gemmes). Én pr. version og part.
CREATE TABLE nda_otps (
  version_id  INTEGER NOT NULL REFERENCES nda_versions(id) ON DELETE CASCADE,
  party       TEXT NOT NULL CHECK (party IN ('kunde', 'veyro')),
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (version_id, party)
);

-- Hændelsesforløb. Aktøren er "kunde", "system" eller en Veyro-medarbejders e-mail; detail uden personoplysninger.
CREATE TABLE nda_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nda_id      INTEGER NOT NULL REFERENCES ndas(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  type        TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX idx_nda_events_nda ON nda_events(nda_id, at);

-- Anmodninger: sletning af aftaledokumentet og tilbagelevering/sletning af delte oplysninger.
-- Overlever selve aftalen, så kunden kan se resultatet.
CREATE TABLE nda_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  nda_id          INTEGER,                          -- NULL når aftalen er slettet
  nda_label       TEXT NOT NULL,                    -- fx "NDA-2026-0001"
  kind            TEXT NOT NULL CHECK (kind IN ('delete_document', 'return_info')),
  choice          TEXT CHECK (choice IN ('return', 'delete')),   -- kun return_info
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_progress', 'completed', 'retained', 'rejected')),
  result_text     TEXT,
  retained_info   TEXT,
  retention_reason TEXT,
  retain_until    INTEGER,
  idem_key        TEXT UNIQUE,
  requested_by    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  handled_at      INTEGER,
  handled_by      TEXT
);
CREATE INDEX idx_nda_requests_customer ON nda_requests(customer_id, created_at);
CREATE INDEX idx_nda_requests_status ON nda_requests(status, created_at);

CREATE TABLE nda_request_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES nda_requests(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  type        TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX idx_nda_request_events ON nda_request_events(request_id, at);

-- Udgående mails og meddelelser med ærlig leveringsstatus. Kan sendes igen uden at oprette noget nyt.
CREATE TABLE nda_mails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nda_id        INTEGER REFERENCES ndas(id) ON DELETE CASCADE,
  request_id    INTEGER REFERENCES nda_requests(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'not_configured')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  sent_at       INTEGER
);
CREATE INDEX idx_nda_mails_status ON nda_mails(status, created_at);
CREATE INDEX idx_nda_mails_nda ON nda_mails(nda_id);

-- Administrative opgaver til Veyro (fx en ophørsmeddelelse, der ikke kunne leveres)
CREATE TABLE nda_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nda_id      INTEGER REFERENCES ndas(id) ON DELETE CASCADE,
  mail_id     INTEGER REFERENCES nda_mails(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  note        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at  INTEGER NOT NULL,
  done_at     INTEGER,
  done_by     TEXT,
  UNIQUE (mail_id, kind)
);
CREATE INDEX idx_nda_tasks_open ON nda_tasks(status, created_at);
