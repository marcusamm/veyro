-- Blokering af afsendere, der spammer hjemmesidens formularer ("Bloker afsender" på en forespørgsel).
-- Tilføjer kun en kolonne og en tabel; eksisterende forespørgsler bevares uændret.

-- Hash af afsenderens IP-adresse (aldrig selve adressen), så en afsender også kan blokeres på IP.
-- Slettes sammen med forespørgslen efter privatlivspolitikkens regler.
ALTER TABLE leads ADD COLUMN ip_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_ip_hash ON leads (ip_hash) WHERE ip_hash IS NOT NULL;

-- Blokerede afsendere. Henvendelser fra dem afvises i stilhed: de får takkebeskeden, men intet gemmes og ingen mail sendes.
CREATE TABLE IF NOT EXISTS lead_blocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('email', 'domain', 'ip')),
  value       TEXT NOT NULL,                  -- normaliseret mailadresse, domæne eller IP-hash
  label       TEXT,                           -- det, admin ser (mailadressen/domænet; for IP: "IP fra forespørgsel #12")
  lead_id     INTEGER,                        -- forespørgslen, blokeringen blev lavet fra (kan være slettet)
  hits        INTEGER NOT NULL DEFAULT 0,     -- afviste henvendelser siden blokeringen
  last_hit_at INTEGER,
  created_at  INTEGER NOT NULL,
  created_by  TEXT,
  UNIQUE (kind, value)
);
