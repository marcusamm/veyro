import type { Settings } from './lib/settings';

export interface Env {
  DB: D1Database;

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
  stock: number;
  reserved: number;
  alert_level: number;
  active: number;
  created_at: number;
  updated_at: number;
}

export type JobStatus = 'aktiv' | 'afsluttet' | 'annulleret';

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
  created_at: number;
  updated_at: number;
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
