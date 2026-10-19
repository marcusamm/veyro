-- Administratorer kan skifte logo, invitere brugere og gøre andre til administratorer.
-- Adresserne i ADMIN_EMAILS er altid administratorer; denne kolonne giver det samme til andre brugere.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
