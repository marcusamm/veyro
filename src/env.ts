export interface Env {
  DB: D1Database;

  // Offentlige indstillinger ([vars] i wrangler.toml)
  APP_URL: string;
  PRICE_STARTER: string;
  PRICE_BUSINESS: string;
  PRICE_PREMIUM: string;
  MIN_MONTHS?: string;
  ADMIN_EMAILS?: string;
  NOTIFY_EMAIL?: string;
  EMAIL_FROM?: string;
  DEV_MODE?: string;
  STRIPE_TAX_RATE_ID?: string;

  // Kun til test/udvikling: peg API-kald mod en lokal mock
  STRIPE_API_BASE?: string;
  RESEND_API_BASE?: string;

  // Hemmeligheder (wrangler secret put)
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY?: string;
}

export interface SessionInfo {
  idHash: string;
  email: string;
  csrf: string;
}

export interface CustomerRow {
  id: number;
  email: string;
  name: string | null;
  stripe_customer_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SubscriptionRow {
  id: string;
  customer_id: number;
  status: string;
  plan: string | null;
  price_id: string | null;
  item_id: string | null;
  amount: number | null;
  currency: string | null;
  started_at: number | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
  cancel_at: number | null;
  canceled_at: number | null;
  payment_failed: number;
  updated_at: number;
}

export interface RequestRow {
  id: number;
  customer_id: number;
  type: string;
  title: string;
  description: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    session: SessionInfo | null;
    csrf: string;
    nonce: string;
  };
};
