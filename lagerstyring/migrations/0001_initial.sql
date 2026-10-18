-- Lagerstyring: lager, job, vareforbrug, indkøbslister og fakturagrundlag
--
-- Alle mængder gemmes som heltal i tusindedele af varens enhed (1 stk. = 1000), så også
-- meter, liter og kilo kan registreres uden afrundingsfejl. Beløb gemmes i øre.
-- Reglerne for lageret håndhæves af databasen selv (CHECK), så to samtidige registreringer
-- aldrig kan bruge de samme varer, og beholdningen aldrig kan blive negativ: en registrering,
-- der ville bryde reglerne, afvises i sin helhed.

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Brugere og roller: ejer og indkøber har lagerportalen og priser, medarbejdere har forbrugsportalen
CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('ejer', 'indkober', 'medarbejder')),
  alert_mail     INTEGER NOT NULL DEFAULT 0,   -- modtager lageradvarsler på e-mail
  purchase_mail  INTEGER NOT NULL DEFAULT 0,   -- modtager nye indkøbsbehov på e-mail
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  csrf_token  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  reset_at  INTEGER NOT NULL
);

CREATE TABLE suppliers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email           TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  lead_time_days  INTEGER CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365),
  created_at      INTEGER NOT NULL
);

CREATE TABLE products (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sku              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name             TEXT NOT NULL,
  unit             TEXT NOT NULL DEFAULT 'stk.',
  whole_units      INTEGER NOT NULL DEFAULT 1,        -- 1 = håndteres kun i hele enheder (rundes op)
  category         TEXT NOT NULL DEFAULT '',
  supplier_id      INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  lead_time_days   INTEGER CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365),
  avg_daily_usage  INTEGER CHECK (avg_daily_usage IS NULL OR avg_daily_usage >= 0), -- pr. kalenderdag
  safety_method    TEXT CHECK (safety_method IS NULL OR safety_method IN ('antal', 'dage')),
  safety_qty       INTEGER CHECK (safety_qty IS NULL OR safety_qty >= 0),
  buffer_days      INTEGER CHECK (buffer_days IS NULL OR buffer_days BETWEEN 0 AND 365),
  max_stock        INTEGER CHECK (max_stock IS NULL OR max_stock >= 0),       -- ønsket maksimumbeholdning
  purchase_price   INTEGER CHECK (purchase_price IS NULL OR purchase_price >= 0), -- øre pr. enhed
  sale_price       INTEGER CHECK (sale_price IS NULL OR sale_price >= 0),
  -- Fysisk beholdning og samlede reservationer. Reservationer kan aldrig overstige beholdningen,
  -- så den disponible beholdning (stock - reserved) aldrig bliver negativ.
  stock            INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  reserved         INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= stock),
  alert_level      INTEGER NOT NULL DEFAULT 0,        -- seneste advarselsniveau (0 normal, 1 genbestil, 2 kritisk, 3 ingen)
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_products_name ON products(active, name);

CREATE TABLE jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  number            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name              TEXT NOT NULL,
  customer_name     TEXT NOT NULL DEFAULT '',
  customer_email    TEXT NOT NULL DEFAULT '',
  customer_phone    TEXT NOT NULL DEFAULT '',
  customer_address  TEXT NOT NULL DEFAULT '',
  site_address      TEXT NOT NULL DEFAULT '',
  responsible       TEXT NOT NULL DEFAULT '',          -- ansvarlig medarbejder (e-mail)
  planned_date      TEXT NOT NULL DEFAULT '',          -- YYYY-MM-DD
  status            TEXT NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv', 'afsluttet', 'annulleret')),
  markup_pct        INTEGER CHECK (markup_pct IS NULL OR markup_pct BETWEEN 0 AND 1000), -- aftalt avance
  note              TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Et jobs materialer pr. vare. Summerne følges af lagerbevægelserne nedenfor.
CREATE TABLE job_materials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  planned        INTEGER NOT NULL DEFAULT 0 CHECK (planned >= 0),   -- samlet materialebehov
  reserved       INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),  -- reserveret på hovedlageret
  issued         INTEGER NOT NULL DEFAULT 0 CHECK (issued >= 0),    -- udleveret eller brugt fra lageret
  returned       INTEGER NOT NULL DEFAULT 0 CHECK (returned >= 0 AND returned <= issued),
  site_received  INTEGER NOT NULL DEFAULT 0 CHECK (site_received >= 0), -- leveret direkte til arbejdsstedet
  site_used      INTEGER NOT NULL DEFAULT 0 CHECK (site_used >= 0),
  site_returned  INTEGER NOT NULL DEFAULT 0 CHECK (site_returned >= 0 AND site_used + site_returned <= site_received),
  updated_at     INTEGER NOT NULL,
  UNIQUE (job_id, product_id)
);

-- Indkøbslister: én eller flere pr. job, og lister til lageropfyldning (job_id NULL)
CREATE TABLE purchase_lists (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('job', 'lager')),
  name          TEXT NOT NULL,
  responsible   TEXT NOT NULL DEFAULT '',   -- indkøbsansvarlig (e-mail)
  wanted_date   TEXT NOT NULL DEFAULT '',   -- ønsket leveringsdato
  note          TEXT NOT NULL DEFAULT '',
  archived      INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1, -- tælles op ved hver ændring (vises ved afsendelse)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK ((kind = 'job') = (job_id IS NOT NULL))
);

