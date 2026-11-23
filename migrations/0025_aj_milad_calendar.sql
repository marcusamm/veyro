-- Provision the second mechanic only for AJ Auto's commissioned workshop.
-- An empty login address keeps the calendar bookable while sign-in is unavailable.
INSERT INTO aj_staff(name, email, role, active)
SELECT 'Milad Jarda', '', 'staff', 1
WHERE EXISTS (
  SELECT 1 FROM aj_staff s JOIN aj_hours h ON h.staff_id = s.id
  WHERE s.name = 'Anas Milad Jarada' COLLATE NOCASE AND s.role = 'owner' AND s.active = 1
)
AND EXISTS (SELECT 1 FROM aj_settings WHERE booking_enabled = 1)
AND NOT EXISTS (SELECT 1 FROM aj_staff WHERE trim(name) = 'Milad Jarda' COLLATE NOCASE);

WITH weekdays(day) AS (VALUES (1), (2), (3), (4), (5)),
mechanic(id) AS MATERIALIZED (
  SELECT s.id FROM aj_staff s
  WHERE trim(s.name) = 'Milad Jarda' COLLATE NOCASE AND s.role = 'staff' AND s.active = 1
    AND NOT EXISTS (SELECT 1 FROM aj_hours WHERE staff_id = s.id)
    AND EXISTS (
      SELECT 1 FROM aj_staff o JOIN aj_hours h ON h.staff_id = o.id
      WHERE o.name = 'Anas Milad Jarada' COLLATE NOCASE AND o.role = 'owner' AND o.active = 1
    )
    AND EXISTS (SELECT 1 FROM aj_settings WHERE booking_enabled = 1)
)
INSERT INTO aj_hours(staff_id, weekday, start_minute, end_minute)
SELECT mechanic.id, weekdays.day, 540, 960 FROM mechanic CROSS JOIN weekdays;
