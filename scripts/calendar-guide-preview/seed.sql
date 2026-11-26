INSERT INTO aj_staff(name,email,role,active) VALUES
  ('Testmedarbejder','testperson@example.invalid','staff',1),
  ('Testkollega','testkollega@example.invalid','staff',1)
ON CONFLICT(email) DO NOTHING;
INSERT OR IGNORE INTO aj_hours(staff_id,weekday,start_minute,end_minute)
  SELECT s.id,d.value,540,960 FROM aj_staff s CROSS JOIN json_each('[1,2,3,4,5,6,7]') d
  WHERE s.email IN ('testperson@example.invalid','testkollega@example.invalid');
UPDATE aj_services SET active=1, duration_minutes=45 WHERE name='Olieskift';
UPDATE aj_settings SET booking_enabled=1 WHERE id=1;
