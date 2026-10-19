-- Produktkatalog: produktdata fra producenter og forhandlere (CSV/Excel), som brugerne søger i,
-- når de tilføjer materialer.
--
-- Kataloget og lageret holdes helt adskilt: kataloget fortæller, hvilke produkter der findes,
-- lageret (products) hvilke mængder virksomheden selv har. En import opretter aldrig lager,
-- ændrer aldrig mængder og registrerer aldrig indkøb eller modtagelse. Når en bruger vælger en
-- katalogvare, oprettes en reference i virksomhedens varekartotek (products) uden beholdning.
--
-- Tre slags numre holdes adskilt:
--   catalog_products.id   Veyros interne produkt-ID (vises som VK-000123)
--   mpn                   producentens varenummer
--   dealer_sku            forhandlerens varenummer (kun når kilden er en forhandler)
-- EAN/GTIN gemmes som tekst, så indledende nuller bevares; gtin er den normaliserede 14-cifrede
-- udgave, der bruges til at matche.

-- Datakilder (fx KEMPER eller en forhandlers fil) med den gemte kolonneopsætning
CREATE TABLE catalog_sources (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind              TEXT NOT NULL DEFAULT 'producent' CHECK (kind IN ('producent', 'forhandler', 'demo')),
  manufacturer      TEXT NOT NULL DEFAULT '',  -- producent, når filen ikke selv har en kolonne
  note              TEXT NOT NULL DEFAULT '',
  mapping           TEXT NOT NULL DEFAULT '{}', -- gemt kolonneopsætning (JSON)
  last_import_id    INTEGER,
  last_import_at    INTEGER,
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE TABLE catalog_products (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id          INTEGER NOT NULL REFERENCES catalog_sources(id),
  manufacturer       TEXT NOT NULL DEFAULT '',
  maker_key          TEXT NOT NULL DEFAULT '',   -- producent i små bogstaver (til match og filter)
  mpn                TEXT NOT NULL DEFAULT '',
  mpn_key            TEXT NOT NULL DEFAULT '',   -- varenummer uden mellemrum, store bogstaver
  dealer_sku         TEXT NOT NULL DEFAULT '',
  dealer_key         TEXT NOT NULL DEFAULT '',
  ean                TEXT NOT NULL DEFAULT '',   -- som i filen (tekst)
  gtin               TEXT NOT NULL DEFAULT '',   -- normaliseret til 14 cifre
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  category           TEXT NOT NULL DEFAULT '',
  variant            TEXT NOT NULL DEFAULT '',
  dimensions         TEXT NOT NULL DEFAULT '',
  material           TEXT NOT NULL DEFAULT '',
  unit               TEXT NOT NULL DEFAULT '',   -- '' = ukendt
  pack_size          TEXT NOT NULL DEFAULT '',   -- som i filen, fx "10 stk."
  url                TEXT NOT NULL DEFAULT '',
  source_updated     TEXT NOT NULL DEFAULT '',   -- dato for opdatering ifølge filen (YYYY-MM-DD)
  search_text        TEXT NOT NULL DEFAULT '',   -- normaliseret tekst til søgning
  name_key           TEXT NOT NULL DEFAULT '',   -- navn i små bogstaver (varianter har samme navn)
  -- aktiv, gennemgang (manglede i seneste fil) eller skjult (fjernet fra søgningen efter gennemgang)
  status             TEXT NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv', 'gennemgang', 'skjult')),
  review_note        TEXT NOT NULL DEFAULT '',
  is_demo            INTEGER NOT NULL DEFAULT 0,
  created_import_id  INTEGER,
  created_row_no     INTEGER,
  last_seen_import_id INTEGER,
  imported_at        INTEGER NOT NULL,           -- seneste import, der indeholdt varen
  updated_at         INTEGER NOT NULL,           -- seneste ændring af produktdata
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_catalog_products_mpn ON catalog_products(source_id, maker_key, mpn_key);
CREATE INDEX idx_catalog_products_mpnkey ON catalog_products(mpn_key) WHERE mpn_key <> '';
CREATE INDEX idx_catalog_products_gtin ON catalog_products(gtin) WHERE gtin <> '';
CREATE INDEX idx_catalog_products_dealer ON catalog_products(dealer_key) WHERE dealer_key <> '';
CREATE INDEX idx_catalog_products_name ON catalog_products(maker_key, name_key);
CREATE INDEX idx_catalog_products_status ON catalog_products(source_id, status);
CREATE INDEX idx_catalog_products_created ON catalog_products(created_import_id, created_row_no);

-- Priser fra katalogfiler, adskilt fra produktdata, så samme produkt kan have priser fra flere
-- kilder og forhandlere. price_type siger, hvad prisen er (fx producentens listepris); den er
-- aldrig virksomhedens indkøbspris eller en bestemt forhandlers pris, medmindre kilden er den forhandler.
CREATE TABLE catalog_prices (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_product_id  INTEGER NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  source_id           INTEGER NOT NULL REFERENCES catalog_sources(id),
  seller              TEXT NOT NULL DEFAULT '',  -- '' = producenten; ellers forhandlerens navn
  price_type          TEXT NOT NULL CHECK (price_type IN ('listepris', 'vejledende', 'forhandlerpris', 'nettopris')),
  amount              INTEGER NOT NULL CHECK (amount > 0),   -- øre pr. enhed eller pakke som i filen
  currency            TEXT NOT NULL DEFAULT '',  -- '' = ukendt
  vat                 TEXT NOT NULL DEFAULT 'ukendt' CHECK (vat IN ('inkl', 'ekskl', 'ukendt')),
  per                 TEXT NOT NULL DEFAULT '',  -- hvad prisen gælder (enhed eller pakke), som i filen
  import_id           INTEGER,
  imported_at         INTEGER NOT NULL,
  UNIQUE (catalog_product_id, source_id, seller, price_type)
);

-- Importer: filen indlæses først som en forhåndsvisning; intet ændres i kataloget, før
-- administratoren godkender.
CREATE TABLE catalog_imports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    INTEGER NOT NULL REFERENCES catalog_sources(id),
  filename     TEXT NOT NULL DEFAULT '',
  sheet        TEXT NOT NULL DEFAULT '',
  mapping      TEXT NOT NULL DEFAULT '{}',   -- kolonneopsætning og standardværdier (JSON)
  status       TEXT NOT NULL DEFAULT 'upload' CHECK (status IN ('upload', 'klar', 'godkendt', 'annulleret')),
  rows_total   INTEGER NOT NULL DEFAULT 0,
  rows_new     INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  rows_same    INTEGER NOT NULL DEFAULT 0,
  rows_error   INTEGER NOT NULL DEFAULT 0,
  rows_missing INTEGER NOT NULL DEFAULT 0,   -- varer fra kilden, der ikke er i filen
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  approved_by  TEXT,
  approved_at  INTEGER
);
CREATE INDEX idx_catalog_imports_source ON catalog_imports(source_id, created_at);

-- Rækkerne i en import, normaliseret og sammenlignet med kataloget
CREATE TABLE catalog_import_rows (
  import_id     INTEGER NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  row_no        INTEGER NOT NULL,              -- rækkenummer i filen
  ident         TEXT NOT NULL DEFAULT '',      -- nøgle til at finde dubletter i filen
  action        TEXT NOT NULL CHECK (action IN ('ny', 'opdater', 'uaendret', 'fejl')),
  match_id      INTEGER,                       -- eksisterende katalogvare
  errors        TEXT NOT NULL DEFAULT '',
  warnings      TEXT NOT NULL DEFAULT '',
  changes       TEXT NOT NULL DEFAULT '',      -- ændrede felter (til forhåndsvisningen)
  manufacturer  TEXT NOT NULL DEFAULT '',
  maker_key     TEXT NOT NULL DEFAULT '',
  mpn           TEXT NOT NULL DEFAULT '',
  mpn_key       TEXT NOT NULL DEFAULT '',
  dealer_sku    TEXT NOT NULL DEFAULT '',
  dealer_key    TEXT NOT NULL DEFAULT '',
  ean           TEXT NOT NULL DEFAULT '',
  gtin          TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  variant       TEXT NOT NULL DEFAULT '',
  dimensions    TEXT NOT NULL DEFAULT '',
  material      TEXT NOT NULL DEFAULT '',
  unit          TEXT NOT NULL DEFAULT '',
  pack_size     TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  source_updated TEXT NOT NULL DEFAULT '',
  search_text   TEXT NOT NULL DEFAULT '',
  name_key      TEXT NOT NULL DEFAULT '',
  -- set = pris i filen, clear = priskolonnen er tom (prisen er ukendt), keep = ingen priskolonne
  price_state   TEXT NOT NULL DEFAULT 'keep' CHECK (price_state IN ('set', 'clear', 'keep')),
  price         INTEGER,
  currency      TEXT NOT NULL DEFAULT '',
  vat           TEXT NOT NULL DEFAULT 'ukendt',
  price_per     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (import_id, row_no)
);
CREATE INDEX idx_catalog_import_rows_ident ON catalog_import_rows(import_id, ident);
CREATE INDEX idx_catalog_import_rows_action ON catalog_import_rows(import_id, action);

-- Ord fra produktnavnene, så en søgning med en mindre stavefejl kan finde det rigtige ord
CREATE TABLE catalog_words (
  word  TEXT PRIMARY KEY
) WITHOUT ROWID;
CREATE TABLE catalog_import_words (
  import_id  INTEGER NOT NULL,
  word       TEXT NOT NULL,
  PRIMARY KEY (import_id, word)
) WITHOUT ROWID;

-- Reference fra virksomhedens varekartotek og jobbets materialer til katalogvaren. Højst én
-- vare i varekartoteket pr. katalogvare.
ALTER TABLE products ADD COLUMN catalog_product_id INTEGER REFERENCES catalog_products(id);
CREATE UNIQUE INDEX idx_products_catalog ON products(catalog_product_id) WHERE catalog_product_id IS NOT NULL;
ALTER TABLE job_items ADD COLUMN catalog_product_id INTEGER REFERENCES catalog_products(id);
