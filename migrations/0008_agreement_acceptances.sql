-- Kundens accept af handelsbetingelser og databehandleraftale (se src/lib/legal.ts).
-- Kun en ny tabel; eksisterende data røres ikke. Rækker slettes aldrig automatisk, da de dokumenterer aftalen.
CREATE TABLE IF NOT EXISTS agreement_acceptances (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL,              -- den, der accepterede (login- eller tilbudsmail)
  customer_id  INTEGER,                    -- kunden, hvis kontoen fandtes på tidspunktet
  offer_id     INTEGER,                    -- tilbuddet, hvis accepten skete på et tilbudslink
  document     TEXT NOT NULL,              -- handelsbetingelser | databehandleraftale
  version      TEXT NOT NULL,              -- LEGAL_VERSION på tidspunktet
  context      TEXT NOT NULL,              -- tilbud | bestil | kundepanel
  ip_hash      TEXT,                       -- SHA-256 af IP-adressen (ikke klartekst)
  accepted_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agreement_acceptances_email ON agreement_acceptances(email, accepted_at);
