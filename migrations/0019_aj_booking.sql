-- AJ Auto: separate application data inside the existing Worker / D1 setup.
-- No invented staff, hours, appointment duration or published campaign.
CREATE TABLE aj_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  workshop_email TEXT NOT NULL DEFAULT '',
  booking_enabled INTEGER NOT NULL DEFAULT 0 CHECK (booking_enabled IN (0,1)),
  campaign_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO aj_settings (id,campaign_json) VALUES (1,'{"enabled":false,"confirmed":false,"title":"Olieskift inklusive motorolie og oliefilter","priceOre":90000,"expiresOn":null}');

CREATE TABLE aj_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR (duration_minutes BETWEEN 15 AND 480 AND duration_minutes % 5 = 0)),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  CHECK (active = 0 OR duration_minutes IS NOT NULL)
);
INSERT INTO aj_services (name,description) VALUES ('Olieskift','Olieskift med motorolie og oliefilter. Kontakt os om pris og den rette olie til din bil.');

CREATE TABLE aj_staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  calendar_token_hash TEXT UNIQUE
);
CREATE TRIGGER aj_staff_limit_insert BEFORE INSERT ON aj_staff WHEN NEW.active=1 AND (SELECT count(*) FROM aj_staff WHERE active=1)>=3
BEGIN SELECT RAISE(ABORT,'AJ_STAFF_LIMIT'); END;
CREATE TRIGGER aj_staff_limit_update BEFORE UPDATE OF active ON aj_staff WHEN NEW.active=1 AND OLD.active=0 AND (SELECT count(*) FROM aj_staff WHERE active=1)>=3
BEGIN SELECT RAISE(ABORT,'AJ_STAFF_LIMIT'); END;

CREATE TABLE aj_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES aj_staff(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (start_minute < end_minute),
  UNIQUE (staff_id,weekday,start_minute,end_minute)
);
CREATE TABLE aj_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES aj_staff(id),
  start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '', CHECK(end_at > start_at)
);
CREATE INDEX aj_blocks_calendar ON aj_blocks(staff_id,start_at,end_at);

CREATE TABLE aj_bookings (
  id TEXT PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES aj_services(id),
  service_name TEXT NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES aj_staff(id),
  staff_name TEXT NOT NULL,
  start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  local_weekday INTEGER NOT NULL CHECK(local_weekday BETWEEN 1 AND 7),
  local_start INTEGER NOT NULL CHECK(local_start BETWEEN 0 AND 1439),
  local_end INTEGER NOT NULL CHECK(local_end BETWEEN 1 AND 1440),
  name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
  registration TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
  manage_token_hash TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1, mutation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (end_at > start_at AND local_end > local_start)
);
CREATE INDEX aj_bookings_calendar ON aj_bookings(staff_id,start_at,end_at) WHERE status='confirmed';

-- SQLite serializes writes. These guards also cover simultaneous requests from separate Workers.
CREATE TRIGGER aj_booking_insert BEFORE INSERT ON aj_bookings WHEN NEW.status='confirmed'
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_settings WHERE id=1 AND booking_enabled=1 AND workshop_email<>'') THEN RAISE(ABORT,'AJ_NOT_READY') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_staff WHERE id=NEW.staff_id AND active=1) THEN RAISE(ABORT,'AJ_STAFF_UNAVAILABLE') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_services WHERE id=NEW.service_id AND active=1 AND duration_minutes*60=NEW.end_at-NEW.start_at AND duration_minutes=NEW.local_end-NEW.local_start) THEN RAISE(ABORT,'AJ_SERVICE_UNAVAILABLE') END;
  SELECT CASE WHEN NEW.start_at<=unixepoch() THEN RAISE(ABORT,'AJ_PAST') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_hours WHERE staff_id=NEW.staff_id AND weekday=NEW.local_weekday AND start_minute<=NEW.local_start AND end_minute>=NEW.local_end) THEN RAISE(ABORT,'AJ_HOURS') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_bookings WHERE staff_id=NEW.staff_id AND status='confirmed' AND start_at<NEW.end_at AND end_at>NEW.start_at) THEN RAISE(ABORT,'AJ_OVERLAP') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_blocks WHERE staff_id=NEW.staff_id AND start_at<NEW.end_at AND end_at>NEW.start_at) THEN RAISE(ABORT,'AJ_BLOCKED') END;
