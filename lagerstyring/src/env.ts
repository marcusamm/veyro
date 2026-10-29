import type { Settings } from './lib/settings';

export interface Env {
  DB: D1Database;
  /** Valgfri, særskilt OCR-worker. Ingen aflæsning af billeder uden denne binding. */
  RECEIPT_OCR?: Fetcher;
  /** Én privat OCR-kø pr. virksomheds Worker/database. Kun metadata gemmes i køen. */
  BILAG_OCR_QUEUE?: DurableObjectNamespace;

  // Offentlige indstillinger ([vars] i wrangler.toml)
  APP_URL: string;
  /** Kommasepareret liste over ejere, der altid kan logge ind (også før der er oprettet brugere) */
  ADMIN_EMAILS?: string;
  /** Afsender på e-mails, fx "Firma <lager@firma.dk>" (domænet skal være verificeret i Resend) */
  EMAIL_FROM?: string;
  /** "1" viser login-linket på skærmen i stedet for at sende det (kun til udvikling) */
  DEV_MODE?: string;
  /** "1" = demo: eksempeldata, login med ét klik som ejer eller medarbejder og nulstilling */
  DEMO_MODE?: string;

  /** Fælles kundekatalog til Kundelogin på kunde.veyro.dk (sættes af scripts/deploy-kunder.mjs) */
  KATALOG?: KVNamespace;
  /** Installationens navn i kundekataloget, fx "einar-kornerup-lager" */
  KATALOG_ID?: string;

  // Kun til test/udvikling: peg e-mail-kald mod en lokal mock
  RESEND_API_BASE?: string;

  // Hemmeligheder (wrangler secret put)
  RESEND_API_KEY?: string;
}

export type Role = 'ejer' | 'indkober' | 'medarbejder';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  alert_mail: number;
  purchase_mail: number;
  active: number;
  /** 1 = administrator (sat i appen); adresserne i ADMIN_EMAILS er altid administratorer */
  is_admin: number;
  labour_type_id: number | null;
  created_at: number;
}

export interface SessionInfo {
  idHash: string;
  csrf: string;
  user: User;
}

export interface SupplierRow {
  id: number;
  name: string;
  email: string;
  phone: string;
  lead_time_days: number | null;
  created_at: number;
}

export interface ProductRow {
  id: number;
  sku: string;
  name: string;
  description: string;
  /** Manuelt genbestillingspunkt, inklusive sikkerhedslager, i tusindedele. */
  reorder_point: number | null;
  unit: string;
  whole_units: number;
  category: string;
  supplier_id: number | null;
  lead_time_days: number | null;
  avg_daily_usage: number | null;
  safety_method: 'antal' | 'dage' | null;
  safety_qty: number | null;
  buffer_days: number | null;
  max_stock: number | null;
  purchase_price: number | null;
  sale_price: number | null;
  purchase_price_source: string;
  sale_price_source: string;
  purchase_price_at: number | null;
  sale_price_at: number | null;
  ean: string;
  mpn: string;
  brand: string;
  variant: string;
  stock: number;
  reserved: number;
  alert_level: number;
  active: number;
  created_at: number;
  updated_at: number;
  /** Varen i det centrale produktkatalog (ikke en lagerbeholdning). */
  catalog_product_id: number | null;
}

export type JobStatus = 'aktiv' | 'afsluttet' | 'annulleret';
/** Status for brugeren; kladde, planlagt, i_gang og afventer er alle status 'aktiv' i lagermotoren */
export type JobStage = 'kladde' | 'planlagt' | 'i_gang' | 'afventer' | 'afsluttet' | 'annulleret';

export interface JobRow {
  id: number;
  number: string;
  name: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  customer_address: string;
  site_address: string;
  responsible: string;
  planned_date: string;
  status: JobStatus;
  markup_pct: number | null;
  note: string;
  stage: JobStage;
  stage_auto: number;
  stage_prev: string;
  description: string;
  start_date: string;
  end_date: string;
  customer_cvr: string;
  customer_contact: string;
  retailer_id: number | null;
  hour_rate: number | null;
  created_at: number;
  updated_at: number;
}

export interface JobItemRow {
  id: number;
  job_id: number;
  product_id: number | null;
  cost_basis: 'lager' | 'byggemarked';
  sku: string;
  name: string;
  unit: string;
  ean: string;
  mpn: string;
  brand: string;
  variant: string;
  qty: number;
  used_qty: number;
  retailer_id: number | null;
  price_retailer_id: number | null;
  retailer_product_id: number | null;
  match: 'praecis' | 'alternativ' | null;
  match_basis: string;
  approved_by: string | null;
  approved_at: number | null;
  found_name: string;
  url: string;
  sales_unit: string;
  pack_qty: number | null;
  min_qty: number;
  divisible: number;
  price: number | null;
  vat: 'inkl' | 'ekskl' | null;
  price_source: string;
  checked_at: number | null;
  lookup_note: string;
  actual_cost: number | null;
  sale_mode: 'offentlig' | 'paaslag' | 'manuel';
  markup_pct: number | null;
  sale_price: number | null;
  purchase_line_id: number | null;
  planned_at: number | null;
  note: string;
  sort_order: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  /** Valgt fra produktkataloget. */
  catalog_product_id: number | null;
}

