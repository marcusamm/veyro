// Butikkens indstillinger gemmes i D1 og redigeres i /admin/indstillinger,
// så samme skabelon kan bruges til alle kunder uden ændringer i koden.

export interface Settings {
  shop_name: string;
  tagline: string;
  contact_email: string;
  contact_phone: string;
  address: string;
  website_url: string;
  accent_color: string;
  /** Tekst øverst i webshoppen, fx åbningstider eller leveringstid */
  intro: string;
  pickup_enabled: boolean;
  pickup_info: string;
  delivery_enabled: boolean;
  delivery_info: string;
  delivery_fee: number; // øre
  free_delivery_from: number; // øre, 0 = aldrig gratis
  min_order: number; // øre, 0 = ingen minimum
  /** Bekræft ordrer automatisk (trækker lageret med det samme) */
  auto_confirm: boolean;
  low_stock_default: number;
  /** Leverandørens leveringstid i dage (standard for alle varer) */
  lead_time_days: number;
  /** Ønsket sikkerhed mod udsolgt i procent: 90, 95, 98 eller 99 */
  service_level: number;
  /** Hvor mange dages salg beregningen bygger på */
  forecast_days: number;
  /** Varsl så mange dage før genbestillingspunktet nås */
  reorder_warn_days: number;
  /** Vis lagertal i webshoppen ("12 på lager") i stedet for blot "På lager" */
  show_stock_count: boolean;
  terms_url: string;
  privacy_url: string;
  notify_email: string;
}

/** Standardfarve (signalorange). Butikken kan vælge sin egen under Indstillinger. */
export const DEFAULT_ACCENT = '#FF5A1F';

export const DEFAULT_SETTINGS: Settings = {
  shop_name: 'Min butik',
  tagline: 'Bestil online',
  contact_email: '',
  contact_phone: '',
  address: '',
  website_url: '',
  accent_color: DEFAULT_ACCENT,
  intro: '',
  pickup_enabled: true,
  pickup_info: 'Du får besked, når din bestilling er klar til afhentning.',
  delivery_enabled: true,
  delivery_info: '',
  delivery_fee: 4900,
  free_delivery_from: 0,
  min_order: 0,
  auto_confirm: false,
  low_stock_default: 5,
  lead_time_days: 7,
  service_level: 95,
  forecast_days: 90,
  reorder_warn_days: 7,
  show_stock_count: false,
  terms_url: '',
  privacy_url: '',
  notify_email: '',
};

type Key = keyof Settings;

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const s: Settings = { ...DEFAULT_SETTINGS };
  const rec = s as unknown as Record<string, unknown>;
  for (const { key, value } of results) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[key as Key];
    if (typeof def === 'boolean') rec[key] = value === '1';
    else if (typeof def === 'number') rec[key] = Number.isFinite(Number(value)) ? Number(value) : def;
    else rec[key] = value;
  }
  return s;
}

export async function saveSettings(db: D1Database, s: Settings): Promise<void> {
  const stmts = (Object.keys(DEFAULT_SETTINGS) as Key[]).map((key) => {
    const v = s[key];
    const value = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    return db
      .prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, value);
  });
  await db.batch(stmts);
}

export function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

/** Kun http(s)-links, så brugerindtastede links ikke kan blive javascript:-links. */
export function safeUrl(s: string): string {
  return /^https?:\/\/[^\s<>"']+$/i.test(s) ? s : '';
}

/**
 * Lavlager-grænse for en vare: et fast minimum, hvis det er sat, ellers det genbestillingspunkt,
 * systemet har beregnet ud fra salget, og ellers butikkens standard.
 */
export function lowStockLimit(p: { low_stock_threshold: number | null; auto_reorder_point?: number | null }, s: Settings): number {
  return p.low_stock_threshold ?? p.auto_reorder_point ?? s.low_stock_default;
}

/** Samme grænse i SQL (tabellen skal hedde p, og ?-parameteren er butikkens standard). */
export const LIMIT_SQL = 'COALESCE(p.low_stock_threshold, p.auto_reorder_point, ?)';

/** Leveringsgebyr for en given varesum. */
export function deliveryFee(s: Settings, subtotal: number): number {
  if (s.free_delivery_from > 0 && subtotal >= s.free_delivery_from) return 0;
  return s.delivery_fee;
}
