-- Job- og forbrugsportal: jobstatus, materialer med priser, arbejdstimer, prisoverslag i
-- versioner og fakturaer med fortløbende numre og kreditnotaer.
--
-- Beløb er i øre ekskl. moms, mængder og timer i tusindedele (1 time = 1000), som i resten af
-- databasen. Migrationen ændrer ingen eksisterende registreringer; nye kolonner får værdier, der
-- passer til det, der allerede er registreret.

-- --- Job ----------------------------------------------------------------------------------------

-- Status for brugeren. jobs.status ('aktiv', 'afsluttet', 'annulleret') styrer stadig lagermotoren:
-- kladde, planlagt, i_gang og afventer er alle 'aktiv'.
ALTER TABLE jobs ADD COLUMN stage TEXT NOT NULL DEFAULT 'planlagt'
  CHECK (stage IN ('kladde', 'planlagt', 'i_gang', 'afventer', 'afsluttet', 'annulleret'));
-- 1 = systemet har sat "Afventer materialer"; stage_prev er status før, så den kan sættes tilbage
ALTER TABLE jobs ADD COLUMN stage_auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN stage_prev TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN description TEXT NOT NULL DEFAULT '';     -- beskrivelse af opgaven
ALTER TABLE jobs ADD COLUMN start_date TEXT NOT NULL DEFAULT '';      -- YYYY-MM-DD
ALTER TABLE jobs ADD COLUMN end_date TEXT NOT NULL DEFAULT '';        -- forventet slutdato
ALTER TABLE jobs ADD COLUMN customer_cvr TEXT NOT NULL DEFAULT '';    -- slutkundens CVR (erhverv)
ALTER TABLE jobs ADD COLUMN customer_contact TEXT NOT NULL DEFAULT '';-- kontaktperson hos slutkunden
ALTER TABLE jobs ADD COLUMN retailer_id INTEGER REFERENCES retailers(id) ON DELETE SET NULL; -- byggemarked for jobbet
ALTER TABLE jobs ADD COLUMN hour_rate INTEGER CHECK (hour_rate IS NULL OR hour_rate >= 0);   -- timepris til slutkunden

UPDATE jobs SET start_date = planned_date WHERE start_date = '';
UPDATE jobs SET stage = CASE
  WHEN status = 'afsluttet' THEN 'afsluttet'
  WHEN status = 'annulleret' THEN 'annulleret'
  WHEN EXISTS (SELECT 1 FROM job_materials m WHERE m.job_id = jobs.id AND (m.issued > 0 OR m.site_used > 0)) THEN 'i_gang'
  ELSE 'planlagt' END;

-- Ansvarlige medarbejdere (jobs.responsible er den primære)
CREATE TABLE job_staff (
  job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  email   TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (job_id, email)
);
INSERT INTO job_staff (job_id, email) SELECT id, responsible FROM jobs WHERE responsible <> '';

-- Hændelser på jobbet, som ikke er lagerbevægelser (overslag, timer, fakturaer, status)
CREATE TABLE job_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  actor_name  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_job_log_job ON job_log(job_id, created_at);

