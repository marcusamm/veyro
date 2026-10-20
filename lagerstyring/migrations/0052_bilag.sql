-- Bilag (kvitteringer, leverandørfakturaer og kreditnotaer), fordeling på job, lager og drift,
-- betalinger på fakturaer, returer, eksport til bogholder og opsætningsguide.
--
-- Migrationen tilføjer kun nye tabeller og kolonner. Intet eksisterende ændres eller slettes.
-- Beløb er i øre, mængder i tusindedele, som i resten af databasen.

-- --- Filer --------------------------------------------------------------------------------------
-- Hver fil gemmes én gang (samme indhold = samme sha256), også når den bruges af flere bilag eller
-- job. Originalen gemmes uændret i stykker á højst 1 MB; en konverteret kopi til visning (fx et
-- HEIC-billede som JPG) er en selvstændig fil og ændrer aldrig originalen.
CREATE TABLE files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256      TEXT NOT NULL UNIQUE,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK (size > 0),
  pages       INTEGER,                       -- antal sider i en PDF
  chunks      INTEGER NOT NULL CHECK (chunks > 0),
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE file_chunks (
  file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  data     BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
);

-- --- Bilag --------------------------------------------------------------------------------------
-- Status:   modtaget → under_aflaesning → klar (til gennemgang) / afklaring → godkendt → arkiveret
-- Betaling: følges for sig (virksomhed, medarbejder = udlæg, ikke_betalt, uafklaret)
-- version tælles op, når et godkendt bilag ændres; det kræver så ny godkendelse.
CREATE TABLE bilag (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type         TEXT NOT NULL DEFAULT 'kvittering' CHECK (doc_type IN ('kvittering', 'faktura', 'kreditnota', 'andet')),
  file_id          INTEGER NOT NULL REFERENCES files(id),
  file_name        TEXT NOT NULL,
  preview_file_id  INTEGER REFERENCES files(id),
  status           TEXT NOT NULL DEFAULT 'modtaget'
                   CHECK (status IN ('modtaget', 'under_aflaesning', 'klar', 'afklaring', 'godkendt', 'arkiveret')),
  version          INTEGER NOT NULL DEFAULT 1,
  -- Oplysninger fra originalbilaget (aflæst eller registreret manuelt)
  supplier_name    TEXT NOT NULL DEFAULT '',
  supplier_cvr     TEXT NOT NULL DEFAULT '',
  supplier_id      INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  doc_number       TEXT NOT NULL DEFAULT '',
  doc_date         TEXT NOT NULL DEFAULT '',      -- YYYY-MM-DD
  due_date         TEXT NOT NULL DEFAULT '',
  currency         TEXT NOT NULL DEFAULT 'DKK',
  net              INTEGER,                       -- ekskl. moms; NULL = ikke angivet
  vat              INTEGER,
  total            INTEGER,                       -- inkl. moms
  rounding         INTEGER NOT NULL DEFAULT 0,    -- øreafrunding på originalen
  line_prices      TEXT NOT NULL DEFAULT 'ekskl' CHECK (line_prices IN ('ekskl', 'inkl')), -- varelinjernes priser er ekskl. eller inkl. moms
  payment_info     TEXT NOT NULL DEFAULT '',
  uncertain        TEXT NOT NULL DEFAULT '[]',    -- felter, aflæsningen var usikker på (JSON)
  reading_source   TEXT NOT NULL DEFAULT '' CHECK (reading_source IN ('', 'pdf-tekst', 'manuel', 'simuleret')),
  reading_note     TEXT NOT NULL DEFAULT '',
  -- Betaling og udlæg (systemet betaler aldrig noget)
  payment          TEXT NOT NULL DEFAULT 'uafklaret' CHECK (payment IN ('virksomhed', 'medarbejder', 'ikke_betalt', 'uafklaret')),
  paid_by          TEXT NOT NULL DEFAULT '',      -- medarbejderens e-mail ved udlæg
  reimbursed_at    INTEGER,
  reimbursed_by    TEXT,
  -- Interne oplysninger (ikke fra originalen)
  job_hint         INTEGER REFERENCES jobs(id) ON DELETE SET NULL,   -- jobbet, bilaget blev uploadet fra
  origin           TEXT NOT NULL DEFAULT '',      -- job, indkob, oversigt, retur
  credit_of        INTEGER REFERENCES bilag(id) ON DELETE SET NULL,  -- leverandørens kreditnota krediterer dette bilag
  note             TEXT NOT NULL DEFAULT '',
  clarify          TEXT NOT NULL DEFAULT '',      -- hvad der skal afklares
  dup_of           INTEGER REFERENCES bilag(id) ON DELETE SET NULL,
  dup_reason       TEXT NOT NULL DEFAULT '',
  dup_cleared_by   TEXT,                          -- "Ikke en dublet" bekræftet af
  approved_by      TEXT,
  approved_at      INTEGER,
  approved_version INTEGER,
  exported_version INTEGER,
  exported_at      INTEGER,
  export_id        INTEGER,
  export_failed    INTEGER NOT NULL DEFAULT 0,
  uploaded_by      TEXT NOT NULL,
  uploaded_name    TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_bilag_status ON bilag(status, created_at);
CREATE INDEX idx_bilag_file ON bilag(file_id);
CREATE INDEX idx_bilag_supplier ON bilag(supplier_cvr, doc_number);
CREATE INDEX idx_bilag_uploader ON bilag(uploaded_by);

-- Varelinjer fra originalen
CREATE TABLE bilag_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bilag_id    INTEGER NOT NULL REFERENCES bilag(id) ON DELETE CASCADE,
  pos         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  qty         INTEGER,                         -- tusindedele
  unit        TEXT NOT NULL DEFAULT '',
  unit_price  INTEGER,                         -- ekskl. moms
  discount    INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  amount      INTEGER,                         -- linjebeløb ekskl. moms efter rabat
  vat_rate    INTEGER,                         -- hundrededele procent (2500 = 25 %); NULL = ikke angivet
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_state TEXT NOT NULL DEFAULT '' CHECK (product_state IN ('', 'forslag', 'godkendt')),
  uncertain   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_bilag_lines ON bilag_lines(bilag_id, pos);

-- Fordeling af bilagets beløb (ekskl. moms) på job, lager og almindelig drift. Selve fordelingen
-- ændrer aldrig lageret: en varemodtagelse eller et direkte køb til et job registreres først, når
-- nogen bevidst trykker på knappen (done_at).
--   eksisterende  = knyttet til et eksisterende køb/varemodtagelse (purchase_line_id)
--   ny_modtagelse = ny varemodtagelse på lageret (evt. reserveret til jobbet)
--   direkte_job   = købt direkte til jobbet (leveret til arbejdsstedet, ikke på hovedlageret)
--   udgift        = udgift uden lagerpåvirkning
CREATE TABLE bilag_allocations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  bilag_id          INTEGER NOT NULL REFERENCES bilag(id) ON DELETE CASCADE,
  line_id           INTEGER REFERENCES bilag_lines(id) ON DELETE CASCADE,  -- NULL = fordelt på beløb
  target            TEXT NOT NULL CHECK (target IN ('job', 'lager', 'drift')),
  job_id            INTEGER REFERENCES jobs(id),
  amount            INTEGER NOT NULL CHECK (amount >= 0),
  action            TEXT NOT NULL DEFAULT 'udgift' CHECK (action IN ('eksisterende', 'ny_modtagelse', 'direkte_job', 'udgift')),
  purchase_line_id  INTEGER REFERENCES purchase_lines(id) ON DELETE SET NULL,
  product_id        INTEGER REFERENCES products(id) ON DELETE SET NULL,
  qty               INTEGER CHECK (qty IS NULL OR qty > 0),
  match_state       TEXT NOT NULL DEFAULT '' CHECK (match_state IN ('', 'forslag', 'godkendt')),
  done_at           INTEGER,
  done_by           TEXT,
  note              TEXT NOT NULL DEFAULT '',
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  CHECK ((target = 'job') = (job_id IS NOT NULL))
);
CREATE INDEX idx_bilag_alloc ON bilag_allocations(bilag_id);
CREATE INDEX idx_bilag_alloc_job ON bilag_allocations(job_id);

