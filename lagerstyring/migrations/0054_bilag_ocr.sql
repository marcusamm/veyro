-- Optional OCR provenance. Originals and existing reading-source values remain unchanged.
ALTER TABLE bilag ADD COLUMN ocr_provider TEXT NOT NULL DEFAULT '';

-- Keep completed inventory registrations even when a concurrent edit removes
-- their receipt line or document. Application prechecks provide friendly errors;
-- these transactional guards close the check/delete race and protect cascades.
CREATE TRIGGER bilag_lines_keep_posted
BEFORE DELETE ON bilag_lines
WHEN NOT EXISTS (SELECT 1 FROM settings WHERE key = '_internal_demo_reset' AND value = '1')
AND EXISTS (
  SELECT 1 FROM bilag_allocations
  WHERE line_id = OLD.id AND (done_at IS NOT NULL OR purchase_line_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'BILAG_LINE_POSTED: receipt line is linked to a registered purchase');
END;

CREATE TRIGGER bilag_allocations_keep_posted
BEFORE DELETE ON bilag_allocations
WHEN OLD.done_at IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM settings WHERE key = '_internal_demo_reset' AND value = '1')
BEGIN
  SELECT RAISE(ABORT, 'BILAG_ALLOCATION_POSTED: inventory registration must be preserved');
END;