END;
CREATE TRIGGER aj_booking_update BEFORE UPDATE OF staff_id,start_at,end_at,status ON aj_bookings WHEN NEW.status='confirmed'
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_settings WHERE id=1 AND booking_enabled=1 AND workshop_email<>'') THEN RAISE(ABORT,'AJ_NOT_READY') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_staff WHERE id=NEW.staff_id AND active=1) THEN RAISE(ABORT,'AJ_STAFF_UNAVAILABLE') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_services WHERE id=NEW.service_id AND active=1 AND duration_minutes*60=NEW.end_at-NEW.start_at AND duration_minutes=NEW.local_end-NEW.local_start) THEN RAISE(ABORT,'AJ_SERVICE_UNAVAILABLE') END;
  SELECT CASE WHEN NEW.start_at<=unixepoch() THEN RAISE(ABORT,'AJ_PAST') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_hours WHERE staff_id=NEW.staff_id AND weekday=NEW.local_weekday AND start_minute<=NEW.local_start AND end_minute>=NEW.local_end) THEN RAISE(ABORT,'AJ_HOURS') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_bookings WHERE id<>NEW.id AND staff_id=NEW.staff_id AND status='confirmed' AND start_at<NEW.end_at AND end_at>NEW.start_at) THEN RAISE(ABORT,'AJ_OVERLAP') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_blocks WHERE staff_id=NEW.staff_id AND start_at<NEW.end_at AND end_at>NEW.start_at) THEN RAISE(ABORT,'AJ_BLOCKED') END;
END;
CREATE TRIGGER aj_block_insert BEFORE INSERT ON aj_blocks
BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_bookings WHERE status='confirmed' AND staff_id=NEW.staff_id AND start_at<NEW.end_at AND end_at>NEW.start_at) THEN RAISE(ABORT,'AJ_BLOCK_HAS_BOOKING') END; END;
CREATE TRIGGER aj_block_update BEFORE UPDATE ON aj_blocks
BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_bookings WHERE status='confirmed' AND staff_id=NEW.staff_id AND start_at<NEW.end_at AND end_at>NEW.start_at) THEN RAISE(ABORT,'AJ_BLOCK_HAS_BOOKING') END; END;
CREATE TRIGGER aj_hours_delete BEFORE DELETE ON aj_hours
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_bookings b WHERE b.status='confirmed' AND b.start_at>unixepoch() AND b.staff_id=OLD.staff_id AND b.local_weekday=OLD.weekday AND b.local_start>=OLD.start_minute AND b.local_end<=OLD.end_minute AND NOT EXISTS(SELECT 1 FROM aj_hours h WHERE h.id<>OLD.id AND h.staff_id=b.staff_id AND h.weekday=b.local_weekday AND h.start_minute<=b.local_start AND h.end_minute>=b.local_end)) THEN RAISE(ABORT,'AJ_HOURS_HAS_BOOKING') END;
END;
CREATE TRIGGER aj_hours_update BEFORE UPDATE ON aj_hours
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_bookings b WHERE b.status='confirmed' AND b.start_at>unixepoch() AND b.staff_id=OLD.staff_id AND b.local_weekday=OLD.weekday AND b.local_start>=OLD.start_minute AND b.local_end<=OLD.end_minute AND NOT (NEW.staff_id=b.staff_id AND NEW.weekday=b.local_weekday AND NEW.start_minute<=b.local_start AND NEW.end_minute>=b.local_end) AND NOT EXISTS(SELECT 1 FROM aj_hours h WHERE h.id<>OLD.id AND h.staff_id=b.staff_id AND h.weekday=b.local_weekday AND h.start_minute<=b.local_start AND h.end_minute>=b.local_end)) THEN RAISE(ABORT,'AJ_HOURS_HAS_BOOKING') END;
END;

CREATE TABLE aj_login_tokens (token_hash TEXT PRIMARY KEY,email TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
CREATE TABLE aj_sessions (token_hash TEXT PRIMARY KEY,email TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX aj_session_expiry ON aj_sessions(expires_at);
CREATE TABLE aj_messages (
  id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',message TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE aj_outbox (
  id TEXT PRIMARY KEY,booking_id TEXT REFERENCES aj_bookings(id),message_id TEXT REFERENCES aj_messages(id),
  event TEXT NOT NULL,recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('customer','workshop')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','not_configured')),
  attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,sent_at INTEGER,created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX aj_outbox_pending ON aj_outbox(status,next_attempt_at);
