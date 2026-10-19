// Virksomhedens indstillinger gemmes i D1 og redigeres under Lager → Indstillinger,
// så samme system kan bruges til alle kunder uden ændringer i koden.

export interface Settings {
  company_name: string;
  accent_color: string;
  /** Standardavance i procent, når en vare ikke har en salgspris (kan ændres pr. job) */
  default_markup_pct: number;
  /** Send lageradvarsler på e-mail til modtagerne med det samme */
  alert_mail_enabled: boolean;
  /** Saml nye indkøbsbehov i én e-mail med dette interval i timer (0 = slået fra) */
  purchase_digest_hours: number;
  /** Tidspunktet for seneste samlede indkøbs-e-mail (unix-sekunder) */
  last_digest_at: number;
  /** Momsgrundlag for prisestimater på indkøbslister: 'ekskl' eller 'inkl' */
  estimate_vat: string;
  /** Priser ældre end dette antal dage vises som "Tidligere pris – ikke bekræftet" */
  price_max_age_days: number;
}

/** Standardfarve (signalorange som på veyro.dk). Kan ændres under Indstillinger. */
export const DEFAULT_ACCENT = '#FF5A1F';

export const DEFAULT_SETTINGS: Settings = {
  company_name: 'Mit firma',
  accent_color: DEFAULT_ACCENT,
  default_markup_pct: 25,
  alert_mail_enabled: true,
  purchase_digest_hours: 0,
  last_digest_at: 0,
  estimate_vat: 'ekskl',
  price_max_age_days: 7,
};

export const DIGEST_CHOICES = [0, 1, 4, 24];

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

export function settingStmt(db: D1Database, key: Key, v: Settings[Key]): D1PreparedStatement {
  const value = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  return db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value);
}

export async function saveSettings(db: D1Database, s: Partial<Settings>): Promise<void> {
  const stmts = (Object.keys(s) as Key[]).filter((k) => k in DEFAULT_SETTINGS).map((k) => settingStmt(db, k, s[k]!));
  if (stmts.length) await db.batch(stmts);
}

export function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}