-- --- Materialer i jobbets prisberegning ----------------------------------------------------------
-- Forventede materialer med prisopslag. Forbruget registreres stadig i lagermotoren
-- (job_materials og movements); her ligger forventet mængde, prisgrundlag og salgspris.
CREATE TABLE job_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  product_id        INTEGER REFERENCES products(id),        -- NULL = vare uden varenummer
  cost_basis        TEXT NOT NULL DEFAULT 'byggemarked' CHECK (cost_basis IN ('lager', 'byggemarked')),
  sku               TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL,
  unit              TEXT NOT NULL DEFAULT 'stk.',
  ean               TEXT NOT NULL DEFAULT '',
  mpn               TEXT NOT NULL DEFAULT '',
  brand             TEXT NOT NULL DEFAULT '',
  variant           TEXT NOT NULL DEFAULT '',
  qty               INTEGER NOT NULL CHECK (qty >= 0),      -- forventet forbrug
  used_qty          INTEGER NOT NULL DEFAULT 0 CHECK (used_qty >= 0), -- registreret forbrug (kun varer uden varenummer)
  retailer_id       INTEGER REFERENCES retailers(id) ON DELETE SET NULL, -- byggemarked for linjen
  -- Seneste prisopslag (estimeret materialeomkostning). Prisen tæller kun med, når den er et præcist
  -- match, et godkendt alternativ eller indtastet manuelt. NULL = "Pris mangler".
  price_retailer_id INTEGER REFERENCES retailers(id) ON DELETE SET NULL,     -- byggemarkedet, prisen er fra
  retailer_product_id INTEGER REFERENCES retailer_products(id) ON DELETE SET NULL,
  match             TEXT CHECK (match IS NULL OR match IN ('praecis', 'alternativ')),
  match_basis       TEXT NOT NULL DEFAULT '',
  approved_by       TEXT,
  approved_at       INTEGER,
  found_name        TEXT NOT NULL DEFAULT '',
  url               TEXT NOT NULL DEFAULT '',
  sales_unit        TEXT NOT NULL DEFAULT '',
  pack_qty          INTEGER CHECK (pack_qty IS NULL OR pack_qty > 0),   -- indhold pr. salgsenhed i linjens enhed
  min_qty           INTEGER NOT NULL DEFAULT 1000,
  divisible         INTEGER NOT NULL DEFAULT 0,
  price             INTEGER CHECK (price IS NULL OR price >= 0),        -- øre pr. salgsenhed
  vat               TEXT CHECK (vat IS NULL OR vat IN ('inkl', 'ekskl')),
  price_source      TEXT NOT NULL DEFAULT '',     -- prisfil, side, demodata, manuel
  checked_at        INTEGER,                      -- tidspunkt for seneste prisopslag
  lookup_note       TEXT NOT NULL DEFAULT '',     -- resultat af seneste opslag (fx hvorfor prisen mangler)
  -- Faktisk indkøbspris pr. enhed ekskl. moms, når den kendes (ændrer aldrig en aftalt salgspris)
  actual_cost       INTEGER CHECK (actual_cost IS NULL OR actual_cost >= 0),
  -- Salgspris til slutkunden
  sale_mode         TEXT NOT NULL DEFAULT 'paaslag' CHECK (sale_mode IN ('offentlig', 'paaslag', 'manuel')),
  markup_pct        INTEGER CHECK (markup_pct IS NULL OR markup_pct BETWEEN 0 AND 1000),
  sale_price        INTEGER CHECK (sale_price IS NULL OR sale_price >= 0), -- manuel salgspris pr. enhed
  purchase_line_id  INTEGER REFERENCES purchase_lines(id) ON DELETE SET NULL, -- indkøb af vare uden varenummer
  planned_at        INTEGER,                      -- reserveret/sat på indkøbsliste
  note              TEXT NOT NULL DEFAULT '',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_job_items_job ON job_items(job_id, sort_order);
CREATE UNIQUE INDEX idx_job_items_product ON job_items(job_id, product_id) WHERE product_id IS NOT NULL;

-- Valgt byggemarked på indkøbslinjer (prisestimatet bruger det valgte byggemarked)
ALTER TABLE purchase_lines ADD COLUMN retailer_id INTEGER REFERENCES retailers(id) ON DELETE SET NULL;

-- --- Arbejdstimer og øvrige omkostninger ---------------------------------------------------------

-- Medarbejdertyper med samlet intern timeomkostning og standard timepris til slutkunden
CREATE TABLE labour_types (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  internal_cost  INTEGER CHECK (internal_cost IS NULL OR internal_cost >= 0), -- øre pr. time
  bill_rate      INTEGER CHECK (bill_rate IS NULL OR bill_rate >= 0),         -- øre pr. time
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);
ALTER TABLE users ADD COLUMN labour_type_id INTEGER REFERENCES labour_types(id) ON DELETE SET NULL;

-- Forventede og faktiske timer samt øvrige omkostninger (kørsel, levering, leje ...)
CREATE TABLE job_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('tid', 'omkostning')),
  phase          TEXT NOT NULL CHECK (phase IN ('forventet', 'faktisk')),
  worker_email   TEXT NOT NULL DEFAULT '',
  worker_name    TEXT NOT NULL DEFAULT '',
  worker_type    TEXT NOT NULL DEFAULT '',        -- medarbejdertype, fx Tømrer
  work_date      TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  qty            INTEGER NOT NULL CHECK (qty > 0), -- timer eller antal
  unit           TEXT NOT NULL DEFAULT 'timer',
  internal_cost  INTEGER CHECK (internal_cost IS NULL OR internal_cost >= 0), -- intern omkostning pr. enhed
  unit_price     INTEGER CHECK (unit_price IS NULL OR unit_price >= 0),       -- pris til slutkunden pr. enhed
  billable       INTEGER NOT NULL DEFAULT 1,
  extra          INTEGER NOT NULL DEFAULT 0,      -- ekstraarbejde ud over en aftalt fast pris
  approved_by    TEXT,                            -- faktiske registreringer: godkendt til fakturering
  approved_at    INTEGER,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_job_entries_job ON job_entries(job_id, phase, type);

-- --- Prisoverslag --------------------------------------------------------------------------------
-- Hver gemt version er et låst øjebliksbillede. Senere prisopslag eller ændringer på jobbet ændrer
-- aldrig en gemt version; en ny version gemmes i stedet.
CREATE TABLE job_quotes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  data         TEXT NOT NULL,           -- virksomhed, slutkunde, linjer og forudsætninger (JSON)
  materials    INTEGER NOT NULL,
  labour       INTEGER NOT NULL,
  other        INTEGER NOT NULL,
  subtotal     INTEGER NOT NULL,        -- ekskl. moms
  vat          INTEGER NOT NULL,
  total        INTEGER NOT NULL,        -- inkl. moms
  incomplete   INTEGER NOT NULL DEFAULT 0,  -- linjer uden pris
  note         TEXT NOT NULL DEFAULT '',
  valid_until  TEXT NOT NULL DEFAULT '',
  shared_at    INTEGER,                 -- første download af PDF (delt med slutkunden)
  shared_by    TEXT,
  accepted_at  INTEGER,                 -- markeret som accepteret af slutkunden
  accepted_by  TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (job_id, version)
);

