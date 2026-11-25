-- Private Apple calendar connections. No appointment titles, details or busy intervals.
-- The sealed blob binds credentials and selected calendar paths to a staff + connection ID.
CREATE TABLE aj_icloud_connections (
  staff_id INTEGER PRIMARY KEY REFERENCES aj_staff(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL UNIQUE,
  sealed TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','connected','reconnect')),
  -- Once a selection was verified, reconnection cannot silently reopen the employee.
  enforced INTEGER NOT NULL DEFAULT 0 CHECK(enforced IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1
);
-- A temporary non-secret reservation fences simultaneous/slow connects. No Apple account data.
CREATE TABLE aj_icloud_attempts (
  staff_id INTEGER PRIMARY KEY REFERENCES aj_staff(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- Never let a reassigned or reactivated AJ staff identity inherit an old Apple account.
CREATE TRIGGER aj_icloud_retire_staff AFTER UPDATE OF email,active ON aj_staff
WHEN NEW.email <> OLD.email COLLATE NOCASE OR NEW.active = 0
BEGIN
  DELETE FROM aj_icloud_attempts WHERE staff_id=OLD.id;
  DELETE FROM aj_icloud_connections WHERE staff_id=OLD.id;
END;