export interface LabourTypeRow {
  id: number;
  name: string;
  internal_cost: number | null;
  bill_rate: number | null;
  active: number;
  created_at: number;
}

export interface JobEntryRow {
  id: number;
  job_id: number;
  type: 'tid' | 'omkostning';
  phase: 'forventet' | 'faktisk';
  worker_email: string;
  worker_name: string;
  worker_type: string;
  work_date: string;
  description: string;
  qty: number;
  unit: string;
  internal_cost: number | null;
  unit_price: number | null;
  billable: number;
  extra: number;
  approved_by: string | null;
  approved_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface JobQuoteRow {
  id: number;
  job_id: number;
  version: number;
  data: string;
  materials: number;
  labour: number;
  other: number;
  subtotal: number;
  vat: number;
  total: number;
  incomplete: number;
  note: string;
  valid_until: string;
  shared_at: number | null;
  shared_by: string | null;
  accepted_at: number | null;
  accepted_by: string | null;
  created_by: string;
  created_at: number;
}

export type InvoiceMode = 'medgaaet' | 'fast' | 'kombination';

export interface InvoiceRow {
  id: number;
  job_id: number;
  kind: 'faktura' | 'kreditnota';
  status: 'kladde' | 'udstedt';
  number: number | null;
  credit_of: number | null;
  mode: InvoiceMode;
  fixed_amount: number | null;
  quote_id: number | null;
  customer: string;
  company: string;
  issue_date: string;
  delivery_date: string;
  due_date: string;
  payment_days: number;
  vat_rate: number;
  subtotal: number;
  vat: number;
  total: number;
  note: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  issued_by: string | null;
  issued_at: number | null;
}

export interface InvoiceItemRow {
  id: number;
  invoice_id: number;
  type: 'materiale' | 'tid' | 'omkostning' | 'fastpris';
  source_key: string;
  description: string;
  qty: number;
  unit: string;
  unit_price: number | null;
  unit_cost: number | null;
  include: number;
  covered: number;
  note: string;
  sort_order: number;
}

export interface JobMaterialRow {
  id: number;
  job_id: number;
  product_id: number;
  planned: number;
  reserved: number;
  issued: number;
  returned: number;
  site_received: number;
  site_used: number;
  site_returned: number;
  updated_at: number;
}

export interface PurchaseListRow {
  id: number;
  job_id: number | null;
  kind: 'job' | 'lager';
  name: string;
  responsible: string;
  wanted_date: string;
  note: string;
  archived: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface PurchaseLineRow {
  id: number;
  list_id: number;
  job_id: number | null;
  product_id: number | null;
  sku: string;
  name: string;
  unit: string;
  supplier_id: number | null;
  qty: number;
  ordered: number;
  received: number;
  unit_price: number | null;
  actual_price: number | null;
  expected_date: string;
  order_ref: string;
  deliver_to: 'lager' | 'arbejdssted';
  ready: number;
  cancelled: number;
  auto: number;
  note: string;
  price_checked_at: number | null;
  retailer_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface MovementRow {
  id: number;
  product_id: number | null;
  job_id: number | null;
  purchase_line_id: number | null;
  kind: string;
  qty: number;
  stock_delta: number;
  reserved_delta: number;
  stock_after: number | null;
  reserved_after: number | null;
  unit_cost: number | null;
  reason: string;
  actor: string;
  actor_name: string;
  op: string | null;
  created_at: number;
}

export interface NoticeRow {
  id: number;
  kind: 'lager' | 'afvigelse';
  level: number;
  product_id: number | null;
  job_id: number | null;
  message: string;
  open: number;
  mail_id: number | null;
  created_at: number;
  resolved_at: number | null;
}

export interface MailRow {
  id: number;
  kind: string;
  recipient: string;
  subject: string;
  body_text: string;
  status: 'sendt' | 'simuleret' | 'fejlet';
  list_id: number | null;
  list_version: number | null;
  actor: string;
  created_at: number;
}

export interface InvoiceBasisRow {
  id: number;
  job_id: number;
  status: 'kladde' | 'godkendt';
  customer: string;
  note: string;
  total_cost: number;
  total_sale: number;
  created_by: string;
  created_at: number;
  approved_by: string | null;
  approved_at: number | null;
}

export interface InvoiceLineRow {
  id: number;
  basis_id: number;
  source: 'lager' | 'arbejdssted' | 'direkte';
  product_id: number | null;
  purchase_line_id: number | null;
  sku: string;
  name: string;
  unit: string;
  qty: number;
  unit_cost: number;
  unit_price: number;
  include: number;
  sort_order: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    session: SessionInfo | null;
    csrf: string;
    settings: Settings;
  };
};