-- Historik: aflæsning, rettelser, fordelinger, godkendelser, betaling og eksport
CREATE TABLE bilag_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bilag_id    INTEGER NOT NULL REFERENCES bilag(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  actor_name  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_bilag_events ON bilag_events(bilag_id, created_at);

-- --- Betalinger på udstedte fakturaer -----------------------------------------------------------
-- Registreres manuelt. Det er ikke en bankafstemning. Et negativt beløb er en tilbagebetaling.
CREATE TABLE invoice_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id),
  paid_on     TEXT NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount <> 0),
  currency    TEXT NOT NULL DEFAULT 'DKK',
  method      TEXT NOT NULL CHECK (method IN ('bankoverforsel', 'mobilepay', 'kort', 'kontant', 'modregning', 'andet')),
  reference   TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  deleted_by  TEXT,
  deleted_at  INTEGER
);
CREATE INDEX idx_invoice_payments ON invoice_payments(invoice_id);

-- Udkast til betalingspåmindelser (kun PDF; intet sendes, ingen gebyrer eller renter)
CREATE TABLE invoice_reminders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id),
  outstanding  INTEGER NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

ALTER TABLE invoices ADD COLUMN exported_at INTEGER;
ALTER TABLE invoices ADD COLUMN export_id INTEGER;

