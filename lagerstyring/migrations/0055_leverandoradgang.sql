-- The old seed marked several retailers as automatically approved by Veyro.
-- A template is not an installation-specific, currently verified integration.
-- Keep operator-confirmed configurations, imported files, manual prices and
-- historical source/date information. Only retire that built-in approval.
UPDATE price_estimates
SET status = 'tidligere', note = 'Tidligere produktpris. Automatisk leverandøradgang er ikke bekræftet for denne installation.'
WHERE source = 'side' AND status IN ('aktuel', 'forslag')
  AND retailer_id IN (
    SELECT id FROM retailers
    WHERE access = 'side' AND terms_confirmed_by = 'Veyro (gennemgang 19. okt. 2026)'
  );

UPDATE retailers
SET access = CASE WHEN EXISTS (
      SELECT 1 FROM retailer_products p WHERE p.retailer_id = retailers.id AND p.source = 'prisfil'
    ) THEN 'prisfil' ELSE 'manuel' END,
    terms_confirmed_by = NULL, terms_confirmed_at = NULL,
    terms_note = 'Brug importerede prisfiler eller manuelle priser. Automatisk leverandøradgang er ikke bekræftet for denne installation.'
WHERE access = 'side' AND terms_confirmed_by = 'Veyro (gennemgang 19. okt. 2026)';
