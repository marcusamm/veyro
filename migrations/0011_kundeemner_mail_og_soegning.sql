-- Kundeemner, trin 2: Google Workspace-mail (Gmail API), hentning af hjemmesider ("Tilføj via link"),
-- vurdering og søgning i offentlige kilder. Kun nye tabeller; eksisterende data ændres ikke.

-- Én række pr. Veyro-postkasse (efe@, marcus@, kontakt@, tobias@ ...)
CREATE TABLE mail_accounts (
  email             TEXT PRIMARY KEY,           -- den konto, der skal forbindes
  status            TEXT NOT NULL DEFAULT 'ikke_forbundet' CHECK (status IN ('ikke_forbundet', 'forbundet', 'fejl', 'genforbind')),
  connected_email   TEXT,                       -- den adresse, Google bekræftede ved tilslutning
  token_enc         TEXT,                       -- refresh-token, krypteret med AES-GCM (MAIL_TOKEN_KEY); aldrig i klartekst
  scopes            TEXT,
  history_id        TEXT,                       -- Gmail-historik-ID for næste trinvise synkronisering
  last_sync_at      INTEGER,                    -- seneste gennemførte synkronisering
  last_check_at     INTEGER,                    -- seneste kontrol af manglende beskeder
  last_error        TEXT,                       -- kort fejltekst (ingen tokens eller mailindhold)
  last_error_at     INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER,
  connected_by      TEXT,
  connected_at      INTEGER,
  updated_at        INTEGER NOT NULL
);

-- Engangs-state til OAuth-flowet (CSRF-beskyttelse af tilbagekaldet)
CREATE TABLE mail_oauth_states (
  state_hash  TEXT PRIMARY KEY,
  account     TEXT NOT NULL,
  started_by  TEXT NOT NULL,
  drafts      INTEGER NOT NULL DEFAULT 0,
  verifier    TEXT NOT NULL,                    -- PKCE code_verifier
  expires_at  INTEGER NOT NULL
);

-- Samtaler, der er knyttet til et kundeemne eller en kunde. Andre samtaler gemmes ikke.
CREATE TABLE mail_threads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_key      TEXT NOT NULL UNIQUE,           -- samtalens rod (første Message-ID), fælles på tværs af Veyro-konti
  subject       TEXT,
  prospect_id   INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  match_state   TEXT NOT NULL CHECK (match_state IN ('bekraeftet', 'gennemgaa', 'afvist')),
  match_reason  TEXT,
  account_hint  TEXT,                           -- den konto, der først så samtalen (til gennemgang)
  assigned_to   TEXT,                           -- medarbejder for samtaler i fælles postkasser (kontakt@)
  first_at      INTEGER,
  last_at       INTEGER,
  reviewed_by   TEXT,
  reviewed_at   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_mail_threads_prospect ON mail_threads(prospect_id, last_at DESC);
CREATE INDEX idx_mail_threads_customer ON mail_threads(customer_id, last_at DESC);
CREATE INDEX idx_mail_threads_state ON mail_threads(match_state, last_at DESC);

-- Gmail-tråd-ID pr. konto (samme samtale kan ligge i flere Veyro-postkasser)
CREATE TABLE mail_thread_refs (
  account        TEXT NOT NULL,
  gmail_thread   TEXT NOT NULL,
  thread_id      INTEGER NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  PRIMARY KEY (account, gmail_thread)
);

-- Beskeder i tilknyttede samtaler. Message-ID'et forhindrer dubletter, også når flere Veyro-konti deltager.
CREATE TABLE mail_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id      INTEGER NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  rfc_id         TEXT NOT NULL UNIQUE,          -- Message-ID-headeren
  account        TEXT NOT NULL,                 -- Veyro-kontoen, beskeden blev hentet fra
  gmail_id       TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('ud', 'ind')),
  kind           TEXT NOT NULL DEFAULT 'menneske' CHECK (kind IN ('menneske', 'autosvar', 'leveringsfejl')),
  from_addr      TEXT,
  from_name      TEXT,
  to_addrs       TEXT,
  cc_addrs       TEXT,
  subject        TEXT,
  sent_at        INTEGER NOT NULL,
  snippet        TEXT,
  body_text      TEXT,                          -- kun ren tekst (HTML fjernes; eksterne billeder indlæses aldrig)
  body_loaded    INTEGER NOT NULL DEFAULT 0,    -- 0 = kun overskrifter (afventer bekræftelse af match)
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_mail_messages_thread ON mail_messages(thread_id, sent_at);

-- Baggrundsjob (hentning af hjemmeside, vurdering, søgning) med genforsøg
CREATE TABLE prospect_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('link', 'vurdering', 'kilde')),
  status        TEXT NOT NULL DEFAULT 'venter' CHECK (status IN ('venter', 'koerer', 'faerdig', 'fejl')),
  input         TEXT NOT NULL,                  -- JSON
  result        TEXT,                           -- JSON
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  prospect_id   INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_prospect_jobs_status ON prospect_jobs(status, next_attempt_at);

-- Offentlige kilder til nye kundeemner, fx en festivals udstillerliste
CREATE TABLE prospect_sources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,
  industry     TEXT,
  area         TEXT,                            -- fx "Sjælland" eller "Slagelse og omegn"
  note         TEXT,
  last_run_at  INTEGER,
  last_error   TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- Søgeresultater til gennemgang. Importeres kun, når en medarbejder vælger det.
CREATE TABLE prospect_candidates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    INTEGER REFERENCES prospect_sources(id) ON DELETE CASCADE,
  company      TEXT NOT NULL,
  website      TEXT,
  domain       TEXT,
  found_on     TEXT NOT NULL,
  reason       TEXT NOT NULL,                   -- begrundelse for relevans
  not_checked  TEXT NOT NULL,                   -- hvad der endnu ikke er undersøgt
  status       TEXT NOT NULL DEFAULT 'ny' CHECK (status IN ('ny', 'importeret', 'fravalgt')),
  prospect_id  INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (source_id, domain)
);
CREATE INDEX idx_candidates_status ON prospect_candidates(status, created_at DESC);