-- --- Returer ------------------------------------------------------------------------------------
-- Fysiske returer. Den økonomiske kreditering (leverandørens kreditnota eller en kreditnota til
-- slutkunden) er en selvstændig hændelse, som kun knyttes hertil.
--   job_lager  = fra et job tilbage til eget lager (kun brugbare varer bliver salgbare igen)
--   leverandor = retur til leverandør fra et køb
CREATE TABLE returns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL CHECK (kind IN ('job_lager', 'leverandor')),
  job_id            INTEGER REFERENCES jobs(id),
  product_id        INTEGER REFERENCES products(id),
  purchase_line_id  INTEGER REFERENCES purchase_lines(id),
  name              TEXT NOT NULL,
  unit              TEXT NOT NULL DEFAULT '',
  qty               INTEGER NOT NULL CHECK (qty > 0),
  condition         TEXT NOT NULL DEFAULT '' CHECK (condition IN ('', 'brugbar', 'beskadiget')),
  location          TEXT NOT NULL DEFAULT '',     -- lager eller arbejdssted
  credit_state      TEXT NOT NULL DEFAULT '' CHECK (credit_state IN ('', 'afventer', 'modtaget', 'ikke_relevant', 'vurder')),
  credit_bilag_id   INTEGER REFERENCES bilag(id) ON DELETE SET NULL,
  invoice_id        INTEGER REFERENCES invoices(id),
  amount            INTEGER,                      -- forventet kredit ekskl. moms
  note              TEXT NOT NULL DEFAULT '',
  created_by        TEXT NOT NULL,
  created_name      TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_returns ON returns(kind, created_at);

-- --- Eksport til bogholder ----------------------------------------------------------------------
CREATE TABLE exports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  scope          TEXT NOT NULL CHECK (scope IN ('periode', 'job')),
  date_from      TEXT NOT NULL DEFAULT '',
  date_to        TEXT NOT NULL DEFAULT '',
  job_id         INTEGER REFERENCES jobs(id),
  with_views     INTEGER NOT NULL DEFAULT 0,
  bilag_count    INTEGER NOT NULL DEFAULT 0,
  invoice_count  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'eksporteret' CHECK (status IN ('eksporteret', 'fejlet')),
  error          TEXT NOT NULL DEFAULT '',
  file_id        INTEGER REFERENCES files(id),   -- den dannede ZIP-fil (kan hentes igen uændret)
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

-- Hvad en eksport indeholdt, i hvilken version, og rækken som den så ud i oversigten
CREATE TABLE export_items (
  export_id  INTEGER NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('bilag', 'faktura')),
  ref_id     INTEGER NOT NULL,
  version    INTEGER NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (export_id, kind, ref_id)
);
CREATE INDEX idx_export_items_ref ON export_items(kind, ref_id);
