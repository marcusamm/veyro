-- Adgangskoder til admin-login (/admin/login). Kun PBKDF2-hash og salt gemmes.
CREATE TABLE admin_passwords (
  email       TEXT PRIMARY KEY,                     -- små bogstaver, skal stå i ADMIN_EMAILS
  hash        TEXT NOT NULL,                        -- PBKDF2-SHA256, hex
  salt        TEXT NOT NULL,                        -- hex
  iterations  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
