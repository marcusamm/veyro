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
  /** Version af det uploadede logo (0 = intet logo); bruges i /logo?v= så browseren henter det nye */
  logo_version: number;
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
  logo_version: 0,
};

export const DIGEST_CHOICES = [0, 1, 4, 24];

type Key = keyof Settings;

export async function getSettings(db: D1Database): Promise<Settings> {
  // Selve logoet hentes kun af /logo, så det ikke læses på hver side
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key != 'logo'").all<{ key: string; value: string }>();
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

// Logoet gemmes som "mime-type;base64" i rækken med nøglen 'logo'.
export const LOGO_MAX_BYTES = 200 * 1024;

/** Finder billedtypen ud fra filens indhold (ikke filnavnet eller den oplyste type). */
export function logoType(bytes: Uint8Array): string | null {
  const b = (i: number) => bytes[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function getLogo(db: D1Database): Promise<{ type: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'logo'").first<{ value: string }>();
  if (!row) return null;
  const i = row.value.indexOf(';');
  const bin = atob(row.value.slice(i + 1));
  const bytes = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
  return { type: row.value.slice(0, i), bytes };
}

export async function saveLogo(db: D1Database, type: string, bytes: Uint8Array): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO settings (key, value) VALUES ('logo', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`${type};${toBase64(bytes)}`),
    settingStmt(db, 'logo_version', Date.now()),
  ]);
}

export async function deleteLogo(db: D1Database): Promise<void> {
  await db.batch([db.prepare("DELETE FROM settings WHERE key = 'logo'"), settingStmt(db, 'logo_version', 0)]);
}
