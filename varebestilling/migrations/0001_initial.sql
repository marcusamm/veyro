-- Varebestilling: første skema
-- Ét skema til alle brancher: varer med varenummer (SKU), lager, ordrer og historik.

-- Butikkens indstillinger (navn, kontakt, levering m.m.), redigeres i /admin/indstillinger
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE products (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  sku                  TEXT NOT NULL UNIQUE COLLATE NOCASE, -- varenummer, bruges som nøgle ved import
  name                 TEXT NOT NULL,
  category             TEXT NOT NULL DEFAULT '',
  description          TEXT NOT NULL DEFAULT '',
  unit                 TEXT NOT NULL DEFAULT 'stk.',
  price                INTEGER NOT NULL CHECK (price >= 0),  -- øre, inkl. moms
  image_url            TEXT NOT NULL DEFAULT '',
  track_stock          INTEGER NOT NULL DEFAULT 1,           -- 0 = lager følges ikke (fx ydelser)
  -- Lager kan aldrig blive negativt for varer med lagerstyring. Overtrædelse afbryder hele
  -- databasebatchen, så en ordre aldrig bekræftes delvist eller oversælges.
  stock                INTEGER NOT NULL DEFAULT 0 CHECK (track_stock = 0 OR stock >= 0),
  low_stock_threshold  INTEGER,                              -- NULL = brug standard fra indstillinger
  active               INTEGER NOT NULL DEFAULT 1,           -- 0 = skjult i webshoppen
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_products_category ON products(active, category, sort_order, name);

CREATE TABLE orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  number          INTEGER NOT NULL UNIQUE,                  -- ordrenummer vist for kunden
  token           TEXT NOT NULL UNIQUE,                     -- hemmelig nøgle til kundens kvitteringsside
  status          TEXT NOT NULL DEFAULT 'ny'
                  CHECK (status IN ('ny', 'bekraeftet', 'klar', 'afsluttet', 'annulleret')),
  stock_deducted  INTEGER NOT NULL DEFAULT 0,               -- 1 = lageret er trukket for ordren
  customer_name   TEXT NOT NULL,
  customer_email  TEXT NOT NULL,
  customer_phone  TEXT NOT NULL DEFAULT '',
  company         TEXT NOT NULL DEFAULT '',
  delivery        TEXT NOT NULL CHECK (delivery IN ('afhentning', 'levering')),
  address         TEXT NOT NULL DEFAULT '',
  postcode        TEXT NOT NULL DEFAULT '',
  city            TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  subtotal        INTEGER NOT NULL,                          -- øre
  delivery_fee    INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL,
  internal_note   TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_orders_status ON orders(status, created_at);

-- Ordrelinjer gemmer et øjebliksbillede af varen, så ordren er uændret, selvom varen ændres eller slettes
CREATE TABLE order_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  sku         TEXT NOT NULL,
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL,
  unit_price  INTEGER NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  line_total  INTEGER NOT NULL
);
CREATE INDEX idx_order_lines_order ON order_lines(order_id);
CREATE INDEX idx_order_lines_product ON order_lines(product_id);

-- Ordrehistorik: statusskift og noter
CREATE TABLE order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status      TEXT,
  message     TEXT NOT NULL,
  actor       TEXT NOT NULL,                                -- e-mail på medarbejder, eller "kunde"/"system"
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);

-- Lagerhistorik: hver ændring af lagertal (ordre, annullering, manuel regulering, import)
CREATE TABLE stock_movements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  change       INTEGER NOT NULL,
  stock_after  INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  order_id     INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  actor        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_stock_movements_product ON stock_movements(product_id, created_at);
CREATE INDEX idx_stock_movements_created ON stock_movements(created_at);

CREATE TABLE login_tokens (
  token_hash  TEXT PRIMARY KEY,                     -- SHA-256 af tokenet; selve tokenet gemmes aldrig
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_login_tokens_expires ON login_tokens(expires_at);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,                     -- SHA-256 af cookie-værdien
  email       TEXT NOT NULL,
  csrf_token  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE rate_limits (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  reset_at   INTEGER NOT NULL
);
