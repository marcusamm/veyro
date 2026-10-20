-- Individuelt prissatte abonnementer på baggrund af tilbud (se src/lib/offers.ts).
-- Eksisterende tabeller udvides kun med nye kolonner, så kundedata bevares.

-- Faktureringsoplysninger på kunden
ALTER TABLE customers ADD COLUMN company TEXT;
ALTER TABLE customers ADD COLUMN cvr TEXT;
ALTER TABLE customers ADD COLUMN phone TEXT;
ALTER TABLE customers ADD COLUMN address TEXT;
ALTER TABLE customers ADD COLUMN postal_code TEXT;
ALTER TABLE customers ADD COLUMN city TEXT;

-- Interval (month | year) og evt. tilbud bag abonnementet
ALTER TABLE subscriptions ADD COLUMN interval TEXT;
ALTER TABLE subscriptions ADD COLUMN offer_id INTEGER;

-- Et tilbud med fast pris og et personligt betalingslink (/tilbud/<token>).
-- Prisen ligger fast i Stripe (stripe_price_id), så kunden ikke kan ændre beløbet.
CREATE TABLE offers (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  token                 TEXT NOT NULL UNIQUE,        -- tilfældigt, 43 tegn; giver kun adgang til at betale netop dette tilbud
  form_key              TEXT UNIQUE,                 -- engangsnøgle fra admin-formularen (dobbelt indsendelse)
  email                 TEXT NOT NULL,
  name                  TEXT NOT NULL,
  company               TEXT,
  cvr                   TEXT,
  phone                 TEXT,
  address               TEXT,
  postal_code           TEXT,
  city                  TEXT,
  service               TEXT NOT NULL,
  description           TEXT,
  amount                INTEGER NOT NULL,            -- øre ekskl. moms pr. periode
  interval              TEXT NOT NULL CHECK (interval IN ('month', 'year')),
  setup_amount          INTEGER NOT NULL DEFAULT 0,  -- engangsbeløb i øre ekskl. moms (oprettelse/udvikling)
  setup_description     TEXT,
  vat                   INTEGER NOT NULL DEFAULT 1,  -- 1 = 25 % moms lægges oveni
  setup_settled         INTEGER NOT NULL DEFAULT 0,  -- engangsbeløbet er allerede faktureret andetsteds og opkræves ikke via linket
  first_charge_at       INTEGER,                     -- første periode er allerede betalt: første opkrævning sker denne dato
  settled_note          TEXT,                        -- fx fakturanummeret, der allerede dækker beløbet
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'active', 'withdrawn', 'ended')),
  valid_until           INTEGER NOT NULL,
  stripe_customer_id    TEXT,
  stripe_price_id       TEXT,
  stripe_setup_price_id TEXT,
  checkout_gen          INTEGER NOT NULL DEFAULT 0,  -- tæller for Checkout-sessioner (engangsnøgle mod dobbeltklik)
  checkout_session_id   TEXT,
  checkout_url          TEXT,
  checkout_expires_at   INTEGER,
  subscription_id       TEXT UNIQUE,                 -- højst ét abonnement pr. tilbud
  accepted_at           INTEGER,
  activated_at          INTEGER,
  emailed_at            INTEGER,
  created_by            TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_offers_email ON offers(email);
CREATE INDEX idx_offers_status ON offers(status, created_at);

-- Betalinger og fakturaer fra Stripe (fra webhooks), så historik og fejl kan ses uden opslag.
CREATE TABLE payments (
  invoice_id          TEXT PRIMARY KEY,              -- Stripe invoice id (in_...)
  stripe_customer_id  TEXT,
  subscription_id     TEXT,
  number              TEXT,
  status              TEXT NOT NULL,                 -- paid | failed | open | void
  amount_due          INTEGER,
  amount_paid         INTEGER,
  currency            TEXT,
  attempt_count       INTEGER,
  billing_reason      TEXT,
  period_start        INTEGER,
  period_end          INTEGER,
  next_attempt_at     INTEGER,
  hosted_invoice_url  TEXT,
  invoice_pdf         TEXT,
  created             INTEGER,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_payments_customer ON payments(stripe_customer_id, created);

-- Prisændringer på et abonnement (kun den ene kunde).
CREATE TABLE price_changes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id  TEXT NOT NULL,
  old_amount       INTEGER,
  new_amount       INTEGER NOT NULL,
  interval         TEXT,
  effective_at     INTEGER NOT NULL,                 -- første betaling med den nye pris
  old_price_id     TEXT,                             -- Stripe-prisen, kunden betaler indtil ændringen
  new_price_id     TEXT,
  schedule_id      TEXT,                             -- Stripe subscription schedule ved ændring på en senere dato
  status           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'canceled')),
  notified_at      INTEGER,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_price_changes_sub ON price_changes(subscription_id, created_at);