-- --- Fakturaer og kreditnotaer -------------------------------------------------------------------
CREATE TABLE invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL REFERENCES jobs(id),
  kind           TEXT NOT NULL DEFAULT 'faktura' CHECK (kind IN ('faktura', 'kreditnota')),
  status         TEXT NOT NULL DEFAULT 'kladde' CHECK (status IN ('kladde', 'udstedt')),
  number         INTEGER UNIQUE,         -- tildeles ved udstedelse (fortløbende)
  credit_of      INTEGER REFERENCES invoices(id),
  mode           TEXT NOT NULL DEFAULT 'medgaaet' CHECK (mode IN ('medgaaet', 'fast', 'kombination')),
  fixed_amount   INTEGER CHECK (fixed_amount IS NULL OR fixed_amount >= 0),
  quote_id       INTEGER REFERENCES job_quotes(id) ON DELETE SET NULL,
  customer       TEXT NOT NULL DEFAULT '{}',   -- slutkundens oplysninger (låses ved udstedelse)
  company        TEXT NOT NULL DEFAULT '{}',   -- virksomhedens oplysninger (låses ved udstedelse)
  issue_date     TEXT NOT NULL DEFAULT '',
  delivery_date  TEXT NOT NULL DEFAULT '',
  due_date       TEXT NOT NULL DEFAULT '',
  payment_days   INTEGER NOT NULL DEFAULT 8,
  vat_rate       INTEGER NOT NULL DEFAULT 2500, -- hundrededele procent (25 %)
  subtotal       INTEGER NOT NULL DEFAULT 0,
  vat            INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  issued_by      TEXT,
  issued_at      INTEGER,
  CHECK ((status = 'udstedt') = (number IS NOT NULL))
);
CREATE UNIQUE INDEX idx_invoices_draft ON invoices(job_id, kind) WHERE status = 'kladde';
CREATE INDEX idx_invoices_job ON invoices(job_id);

-- Linjer. source_key er det, linjen afregner (fx "lager:12" eller "tid:5"): summen pr. nøgle på
-- udstedte fakturaer minus kreditnotaer er det, der er afregnet, så intet faktureres to gange.
--   include = 1: faktureres;  covered = 1: indeholdt i en aftalt fast pris (afregnet, beløb 0)
CREATE TABLE invoice_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('materiale', 'tid', 'omkostning', 'fastpris')),
  source_key   TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL,
  qty          INTEGER NOT NULL CHECK (qty >= 0),
  unit         TEXT NOT NULL DEFAULT '',
  unit_price   INTEGER CHECK (unit_price IS NULL OR unit_price >= 0), -- ekskl. moms; NULL = pris mangler
  unit_cost    INTEGER,                    -- intern omkostning (vises aldrig for slutkunden)
  include      INTEGER NOT NULL DEFAULT 1,
  covered      INTEGER NOT NULL DEFAULT 0,
  note         TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_key ON invoice_items(source_key);

-- --- Byggemarkeder ---------------------------------------------------------------------------------
-- Gennemgået af Veyro 19. oktober 2026: robots.txt tillader produktsider, vilkårene forbyder ikke
-- automatisk læsning, og prislæseren er afprøvet på en rigtig produktside. Priserne i
-- produktdataene er forbrugerpriser inkl. moms. XL-BYG og Bygma læses ikke (se terms_note).
UPDATE retailers SET access = 'side', terms_confirmed_by = 'Veyro (gennemgang 19. okt. 2026)', terms_confirmed_at = CAST(strftime('%s', 'now') AS INTEGER),
  terms_note = 'Læser offentlige produktsider: robots.txt tillader det, og vilkårene forbyder det ikke. Prisen i produktdataene er inkl. moms. Afprøvet 19. okt. 2026.'
  WHERE key IN ('stark', 'bauhaus', 'silvan', 'davidsen', 'jemogfix') AND access = 'manuel';
UPDATE retailers SET terms_note = 'Kommer senere. Siderne kan læses teknisk, men købsvilkårene kræver en udtrykkelig aftale for anden brug af sidens indhold. Brug produktlink og manuel pris, indtil XL-BYG har givet lov.'
  WHERE key = 'xlbyg' AND access = 'manuel';
UPDATE retailers SET terms_note = 'Kommer senere. Produktsiderne har ingen pris, vi kan stole på (ingen produktdata, og prisfeltet er ufuldstændigt). Brug produktlink og manuel pris.'
  WHERE key = 'bygma' AND access = 'manuel';
