-- Veyros interne regnskab. Ingen eksisterende kundedata eller historiske posteringer ændres.
-- Originaler genbruger den eksisterende private D1-filmodel fra lagerstyring.
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0),
  pages INTEGER,
  chunks INTEGER NOT NULL CHECK(chunks > 0),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE file_chunks (
  file_id INTEGER NOT NULL REFERENCES files(id),
  idx INTEGER NOT NULL CHECK(idx >= 0),
  data BLOB NOT NULL,
  PRIMARY KEY(file_id,idx)
);
CREATE TRIGGER files_immutable_update BEFORE UPDATE ON files BEGIN SELECT RAISE(ABORT,'Original files are immutable'); END;
CREATE TRIGGER files_immutable_delete BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT,'Original files are immutable'); END;
CREATE TRIGGER file_chunks_immutable_update BEFORE UPDATE ON file_chunks BEGIN SELECT RAISE(ABORT,'Original files are immutable'); END;
CREATE TRIGGER file_chunks_immutable_delete BEFORE DELETE ON file_chunks BEGIN SELECT RAISE(ABORT,'Original files are immutable'); END;
CREATE TRIGGER file_chunks_bounded_insert BEFORE INSERT ON file_chunks WHEN NEW.idx >= (SELECT chunks FROM files WHERE id=NEW.file_id) BEGIN SELECT RAISE(ABORT,'Original file already complete'); END;

CREATE TABLE accounting_accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('income','expense','asset','liability','equity')),
  purpose TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
INSERT INTO accounting_accounts(code,name,kind,purpose) VALUES
 ('1000','Salg af ydelser','income','sales'),
 ('4000','Varekøb','expense','purchases'),
 ('5820','Bank','asset','settlement'),
 ('6610','Købsmoms','asset','input_vat'),
 ('6620','Salgsmoms','liability','output_vat'),
 ('6800','Leverandørgæld','liability','settlement'),
 ('7300','Webhosting','expense','purchases'),
 ('7320','Køb af software','expense','purchases'),
 ('7410','Bankgebyrer','expense','purchases');

CREATE TABLE accounting_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  file_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  kind TEXT NOT NULL DEFAULT 'purchase' CHECK(kind IN ('purchase','sale','purchase_credit','sale_credit')),
  source_kind TEXT NOT NULL DEFAULT 'receipt' CHECK(source_kind IN ('receipt','single_bank_transaction','multi_bank_statement')),
  supplier TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  gross_minor INTEGER CHECK(gross_minor IS NULL OR (typeof(gross_minor)='integer' AND gross_minor > 0)),
  vat_minor INTEGER CHECK(vat_minor IS NULL OR (typeof(vat_minor)='integer' AND vat_minor >= 0)),
  deductible_vat_minor INTEGER CHECK(deductible_vat_minor IS NULL OR (typeof(deductible_vat_minor)='integer' AND deductible_vat_minor >= 0)),
  base_gross_minor INTEGER CHECK(base_gross_minor IS NULL OR (typeof(base_gross_minor)='integer' AND base_gross_minor > 0)),
  base_vat_minor INTEGER CHECK(base_vat_minor IS NULL OR (typeof(base_vat_minor)='integer' AND base_vat_minor >= 0)),
  base_deductible_vat_minor INTEGER CHECK(base_deductible_vat_minor IS NULL OR (typeof(base_deductible_vat_minor)='integer' AND base_deductible_vat_minor >= 0)),
  account_code TEXT REFERENCES accounting_accounts(code),
  settlement_account_code TEXT NOT NULL DEFAULT '5820' REFERENCES accounting_accounts(code),
  reading_source TEXT NOT NULL DEFAULT '',
  reading_note TEXT NOT NULL DEFAULT '',
  uncertain TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  correction_of INTEGER REFERENCES accounting_receipts(id),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(vat_minor IS NULL OR gross_minor IS NULL OR vat_minor <= gross_minor),
  CHECK(deductible_vat_minor IS NULL OR vat_minor IS NULL OR deductible_vat_minor <= vat_minor),
  CHECK(base_vat_minor IS NULL OR base_gross_minor IS NULL OR base_vat_minor <= base_gross_minor),
  CHECK(base_deductible_vat_minor IS NULL OR base_vat_minor IS NULL OR base_deductible_vat_minor <= base_vat_minor)
);
CREATE UNIQUE INDEX accounting_receipts_original ON accounting_receipts(file_id) WHERE correction_of IS NULL;
CREATE UNIQUE INDEX accounting_receipts_correction ON accounting_receipts(correction_of) WHERE correction_of IS NOT NULL;
CREATE INDEX accounting_receipts_status ON accounting_receipts(status,date);
CREATE TRIGGER accounting_receipts_posted_immutable BEFORE UPDATE ON accounting_receipts WHEN OLD.status='posted' BEGIN SELECT RAISE(ABORT,'Posted receipt is immutable; use a reversal'); END;
CREATE TRIGGER accounting_receipts_original_immutable BEFORE UPDATE OF file_id,file_name,correction_of ON accounting_receipts BEGIN SELECT RAISE(ABORT,'Receipt original is immutable'); END;
CREATE TRIGGER accounting_receipts_no_delete BEFORE DELETE ON accounting_receipts BEGIN SELECT RAISE(ABORT,'Receipt history cannot be deleted'); END;

