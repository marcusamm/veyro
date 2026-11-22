-- AJ Auto approved one calendar, 45 minutes per oil change and weekday
-- appointments 09:00–16:00 Copenhagen time. Weekends are agreed by phone.
-- Only commission the existing owner's calendar. A new, unprovisioned database
-- stays in setup mode. Never replace intervals a workshop has already entered.
WITH weekdays(day) AS (VALUES (1), (2), (3), (4), (5)),
owner(id) AS MATERIALIZED (
  SELECT id FROM aj_staff
  WHERE active = 1 AND role = 'owner'
    AND (SELECT COUNT(*) FROM aj_staff WHERE active = 1) = 1
    AND NOT EXISTS (SELECT 1 FROM aj_hours)
)
INSERT INTO aj_hours (staff_id, weekday, start_minute, end_minute)
SELECT owner.id, weekdays.day, 540, 960 FROM owner CROSS JOIN weekdays;

UPDATE aj_services
SET duration_minutes = 45, active = 1
WHERE id = 1 AND name = 'Olieskift'
  AND (duration_minutes IS NULL OR duration_minutes = 45)
  AND EXISTS (SELECT 1 FROM aj_staff WHERE active = 1 AND role = 'owner');

UPDATE aj_settings
SET booking_enabled = 1, updated_at = unixepoch()
WHERE id = 1 AND booking_enabled = 0
  AND (SELECT COUNT(*) FROM aj_staff WHERE active = 1) = 1
  AND (SELECT COUNT(*) FROM aj_services WHERE active = 1) = 1
  AND EXISTS (SELECT 1 FROM aj_services WHERE id = 1 AND name = 'Olieskift' AND duration_minutes = 45 AND active = 1)
  AND (SELECT COUNT(*) FROM aj_hours h JOIN aj_staff s ON s.id = h.staff_id WHERE s.active = 1) = 5
  AND (SELECT COUNT(DISTINCT h.weekday) FROM aj_hours h JOIN aj_staff s ON s.id = h.staff_id
       WHERE s.role = 'owner' AND s.active = 1 AND h.weekday BETWEEN 1 AND 5
         AND h.start_minute = 540 AND h.end_minute = 960) = 5;
