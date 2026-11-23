-- Match any manually created service before inserting so existing booking references
-- and workshop-written descriptions survive the change. Each duration reserves
-- calendar capacity and is an estimate for the customer.
WITH workshop_services(name, description, minutes) AS (
  VALUES
    ('Fuld service', 'Serviceeftersyn af bilen.', 90),
    ('Dækskifte', 'Bestil tid til at få skiftet dæk.', 60),
    ('Bremser', 'Bestil tid til arbejde på bilens bremser.', 60),
    ('Syntjek', 'Gennemgang af bilen inden syn.', 30)
)
INSERT INTO aj_services (id, name, description, duration_minutes, active)
SELECT (
    SELECT min(s.id) FROM aj_services s
    WHERE replace(trim(s.name), ' ', '') = replace(w.name, ' ', '') COLLATE NOCASE
  ), w.name, w.description, w.minutes, 1
FROM workshop_services w
WHERE true
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  description = CASE WHEN trim(aj_services.description) = '' THEN excluded.description ELSE aj_services.description END,
  duration_minutes = excluded.duration_minutes,
  active = 1;