CREATE TABLE accounting_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  file_name TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('csv','pdf')),
  rows_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  digest TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','confirmed')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_by TEXT,
  confirmed_at INTEGER
);
CREATE TRIGGER accounting_imports_original_immutable BEFORE UPDATE OF file_id,file_name,format,rows_json,warnings_json,digest ON accounting_imports BEGIN SELECT RAISE(ABORT,'Bank import source is immutable'); END;
CREATE TRIGGER accounting_imports_no_delete BEFORE DELETE ON accounting_imports BEGIN SELECT RAISE(ABORT,'Bank import history cannot be deleted'); END;
CREATE TABLE accounting_bank_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES accounting_imports(id),
  source_row INTEGER NOT NULL,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  merchant TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor <> 0),
  currency TEXT NOT NULL,
  account_key TEXT NOT NULL,
  external_id TEXT,
  balance_minor INTEGER CHECK(balance_minor IS NULL OR typeof(balance_minor)='integer'),
  semantic_key TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
  hidden_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(import_id,source_row)
);
CREATE INDEX accounting_bank_lines_scope ON accounting_bank_lines(account_key,currency,date);
CREATE INDEX accounting_bank_lines_semantic ON accounting_bank_lines(semantic_key);
CREATE TRIGGER accounting_bank_lines_immutable BEFORE UPDATE OF import_id,source_row,date,description,merchant,amount_minor,currency,account_key,external_id,balance_minor,semantic_key,created_at ON accounting_bank_lines BEGIN SELECT RAISE(ABORT,'Bank transaction is immutable'); END;
CREATE TRIGGER accounting_bank_lines_no_delete BEFORE DELETE ON accounting_bank_lines BEGIN SELECT RAISE(ABORT,'Bank transaction history cannot be deleted'); END;
CREATE TABLE accounting_bank_keys (
  identity_key TEXT NOT NULL,
  bank_line_id INTEGER NOT NULL REFERENCES accounting_bank_lines(id),
  PRIMARY KEY(identity_key,bank_line_id)
);
-- Repeated balances are possible after a refund. Only an explicit transaction ID is unique.
CREATE UNIQUE INDEX accounting_bank_external_id ON accounting_bank_keys(identity_key) WHERE substr(identity_key,1,3)='id:';
CREATE UNIQUE INDEX accounting_bank_one_external_id ON accounting_bank_keys(bank_line_id) WHERE substr(identity_key,1,3)='id:';
CREATE TRIGGER accounting_bank_keys_no_update BEFORE UPDATE ON accounting_bank_keys BEGIN SELECT RAISE(ABORT,'Bank identity is immutable'); END;
CREATE TRIGGER accounting_bank_keys_no_delete BEFORE DELETE ON accounting_bank_keys BEGIN SELECT RAISE(ABORT,'Bank identity is immutable'); END;
CREATE TABLE accounting_import_lines (
  import_id INTEGER NOT NULL REFERENCES accounting_imports(id),
  source_row INTEGER NOT NULL,
  bank_line_id INTEGER NOT NULL REFERENCES accounting_bank_lines(id),
  PRIMARY KEY(import_id,source_row)
);
CREATE TRIGGER accounting_import_lines_no_update BEFORE UPDATE ON accounting_import_lines BEGIN SELECT RAISE(ABORT,'Import history is immutable'); END;
CREATE TRIGGER accounting_import_lines_no_delete BEFORE DELETE ON accounting_import_lines BEGIN SELECT RAISE(ABORT,'Import history is immutable'); END;
CREATE TABLE accounting_bank_links (
  bank_line_id INTEGER PRIMARY KEY REFERENCES accounting_bank_lines(id),
  receipt_id INTEGER NOT NULL UNIQUE REFERENCES accounting_receipts(id),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE accounting_journals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_key TEXT NOT NULL UNIQUE,
  receipt_id INTEGER NOT NULL REFERENCES accounting_receipts(id),
  bank_line_id INTEGER REFERENCES accounting_bank_lines(id),
  reversal_of INTEGER UNIQUE REFERENCES accounting_journals(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'DKK' CHECK(currency='DKK'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','posted')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX accounting_journals_receipt ON accounting_journals(receipt_id) WHERE reversal_of IS NULL;
CREATE INDEX accounting_journals_date ON accounting_journals(date,status);
CREATE TRIGGER accounting_journals_pending_insert BEFORE INSERT ON accounting_journals WHEN NEW.status<>'pending' BEGIN SELECT RAISE(ABORT,'Journal must start pending'); END;
CREATE TABLE accounting_journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id INTEGER NOT NULL REFERENCES accounting_journals(id),
  account_code TEXT NOT NULL REFERENCES accounting_accounts(code),
  account_name TEXT NOT NULL,
  account_kind TEXT NOT NULL CHECK(account_kind IN ('income','expense','asset','liability','equity')),
  tax_role TEXT NOT NULL DEFAULT '' CHECK(tax_role IN ('','input_vat','output_vat')),
  debit_minor INTEGER NOT NULL DEFAULT 0 CHECK(typeof(debit_minor)='integer' AND debit_minor>=0),
  credit_minor INTEGER NOT NULL DEFAULT 0 CHECK(typeof(credit_minor)='integer' AND credit_minor>=0),
  CHECK((debit_minor>0 AND credit_minor=0) OR (credit_minor>0 AND debit_minor=0))
);
CREATE TRIGGER accounting_journals_balanced BEFORE UPDATE OF status ON accounting_journals WHEN NEW.status='posted'
BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM accounting_journal_lines WHERE journal_id=NEW.id)<2
   OR (SELECT COALESCE(SUM(debit_minor-credit_minor),1) FROM accounting_journal_lines WHERE journal_id=NEW.id)<>0
   THEN RAISE(ABORT,'Journal must balance') END;
END;
CREATE TRIGGER accounting_journals_immutable BEFORE UPDATE ON accounting_journals WHEN OLD.status='posted' BEGIN SELECT RAISE(ABORT,'Posted journal is immutable'); END;
CREATE TRIGGER accounting_journals_no_delete BEFORE DELETE ON accounting_journals BEGIN SELECT RAISE(ABORT,'Journal history cannot be deleted'); END;
CREATE TRIGGER accounting_journal_lines_no_insert BEFORE INSERT ON accounting_journal_lines WHEN EXISTS(SELECT 1 FROM accounting_journals WHERE id=NEW.journal_id AND status='posted') BEGIN SELECT RAISE(ABORT,'Posted journal is immutable'); END;
CREATE TRIGGER accounting_journal_lines_no_update BEFORE UPDATE ON accounting_journal_lines BEGIN SELECT RAISE(ABORT,'Journal lines are immutable'); END;
CREATE TRIGGER accounting_journal_lines_no_delete BEFORE DELETE ON accounting_journal_lines BEGIN SELECT RAISE(ABORT,'Journal lines are immutable'); END;
CREATE TRIGGER accounting_receipts_posted_guard BEFORE UPDATE OF status ON accounting_receipts WHEN NEW.status='posted' AND NOT EXISTS(SELECT 1 FROM accounting_journals WHERE receipt_id=NEW.id AND reversal_of IS NULL AND status='posted') BEGIN SELECT RAISE(ABORT,'Receipt requires a balanced posted journal'); END;

CREATE TABLE accounting_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX accounting_events_entity ON accounting_events(entity_type,entity_id,id);
CREATE TRIGGER accounting_events_no_update BEFORE UPDATE ON accounting_events BEGIN SELECT RAISE(ABORT,'Audit history is immutable'); END;
CREATE TRIGGER accounting_events_no_delete BEFORE DELETE ON accounting_events BEGIN SELECT RAISE(ABORT,'Audit history is immutable'); END;
-- Transaction-local assertions: inserted and removed in the same D1 batch.
CREATE TABLE accounting_assertions (valid INTEGER NOT NULL CHECK(valid=1));