-- Indkøbslinjer. Hver mængde er fordelt på præcis ét formål: et job eller lageropfyldning.
CREATE TABLE purchase_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id        INTEGER NOT NULL REFERENCES purchase_lists(id) ON DELETE CASCADE,
  job_id         INTEGER REFERENCES jobs(id),               -- NULL = lageropfyldning
  product_id     INTEGER REFERENCES products(id),           -- NULL = vare uden varenummer
  sku            TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL,
  unit           TEXT NOT NULL DEFAULT 'stk.',
  supplier_id    INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  qty            INTEGER NOT NULL CHECK (qty > 0),           -- ønsket mængde
  ordered        INTEGER NOT NULL DEFAULT 0 CHECK (ordered >= 0),
  received       INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0 AND received <= ordered),
  unit_price     INTEGER CHECK (unit_price IS NULL OR unit_price >= 0),     -- forventet indkøbspris
  actual_price   INTEGER CHECK (actual_price IS NULL OR actual_price >= 0), -- faktisk pris ved modtagelse
  expected_date  TEXT NOT NULL DEFAULT '',
  order_ref      TEXT NOT NULL DEFAULT '',
  deliver_to     TEXT NOT NULL DEFAULT 'lager' CHECK (deliver_to IN ('lager', 'arbejdssted')),
  ready          INTEGER NOT NULL DEFAULT 0,   -- klar til indkøb
  cancelled      INTEGER NOT NULL DEFAULT 0,
  auto           INTEGER NOT NULL DEFAULT 0,   -- oprettet af systemet ud fra et jobs mangel
  note           TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_purchase_lines_list ON purchase_lines(list_id);
CREATE INDEX idx_purchase_lines_product ON purchase_lines(product_id, cancelled);
-- Højst én automatisk kladdelinje pr. job og vare: den opdateres i stedet for at blive oprettet igen
CREATE UNIQUE INDEX idx_purchase_lines_auto ON purchase_lines(job_id, product_id)
  WHERE auto = 1 AND ordered = 0 AND ready = 0 AND cancelled = 0;

-- Engangsnøgler for registreringer: samme formular kan kun gennemføres én gang
-- (dobbeltklik og genindlæsning afvises af databasen).
CREATE TABLE ops (
  token       TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Alle lagerbevægelser og ændringer på job: tidspunkt, medarbejder, mængde, årsag og job
CREATE TABLE movements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER REFERENCES products(id),
  job_id            INTEGER REFERENCES jobs(id),
  purchase_line_id  INTEGER REFERENCES purchase_lines(id),
  kind              TEXT NOT NULL,
  qty               INTEGER NOT NULL DEFAULT 0,  -- mængden, registreringen handlede om
  stock_delta       INTEGER NOT NULL DEFAULT 0,  -- ændring i fysisk beholdning
  reserved_delta    INTEGER NOT NULL DEFAULT 0,  -- ændring i reservationer
  stock_after       INTEGER,
  reserved_after    INTEGER,
  unit_cost         INTEGER,                     -- indkøbspris pr. enhed på tidspunktet (øre)
  reason            TEXT NOT NULL DEFAULT '',
  actor             TEXT NOT NULL,
  actor_name        TEXT NOT NULL DEFAULT '',
  op                TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_movements_product ON movements(product_id, created_at);
CREATE INDEX idx_movements_job ON movements(job_id, created_at);
CREATE INDEX idx_movements_created ON movements(created_at);

-- Lageradvarsler og afvigelser til ejer/indkøber
CREATE TABLE notices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK (kind IN ('lager', 'afvigelse')),
  level        INTEGER NOT NULL DEFAULT 0,
  product_id   INTEGER REFERENCES products(id),
  job_id       INTEGER REFERENCES jobs(id),
  message      TEXT NOT NULL,
  open         INTEGER NOT NULL DEFAULT 1,
  mail_id      INTEGER,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER
);
CREATE INDEX idx_notices_open ON notices(open, kind, created_at);
CREATE UNIQUE INDEX idx_notices_deviation ON notices(job_id, product_id) WHERE kind = 'afvigelse' AND open = 1;

-- Udsendte e-mails (og simulerede, når e-mail ikke er sat op). Login-mails gemmes ikke.
CREATE TABLE mails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body_text     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('sendt', 'simuleret', 'fejlet')),
  list_id       INTEGER REFERENCES purchase_lists(id) ON DELETE SET NULL,
  list_version  INTEGER,
  actor         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_mails_list ON mails(list_id, created_at);

-- Fakturagrundlag: en kladde kan justeres; ved godkendelse fastfryses mængder og priser
CREATE TABLE invoice_bases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL REFERENCES jobs(id),
  status         TEXT NOT NULL DEFAULT 'kladde' CHECK (status IN ('kladde', 'godkendt')),
  customer       TEXT NOT NULL DEFAULT '{}',   -- øjebliksbillede af job og kunde (JSON)
  note           TEXT NOT NULL DEFAULT '',
  total_cost     INTEGER NOT NULL DEFAULT 0,
  total_sale     INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  approved_by    TEXT,
  approved_at    INTEGER
);
CREATE UNIQUE INDEX idx_invoice_draft ON invoice_bases(job_id) WHERE status = 'kladde';

CREATE TABLE invoice_lines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  basis_id          INTEGER NOT NULL REFERENCES invoice_bases(id) ON DELETE CASCADE,
  source            TEXT NOT NULL CHECK (source IN ('lager', 'arbejdssted', 'direkte')),
  product_id        INTEGER REFERENCES products(id),
  purchase_line_id  INTEGER REFERENCES purchase_lines(id),
  sku               TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL,
  unit              TEXT NOT NULL,
  qty               INTEGER NOT NULL CHECK (qty >= 0),
  unit_cost         INTEGER NOT NULL DEFAULT 0,
  unit_price        INTEGER NOT NULL DEFAULT 0,
  include           INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_invoice_lines_basis ON invoice_lines(basis_id);
