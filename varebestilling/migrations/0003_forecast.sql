-- Automatisk sikkerhedslager og genbestillingspunkt ud fra salgshistorikken.
-- Tallene beregnes af systemet (dagligt og ved behov) og bruges, når varen ikke har et fast minimum.
ALTER TABLE products ADD COLUMN lead_time_days INTEGER
  CHECK (lead_time_days IS NULL OR (lead_time_days >= 0 AND lead_time_days <= 365)); -- leveringstid fra leverandør, NULL = butikkens standard
ALTER TABLE products ADD COLUMN avg_daily_demand REAL;         -- gennemsnitligt salg pr. dag
ALTER TABLE products ADD COLUMN auto_safety_stock INTEGER;     -- beregnet sikkerhedslager
ALTER TABLE products ADD COLUMN auto_reorder_point INTEGER;    -- beregnet genbestillingspunkt
ALTER TABLE products ADD COLUMN forecast_at INTEGER;           -- hvornår tallene sidst blev beregnet
ALTER TABLE products ADD COLUMN reorder_alerted INTEGER NOT NULL DEFAULT 0; -- 1 = der er sendt varsel om genbestilling
