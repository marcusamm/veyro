-- Kasse (point of sale) i Veyros admin: ydelser og varer, kassesalg med betalinger, refusioner,
-- medarbejdere med roller og en revisionslog. Alle beløb er i øre og inkl. moms.

-- Ydelser og varer, der kan sælges i kassen. Lager er valgfrit pr. vare (track_stock = 1).
-- CHECK (stock >= 0) er den sidste vagt mod oversalg: et salg, der ville gøre lageret negativt,
-- afbryder hele databasebatchen, så intet bliver gemt.
CREATE TABLE pos_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sku          TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- varenummer
  barcode      TEXT,                                  -- stregkode (EAN/GTIN), gemt som tekst
  name         TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  price        INTEGER NOT NULL CHECK (price >= 0),   -- øre inkl. moms
  unit         TEXT NOT NULL DEFAULT 'stk.',
  track_stock  INTEGER NOT NULL DEFAULT 0,
  stock        INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  image_type   TEXT,                                  -- image/png, image/jpeg eller image/webp
  image        BLOB,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_pos_items_barcode ON pos_items(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_pos_items_active ON pos_items(active, category, sort_order);

-- Et kassesalg er en ordre med eget løbenummer. source = 'kasse' markerer, at den er oprettet i kassen.
CREATE TABLE pos_sales (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  number          INTEGER NOT NULL UNIQUE,
  -- Engangsnøgle fra kassen: samme nøgle to gange (dobbeltklik, netværksfejl) giver samme salg
  client_key      TEXT NOT NULL UNIQUE,
  source          TEXT NOT NULL DEFAULT 'kasse',
  status          TEXT NOT NULL
                  CHECK (status IN ('afventer', 'betalt', 'delvist_refunderet', 'refunderet', 'annulleret')),
  staff_email     TEXT NOT NULL,
  customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name   TEXT NOT NULL DEFAULT '',
  customer_email  TEXT NOT NULL DEFAULT '',
  customer_phone  TEXT NOT NULL DEFAULT '',
  company         TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  subtotal        INTEGER NOT NULL,                  -- før rabat
  discount        INTEGER NOT NULL DEFAULT 0,        -- linjerabatter + rabat på hele salget
  total           INTEGER NOT NULL,                  -- efter rabat, før øreafrunding
  vat_amount      INTEGER NOT NULL,                  -- moms indeholdt i total
  vat_rate_bp     INTEGER NOT NULL,                  -- momssats i basispoint (2500 = 25 %)
  rounding        INTEGER NOT NULL DEFAULT 0,        -- øreafrunding af kontantbetaling (+/- øre)
  order_discount_type   TEXT CHECK (order_discount_type IN ('pct', 'amount')),
  order_discount_value  INTEGER,                     -- basispoint ved pct, øre ved amount
  discount_approved_by  TEXT,                        -- e-mail på den, der godkendte en stor rabat
  refunded        INTEGER NOT NULL DEFAULT 0,        -- refunderet i alt (øre)
  stock_deducted  INTEGER NOT NULL DEFAULT 0,
  completed_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_pos_sales_created ON pos_sales(created_at);
CREATE INDEX idx_pos_sales_staff ON pos_sales(staff_email, created_at);
CREATE INDEX idx_pos_sales_status ON pos_sales(status, created_at);
CREATE INDEX idx_pos_sales_customer ON pos_sales(customer_id);

-- Linjens nettobeløb = line_total - line_discount - order_discount
CREATE TABLE pos_sale_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id         INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  item_id         INTEGER REFERENCES pos_items(id) ON DELETE SET NULL,
  sku             TEXT NOT NULL,
  name            TEXT NOT NULL,
  unit            TEXT NOT NULL,
  unit_price      INTEGER NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  line_total      INTEGER NOT NULL,
  line_discount   INTEGER NOT NULL DEFAULT 0,
  order_discount  INTEGER NOT NULL DEFAULT 0,
  track_stock     INTEGER NOT NULL DEFAULT 0          -- varen havde lagerstyring ved salget
);
CREATE INDEX idx_pos_sale_lines_sale ON pos_sale_lines(sale_id);
CREATE INDEX idx_pos_sale_lines_item ON pos_sale_lines(item_id);

CREATE TABLE pos_stock_movements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES pos_items(id) ON DELETE CASCADE,
  change       INTEGER NOT NULL,
  stock_after  INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  sale_id      INTEGER REFERENCES pos_sales(id) ON DELETE SET NULL,
  actor        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_pos_stock_movements_item ON pos_stock_movements(item_id, created_at);

CREATE TABLE pos_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id       INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  method        TEXT NOT NULL CHECK (method IN ('kontant', 'kort_terminal', 'stripe_terminal', 'andet')),
  label         TEXT NOT NULL,                      -- betalingsformens navn, som det stod i kassen
  amount        INTEGER NOT NULL CHECK (amount > 0),
  received      INTEGER,                            -- kontant modtaget
  change_given  INTEGER,                            -- byttepenge
  status        TEXT NOT NULL CHECK (status IN ('afventer', 'gennemfoert', 'fejlet', 'annulleret')),
  reference     TEXT NOT NULL DEFAULT '',           -- fx kvitteringsnummer fra terminalen
  provider_ref  TEXT,                               -- Stripe PaymentIntent (pi_...); kortdata gemmes aldrig
  error         TEXT,
  actor         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_pos_payments_sale ON pos_payments(sale_id);

CREATE TABLE pos_refunds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id       INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  client_key    TEXT NOT NULL UNIQUE,
  amount        INTEGER NOT NULL CHECK (amount >= 0),   -- 0 ved retur af noget solgt med 100 % rabat
  status        TEXT NOT NULL CHECK (status IN ('afventer', 'gennemfoert', 'fejlet')),
  restock       INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  error         TEXT,
  actor         TEXT NOT NULL,
  approved_by   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_pos_refunds_sale ON pos_refunds(sale_id);
CREATE INDEX idx_pos_refunds_created ON pos_refunds(created_at);

CREATE TABLE pos_refund_lines (
  refund_id     INTEGER NOT NULL REFERENCES pos_refunds(id) ON DELETE CASCADE,
  sale_line_id  INTEGER NOT NULL REFERENCES pos_sale_lines(id) ON DELETE CASCADE,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  amount        INTEGER NOT NULL,
  PRIMARY KEY (refund_id, sale_line_id)
);
CREATE INDEX idx_pos_refund_lines_line ON pos_refund_lines(sale_line_id);

-- Hvordan en refusion er betalt tilbage (fordeles på flere betalingsformer ved delt betaling)
CREATE TABLE pos_refund_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id     INTEGER NOT NULL REFERENCES pos_refunds(id) ON DELETE CASCADE,
  payment_id    INTEGER NOT NULL REFERENCES pos_payments(id),
  method        TEXT NOT NULL,
  label         TEXT NOT NULL,
  amount        INTEGER NOT NULL CHECK (amount > 0),
  status        TEXT NOT NULL CHECK (status IN ('afventer', 'gennemfoert', 'fejlet')),
  provider_ref  TEXT,                               -- Stripe refund (re_...)
  error         TEXT
);
CREATE INDEX idx_pos_refund_payments_refund ON pos_refund_payments(refund_id);

-- Hændelser på et salg (vises som historik på salget)
CREATE TABLE pos_sale_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id     INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_pos_sale_events_sale ON pos_sale_events(sale_id, created_at);

-- Medarbejdere i kassen. Adresser i ADMIN_EMAILS er altid administratorer og behøver ingen række.
-- PIN-koden bruges til at godkende refusioner og store rabatter på en kollegas kasse.
CREATE TABLE pos_staff (
  email       TEXT PRIMARY KEY COLLATE NOCASE,
  name        TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'cashier')),
  active      INTEGER NOT NULL DEFAULT 1,
  pin_hash    TEXT,                                 -- PBKDF2-SHA256 med salt; selve koden gemmes aldrig
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Revisionslog: salg med godkendt rabat, refusioner, annulleringer, ændringer af varer, personale og indstillinger
CREATE TABLE pos_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  action       TEXT NOT NULL,
  sale_id      INTEGER REFERENCES pos_sales(id) ON DELETE SET NULL,
  detail       TEXT NOT NULL DEFAULT '',
  actor        TEXT NOT NULL,
  approved_by  TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_pos_audit_created ON pos_audit(created_at);

-- Kassens indstillinger (nøgle/værdi)
CREATE TABLE pos_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
