-- Prisestimat på indkøbslister ud fra offentlige priser hos byggemarkeder og trælaster.
--
-- Estimaterne holdes helt adskilt fra indkøbslinjens forventede pris (unit_price), den faktiske
-- indkøbspris (actual_price) og jobbets salgspriser. Et prisopslag ændrer aldrig en linjes
-- status og bestiller aldrig noget. Gamle estimater bevares (status 'erstattet') som historik.

-- Entydige produktdata til præcis match på tværs af forhandlere. Forhandlernes egne varenumre
-- bruges aldrig til at sammenligne på tværs, da de ikke er ens fra forhandler til forhandler.
ALTER TABLE products ADD COLUMN ean TEXT NOT NULL DEFAULT '';      -- EAN/GTIN
ALTER TABLE products ADD COLUMN mpn TEXT NOT NULL DEFAULT '';      -- producentens varenummer
ALTER TABLE products ADD COLUMN brand TEXT NOT NULL DEFAULT '';    -- mærke/producent
ALTER TABLE products ADD COLUMN variant TEXT NOT NULL DEFAULT '';  -- fx farve eller længde

-- Forhandlere, der kan slås priser op hos. access fortæller, hvordan priserne kommer ind:
--   manuel  = produktlink og manuelt indtastet pris (ingen tilladt automatisk adgang fundet)
--   prisfil = forhandlerens officielle prisfil/feed (uploadet eller hentet fra feed_url)
--   demo    = fiktive demodata (kun i demoen)
CREATE TABLE retailers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  key               TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  website           TEXT NOT NULL DEFAULT '',
  access            TEXT NOT NULL DEFAULT 'manuel' CHECK (access IN ('manuel', 'prisfil', 'demo')),
  terms_note        TEXT NOT NULL DEFAULT '',   -- hvad vi ved om adgang og vilkår
  feed_url          TEXT NOT NULL DEFAULT '',   -- officielt feed (https), hentes på serveren
  active            INTEGER NOT NULL DEFAULT 1,
  last_import_at    INTEGER,
  last_import_rows  INTEGER,
  last_error        TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL
);

-- Offentlige produktdata og priser fra en forhandlers prisfil (cache). Mængder i tusindedele.
CREATE TABLE retailer_products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer_id    INTEGER NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  retailer_sku   TEXT NOT NULL,                 -- forhandlerens eget varenummer (kun inden for forhandleren)
  ean            TEXT NOT NULL DEFAULT '',
  mpn            TEXT NOT NULL DEFAULT '',
  brand          TEXT NOT NULL DEFAULT '',
  variant        TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  sales_unit     TEXT NOT NULL,                 -- den enhed, forhandleren sælger i (stk., pk., m, m² ...)
  pack_qty       INTEGER NOT NULL CHECK (pack_qty > 0),         -- indhold pr. salgsenhed
  content_unit   TEXT NOT NULL,                 -- enheden for indholdet (fx stk. i en pakke)
  min_qty        INTEGER NOT NULL DEFAULT 1000 CHECK (min_qty > 0), -- mindste køb i salgsenheder
  divisible      INTEGER NOT NULL DEFAULT 0,    -- 1 = kan købes i brøkdele (fx metervare)
  price          INTEGER NOT NULL CHECK (price >= 0),          -- øre pr. salgsenhed
  vat            TEXT NOT NULL CHECK (vat IN ('inkl', 'ekskl')),
  offer_price    INTEGER CHECK (offer_price IS NULL OR offer_price >= 0),
  offer_text     TEXT NOT NULL DEFAULT '',
  offer_min_qty  INTEGER,                       -- tilbuddet kræver mindst dette antal salgsenheder
  offer_until    TEXT NOT NULL DEFAULT '',      -- YYYY-MM-DD
  stock_text     TEXT NOT NULL DEFAULT '',      -- kun hvis kilden selv oplyser lagerstatus
  source         TEXT NOT NULL CHECK (source IN ('prisfil', 'demodata')),
  checked_at     INTEGER NOT NULL,              -- hvornår prisen er hentet fra kilden
  UNIQUE (retailer_id, retailer_sku)
);
CREATE INDEX idx_retailer_products_ean ON retailer_products(ean) WHERE ean <> '';
CREATE INDEX idx_retailer_products_mpn ON retailer_products(retailer_id, mpn) WHERE mpn <> '';

