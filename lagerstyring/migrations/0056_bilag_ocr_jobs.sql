-- OCR runs outside the upload request. Only queue metadata is stored here;
-- the unchanged original remains in the company's existing file storage.
ALTER TABLE bilag ADD COLUMN reading_token TEXT NOT NULL DEFAULT '';
ALTER TABLE bilag ADD COLUMN data_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE bilag_ocr_jobs (
  bilag_id INTEGER PRIMARY KEY REFERENCES bilag(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  data_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','processing','done','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  actor TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  started_at INTEGER,
  lease_until INTEGER,
  finished_at INTEGER,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX bilag_ocr_jobs_ready ON bilag_ocr_jobs(state, available_at);

-- Edits, approval, archive and allocations invalidate in-flight OCR. Claiming
-- a new token is excluded. Result application checks its token in the same
-- atomic batch that replaces suggested fields/lines.
CREATE TRIGGER bilag_ocr_invalidate_edit
AFTER UPDATE OF doc_type,supplier_name,supplier_cvr,supplier_id,doc_number,doc_date,due_date,currency,net,vat,total,rounding,line_prices,payment_info,payment,paid_by,note,status,version ON bilag
WHEN NEW.reading_token = OLD.reading_token
BEGIN
  UPDATE bilag SET reading_token = '', data_revision = data_revision + 1 WHERE id = NEW.id;
END;
CREATE TRIGGER bilag_ocr_invalidate_line_insert AFTER INSERT ON bilag_lines BEGIN
  UPDATE bilag SET reading_token = '', data_revision = data_revision + 1 WHERE id = NEW.bilag_id;
END;
CREATE TRIGGER bilag_ocr_invalidate_line_update AFTER UPDATE ON bilag_lines BEGIN
  UPDATE bilag SET reading_token = '', data_revision = data_revision + 1 WHERE id = NEW.bilag_id;
END;
CREATE TRIGGER bilag_ocr_invalidate_line_delete AFTER DELETE ON bilag_lines BEGIN
  UPDATE bilag SET reading_token = '', data_revision = data_revision + 1 WHERE id = OLD.bilag_id;
END;
CREATE TRIGGER bilag_ocr_invalidate_allocation AFTER INSERT ON bilag_allocations BEGIN
  UPDATE bilag SET reading_token = '', data_revision = data_revision + 1 WHERE id = NEW.bilag_id;
END;
