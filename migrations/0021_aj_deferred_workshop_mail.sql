-- Workshop mail can be configured after booking opens. Customer confirmation mail,
-- calendar setup and the explicit booking switch are still required by the API.
-- Keep every database-level scheduling invariant; remove only the recipient gate.
DROP TRIGGER aj_booking_insert;
DROP TRIGGER aj_booking_update;

CREATE TRIGGER aj_booking_insert BEFORE INSERT ON aj_bookings WHEN NEW.status='confirmed'
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_settings WHERE id=1 AND booking_enabled=1) THEN RAISE(ABORT,'AJ_NOT_READY') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_staff WHERE id=NEW.staff_id AND active=1) THEN RAISE(ABORT,'AJ_STAFF_UNAVAILABLE') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_services WHERE id=NEW.service_id AND active=1 AND duration_minutes*60=NEW.end_at-NEW.start_at AND duration_minutes=NEW.local_end-NEW.local_start) THEN RAISE(ABORT,'AJ_SERVICE_UNAVAILABLE') END;
  SELECT CASE WHEN NEW.start_at<=unixepoch() THEN RAISE(ABORT,'AJ_PAST') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_hours WHERE staff_id=NEW.staff_id AND weekday=NEW.local_weekday AND start_minute<=NEW.local_start AND end_minute>=NEW.local_end) THEN RAISE(ABORT,'AJ_HOURS') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_bookings WHERE staff_id=NEW.staff_id AND status='confirmed' AND start_at<NEW.end_at AND end_at>NEW.start_at) THEN RAISE(ABORT,'AJ_OVERLAP') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_blocks WHERE staff_id=NEW.staff_id AND start_at<NEW.end_at AND end_at>NEW.start_at) THEN RAISE(ABORT,'AJ_BLOCKED') END;
END;
CREATE TRIGGER aj_booking_update BEFORE UPDATE OF staff_id,start_at,end_at,status ON aj_bookings WHEN NEW.status='confirmed'
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_settings WHERE id=1 AND booking_enabled=1) THEN RAISE(ABORT,'AJ_NOT_READY') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_staff WHERE id=NEW.staff_id AND active=1) THEN RAISE(ABORT,'AJ_STAFF_UNAVAILABLE') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_services WHERE id=NEW.service_id AND active=1 AND duration_minutes*60=NEW.end_at-NEW.start_at AND duration_minutes=NEW.local_end-NEW.local_start) THEN RAISE(ABORT,'AJ_SERVICE_UNAVAILABLE') END;
  SELECT CASE WHEN NEW.start_at<=unixepoch() THEN RAISE(ABORT,'AJ_PAST') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM aj_hours WHERE staff_id=NEW.staff_id AND weekday=NEW.local_weekday AND start_minute<=NEW.local_start AND end_minute>=NEW.local_end) THEN RAISE(ABORT,'AJ_HOURS') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_bookings WHERE id<>NEW.id AND staff_id=NEW.staff_id AND status='confirmed' AND start_at<NEW.end_at AND end_at>NEW.start_at) THEN RAISE(ABORT,'AJ_OVERLAP') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM aj_blocks WHERE staff_id=NEW.staff_id AND start_at<NEW.end_at AND end_at>NEW.start_at) THEN RAISE(ABORT,'AJ_BLOCKED') END;
END;
