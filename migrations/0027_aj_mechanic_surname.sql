-- Correct the existing mechanic so his calendar, access and appointments retain their IDs.
UPDATE aj_staff
SET name = 'Milad Jarada'
WHERE role = 'staff' AND name = 'Milad Jarda'
  AND EXISTS (SELECT 1 FROM aj_staff WHERE role = 'owner' AND name = 'Anas Milad Jarada');

-- Upcoming appointments carry a snapshot of the mechanic's name for the customer's booking page.
UPDATE aj_bookings
SET staff_name = 'Milad Jarada'
WHERE staff_name = 'Milad Jarda' AND status = 'confirmed' AND start_at >= unixepoch()
  AND staff_id IN (SELECT id FROM aj_staff WHERE role = 'staff' AND name = 'Milad Jarada')
  AND EXISTS (SELECT 1 FROM aj_staff WHERE role = 'owner' AND name = 'Anas Milad Jarada');
