-- Oprettelse af konto før betaling: login-tokens kan bære navn og en sikker returadresse.
ALTER TABLE login_tokens ADD COLUMN signup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE login_tokens ADD COLUMN name TEXT;
ALTER TABLE login_tokens ADD COLUMN next TEXT;