-- Prisestimater pr. indkøbslinje og forhandler. Højst ét gældende estimat og ét forslag pr. par.
CREATE TABLE price_estimates (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id              INTEGER NOT NULL REFERENCES purchase_lines(id) ON DELETE CASCADE,
  retailer_id          INTEGER NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  retailer_product_id  INTEGER REFERENCES retailer_products(id) ON DELETE SET NULL,
  match                TEXT NOT NULL CHECK (match IN ('praecis', 'alternativ')),
  basis                TEXT NOT NULL CHECK (basis IN ('ean', 'mpn', 'navn', 'manuel')),
  approved_by          TEXT,                    -- alternativer tæller først med, når de er godkendt
  approved_at          INTEGER,
  name                 TEXT NOT NULL,
  url                  TEXT NOT NULL DEFAULT '',
  sales_unit           TEXT NOT NULL,
  pack_qty             INTEGER NOT NULL CHECK (pack_qty > 0),
  content_unit         TEXT NOT NULL,
  min_qty              INTEGER NOT NULL DEFAULT 1000,
  divisible            INTEGER NOT NULL DEFAULT 0,
  price                INTEGER NOT NULL CHECK (price >= 0),   -- øre pr. salgsenhed (normalpris)
  vat                  TEXT NOT NULL CHECK (vat IN ('inkl', 'ekskl')),
  offer_price          INTEGER,
  offer_text           TEXT NOT NULL DEFAULT '',
  offer_min_qty        INTEGER,
  offer_until          TEXT NOT NULL DEFAULT '',
  stock_text           TEXT NOT NULL DEFAULT '',
  -- Øjebliksbillede af beregningen, da estimatet blev lavet (historik)
  need_qty             INTEGER NOT NULL DEFAULT 0,
  buy_qty              INTEGER,
  amount               INTEGER,
  source               TEXT NOT NULL CHECK (source IN ('prisfil', 'demodata', 'manuel')),
  status               TEXT NOT NULL CHECK (status IN ('aktuel', 'tidligere', 'forslag', 'erstattet')),
  note                 TEXT NOT NULL DEFAULT '',
  checked_at           INTEGER NOT NULL,
  created_by           TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  replaced_at          INTEGER
);
CREATE INDEX idx_price_estimates_line ON price_estimates(line_id, status);
CREATE UNIQUE INDEX idx_price_estimates_live ON price_estimates(line_id, retailer_id) WHERE status IN ('aktuel', 'tidligere');
CREATE UNIQUE INDEX idx_price_estimates_proposal ON price_estimates(line_id, retailer_id) WHERE status = 'forslag';

-- Seneste automatiske prisopslag for linjen
ALTER TABLE purchase_lines ADD COLUMN price_checked_at INTEGER;

-- Forhandlerne og resultatet af undersøgelsen af deres adgang (oktober 2026). Der er ikke fundet
-- en offentlig API eller et offentligt produktfeed hos nogen af dem, så de starter som "manuel".
INSERT INTO retailers (key, name, website, access, terms_note, created_at) VALUES
  ('stark', 'STARK', 'https://www.stark.dk', 'manuel', 'Ingen offentlig API eller produktfeed fundet. Brug produktlink og manuel pris, eller indlæs en officiel prisfil, hvis STARK stiller en til rådighed. Erhvervspriser bag login må ikke bruges.', CAST(strftime('%s', 'now') AS INTEGER)),
  ('bauhaus', 'BAUHAUS', 'https://www.bauhaus.dk', 'manuel', 'Ingen offentlig API eller produktfeed fundet. Brug produktlink og manuel pris.', CAST(strftime('%s', 'now') AS INTEGER)),
  ('silvan', 'Silvan', 'https://www.silvan.dk', 'manuel', 'Ingen offentlig API eller produktfeed fundet. Brug produktlink og manuel pris.', CAST(strftime('%s', 'now') AS INTEGER)),
  ('xlbyg', 'XL-BYG', 'https://www.xl-byg.dk', 'manuel', 'Ingen offentlig API fundet. Butikkerne er selvstændige, så priser kan variere fra butik til butik. Brug produktlink og manuel pris.', CAST(strftime('%s', 'now') AS INTEGER)),
  ('bygma', 'Bygma', 'https://www.bygma.dk', 'manuel', 'Ingen offentlig API eller produktfeed fundet. Brug produktlink og manuel pris.', CAST(strftime('%s', 'now') AS INTEGER)),
  ('davidsen', 'Davidsen', 'https://www.davidsen.dk', 'manuel', 'Ingen offentlig API eller produktfeed fundet. Brug produktlink og manuel pris.', CAST(strftime('%s', 'now') AS INTEGER)),
  ('jemogfix', 'jem & fix', 'https://www.jemogfix.dk', 'manuel', 'Ingen offentlig API eller produktfeed fundet. Brug produktlink og manuel pris.', CAST(strftime('%s', 'now') AS INTEGER));
