-- Lagergrænser er i varens enhed (tusindedele), som resten af lagermotoren.
ALTER TABLE products ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN reorder_point INTEGER CHECK (reorder_point IS NULL OR reorder_point >= 0);
-- Prisernes kilde/dato er særskilt fra almindelige vareændringer. Gamle priser får ingen opdigtet kilde/dato.
ALTER TABLE products ADD COLUMN purchase_price_source TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN sale_price_source TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN purchase_price_at INTEGER;
ALTER TABLE products ADD COLUMN sale_price_at INTEGER;
-- En atomisk claim forbinder hver lagerovergang med netop én notifikation.
ALTER TABLE products ADD COLUMN alert_claim TEXT NOT NULL DEFAULT '';
ALTER TABLE notices ADD COLUMN transition_key TEXT;
CREATE UNIQUE INDEX idx_notices_transition ON notices(transition_key) WHERE transition_key IS NOT NULL;
-- Ryd kun historiske dubletter; bevar den seneste åbne besked pr. vare.
UPDATE notices SET open = 0, resolved_at = COALESCE(resolved_at, unixepoch())
WHERE kind = 'lager' AND open = 1 AND id NOT IN (
  SELECT MAX(id) FROM notices WHERE kind = 'lager' AND open = 1 GROUP BY product_id
);
CREATE UNIQUE INDEX idx_notices_stock_open ON notices(product_id) WHERE kind = 'lager' AND open = 1;
-- Et enhedsskift må aldrig omfortolke eksisterende beholdninger eller materialehistorik.
CREATE TRIGGER products_unit_history BEFORE UPDATE OF unit, whole_units ON products
WHEN (NEW.unit <> OLD.unit OR NEW.whole_units <> OLD.whole_units) AND (
  OLD.stock <> 0 OR OLD.reserved <> 0
  OR EXISTS (SELECT 1 FROM movements WHERE product_id = OLD.id AND (kind <> 'oprettet' OR qty <> 0 OR stock_delta <> 0 OR reserved_delta <> 0))
  OR EXISTS (SELECT 1 FROM job_materials WHERE product_id = OLD.id)
  OR EXISTS (SELECT 1 FROM job_items WHERE product_id = OLD.id)
  OR EXISTS (SELECT 1 FROM purchase_lines WHERE product_id = OLD.id)
  OR EXISTS (SELECT 1 FROM invoice_lines WHERE product_id = OLD.id)
  OR EXISTS (SELECT 1 FROM returns WHERE product_id = OLD.id)
  OR EXISTS (SELECT 1 FROM bilag_allocations WHERE product_id = OLD.id AND done_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'LAGER_UNIT_LOCKED'); END;
