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
  /** Valgfri Stripe-kundeportal-konfiguration (bpc_...) til kortskift, fakturaer og opsigelse */
  STRIPE_PORTAL_CONFIGURATION?: string;

  /** Domæner, hvor salgshjemmesiden vises (kommasepareret), fx "veyro.dk,www.veyro.dk,ny.veyro.dk" */
  SITE_HOSTS?: string;
  /** Hjemmesidens kanoniske adresse (til søgemaskiner og delingslinks) */
  SITE_URL?: string;

  /** Mærkning af test-/demomiljøer (fx "Testmiljø"). Tom i produktion. */
  TEST_LABEL?: string;

  /** Veyro-medarbejdere (kommasepareret e-mail), der må godkende fortrolighedsaftaler på Veyros vegne. Skal også stå i ADMIN_EMAILS. */
  NDA_SIGNERS?: string;

  /** Fælles kundekatalog: hvilke kundesystemer en e-mail har adgang til (valgfri) */
  KATALOG?: KVNamespace;

  // Kundeopsætning (se docs/KUNDEOPSAETNING.md)
  /** Domænet, kundehjemmesider får en adresse på: <adresse>.veyro.dk */
  KUNDESIDE_DOMAENE?: string;
  /** Workerens navn i Cloudflare (domæner knyttes hertil) */
  CF_WORKER_NAME?: string;
  /** Cloudflare for SaaS: værtsnavnet, kunders egne domæner skal pege på med CNAME (engangsopsætning). Tom = ikke sat op */
  KUNDESIDE_SAAS_CNAME?: string;
  /** GitHub-repository med "Deploy kunder"-workflowet, fx "marcusamm/veyro" */
  GITHUB_REPO?: string;

  // Kun til test/udvikling: peg API-kald mod en lokal mock
  STRIPE_API_BASE?: string;
  RESEND_API_BASE?: string;
  CF_API_BASE?: string;
  GITHUB_API_BASE?: string;
  DOH_URL?: string;
  DOMAIN_CHECK_ORIGIN?: string;

  /** Cloudflare API-nøgle til domæner (Workers Custom Domains, Zone:Read, evt. SSL for SaaS) */
  CF_API_TOKEN?: string;
  /** GitHub-nøgle, der må starte "Deploy kunder" (Actions: write på repositoryet) */
  GITHUB_DISPATCH_TOKEN?: string;
  /** Delt nøgle mellem "Deploy kunder" og kunde.veyro.dk/api/provisionering */
  PROVISIONERING_TOKEN?: string;

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
  company?: string | null;
  cvr?: string | null;
  phone?: string | null;
  address?: string | null;
  postal_code?: string | null;
  city?: string | null;
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
  interval?: string | null;
  offer_id?: number | null;
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
