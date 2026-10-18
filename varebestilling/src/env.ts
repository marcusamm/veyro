import type { Settings } from './lib/settings';

export interface Env {
  DB: D1Database;

  // Offentlige indstillinger ([vars] i wrangler.toml)
  APP_URL: string;
  /** Kommasepareret liste over medarbejdere, der må logge ind i /admin */
  ADMIN_EMAILS?: string;
  /** Afsender på e-mails, fx "Butik <ordre@butik.dk>" (domænet skal være verificeret i Resend) */
  EMAIL_FROM?: string;
  DEV_MODE?: string;

  // Kun til test/udvikling: peg e-mail-kald mod en lokal mock
  RESEND_API_BASE?: string;

  // Hemmeligheder (wrangler secret put)
  RESEND_API_KEY?: string;
}

export interface SessionInfo {
  idHash: string;
  email: string;
  csrf: string;
}

export interface ProductRow {
  id: number;
  sku: string;
  name: string;
  category: string;
  description: string;
  unit: string;
  price: number;
  image_url: string;
  track_stock: number;
  stock: number;
  low_stock_threshold: number | null;
  active: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export type OrderStatus = 'ny' | 'bekraeftet' | 'klar' | 'afsluttet' | 'annulleret';
export type Delivery = 'afhentning' | 'levering';
export type OrderSource = 'hjemmeside' | 'telefon' | 'email' | 'direkte';

export interface OrderRow {
  id: number;
  number: number;
  token: string;
  status: OrderStatus;
  stock_deducted: number;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  company: string;
  delivery: Delivery;
  source: OrderSource;
  address: string;
  postcode: string;
  city: string;
  note: string;
  subtotal: number;
  delivery_fee: number;
  total: number;
  internal_note: string;
  created_at: number;
  updated_at: number;
}

export interface OrderLineRow {
  id: number;
  order_id: number;
  product_id: number | null;
  sku: string;
  name: string;
  unit: string;
  unit_price: number;
  quantity: number;
  line_total: number;
}

export interface OrderEventRow {
  id: number;
  order_id: number;
  status: string | null;
  message: string;
  actor: string;
  created_at: number;
}

export interface StockMovementRow {
  id: number;
  product_id: number;
  change: number;
  stock_after: number;
  reason: string;
  order_id: number | null;
  actor: string;
  created_at: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    session: SessionInfo | null;
    csrf: string;
    settings: Settings;
  };
};
