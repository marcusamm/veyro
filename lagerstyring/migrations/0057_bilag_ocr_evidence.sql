-- Reader evidence stays inside the same company's D1 as its original files.
-- It is kept separate from editable proposals and never posts stock or costs.
CREATE TABLE bilag_ocr_evidence (
  bilag_id INTEGER NOT NULL REFERENCES bilag(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  pages_json TEXT NOT NULL CHECK (length(pages_json) <= 700000),
  text_chars INTEGER NOT NULL CHECK (text_chars BETWEEN 0 AND 100000),
  source TEXT NOT NULL CHECK (source IN ('ocr','pdf-tekst')),
  provider TEXT NOT NULL DEFAULT '',
  read_at INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  PRIMARY KEY (bilag_id,file_id,version)
);
