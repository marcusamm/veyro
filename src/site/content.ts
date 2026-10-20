// Hjemmesidens indhold: standardindholdet fra koden (site/) + ændringer gemt i D1 via admin.
// Alle ændringer gemmer den tidligere version i site_content_history, så de kan rulles tilbage.
import { THEME_FILES, THEME_VERSION } from './theme.generated';
import { SITE_DEFAULTS } from './theme.generated';
import { readThemeJson } from './engine';

export interface SectionData {
  type: string;
  settings?: Record<string, unknown>;
  blocks?: Record<string, { type: string; settings?: Record<string, unknown>; disabled?: boolean }>;
  block_order?: string[];
  disabled?: boolean;
}
export interface TemplateData {
  sections: Record<string, SectionData>;
  order: string[];
  name?: string;
  type?: string;
}
export interface SitePage {
  handle: string;
  title: string;
  /** '' = standard tekstside (templates/page.json), ellers templates/page.<template>.json */
  template: string;
  body: string;
  published: boolean;
  description: string;
}
export interface SiteProduct {
  handle: string;
  title: string;
  type: string;
  /** Pris i øre inkl. moms */
  price: number;
  interval: 'month' | 'year';
  status: 'active' | 'draft';
  description: string;
}
export interface MenuItem {
  title: string;
  url: string;
}
export interface SiteMenu {
  title: string;
  items: MenuItem[];
}
export interface SiteData {
  settings: Record<string, unknown>;
  templates: Record<string, TemplateData>;
  groups: Record<string, TemplateData>;
  pages: SitePage[];
  menus: Record<string, SiteMenu>;
  products: SiteProduct[];
  shop: { name: string; email: string; url: string };
  /** Ændres ved hver gemning; bruges som cache-nøgle */
  version: string;
  /** Nøgler, der er ændret i forhold til standardindholdet */
  overridden: Set<string>;
}

const DEFAULTS = SITE_DEFAULTS as unknown as {
  pages: SitePage[];
  menus: Record<string, SiteMenu>;
  products: SiteProduct[];
  shop: { name: string; email: string; url: string };
};

export function defaultTemplateNames(): string[] {
  return Object.keys(THEME_FILES)
    .filter((f) => f.startsWith('templates/') && f.endsWith('.json'))
    .map((f) => f.slice(10, -5));
}

/** Standardværdien for en indholdsnøgle (det, der står i koden) */
export function defaultValue(key: string): unknown {
  if (key === 'settings') return readThemeJson('config/settings_data.json').current;
  if (key === 'menus') return DEFAULTS.menus;
  if (key.startsWith('template:')) return THEME_FILES[`templates/${key.slice(9)}.json`] ? readThemeJson(`templates/${key.slice(9)}.json`) : null;
  if (key.startsWith('group:')) return THEME_FILES[`sections/${key.slice(6)}.json`] ? readThemeJson(`sections/${key.slice(6)}.json`) : null;
  if (key.startsWith('page:')) return DEFAULTS.pages.find((p) => p.handle === key.slice(5)) ?? null;
  if (key.startsWith('product:')) return DEFAULTS.products.find((p) => p.handle === key.slice(8)) ?? null;
  return null;
}

interface Row {
  key: string;
  value: string;
  updated_at: number;
}

export async function loadSite(db: D1Database): Promise<SiteData> {
  const { results } = await db.prepare('SELECT key, value, updated_at FROM site_content').all<Row>();
  const rows = new Map<string, unknown>();
  let latest = 0;
  for (const r of results ?? []) {
    try {
      rows.set(r.key, JSON.parse(r.value));
    } catch {
      continue;
    }
    latest = Math.max(latest, r.updated_at);
  }

  const settings = { ...(defaultValue('settings') as Record<string, unknown>), ...((rows.get('settings') as Record<string, unknown>) ?? {}) };

  const templates: Record<string, TemplateData> = {};
  for (const name of defaultTemplateNames()) templates[name] = defaultValue('template:' + name) as TemplateData;
  const groups: Record<string, TemplateData> = {};
  for (const f of Object.keys(THEME_FILES)) if (f.startsWith('sections/') && f.endsWith('.json')) groups[f.slice(9, -5)] = readThemeJson(f);

  const pages = new Map<string, SitePage>(DEFAULTS.pages.map((p) => [p.handle, { ...p }]));
  const products = new Map<string, SiteProduct>(DEFAULTS.products.map((p) => [p.handle, { ...p }]));
  for (const [key, value] of rows) {
    if (key.startsWith('template:')) {
      if (value) templates[key.slice(9)] = value as TemplateData;
      else delete templates[key.slice(9)];
    } else if (key.startsWith('group:') && value) groups[key.slice(6)] = value as TemplateData;
    else if (key.startsWith('page:')) {
      if (value && !(value as { deleted?: boolean }).deleted) pages.set(key.slice(5), value as SitePage);
      else pages.delete(key.slice(5));
    } else if (key.startsWith('product:')) {
      if (value && !(value as { deleted?: boolean }).deleted) products.set(key.slice(8), value as SiteProduct);
      else products.delete(key.slice(8));
    }
  }
  const menus = (rows.get('menus') as Record<string, SiteMenu>) ?? DEFAULTS.menus;

  return {
    settings,
    templates,
    groups,
    pages: [...pages.values()],
    menus,
    products: [...products.values()],
    shop: DEFAULTS.shop,
    version: `${THEME_VERSION}.${latest}.${rows.size}`,
    overridden: new Set([...rows.keys()].filter((k) => k !== '_version')),
  };
}

/** Den aktuelle værdi for en nøgle (gemt eller standard) */
export async function getContent<T = unknown>(db: D1Database, key: string): Promise<{ value: T | null; saved: boolean; updated_at: number | null; updated_by: string | null }> {
  const row = await db.prepare('SELECT value, updated_at, updated_by FROM site_content WHERE key = ?').bind(key).first<{ value: string; updated_at: number; updated_by: string | null }>();
  if (row) return { value: JSON.parse(row.value) as T, saved: true, updated_at: row.updated_at, updated_by: row.updated_by };
  return { value: defaultValue(key) as T | null, saved: false, updated_at: null, updated_by: null };
}

/**
 * Gemmer en ny værdi (value = null nulstiller til standardindholdet).
 * Den tidligere værdi lægges i historikken i samme batch.
 */
export async function saveContent(db: D1Database, key: string, value: unknown | null, by: string, note?: string): Promise<void> {
  const nowMs = Date.now();
  const stmts = [
    db
      .prepare(
        `INSERT INTO site_content_history (key, value, replaced_at, replaced_by, note)
         SELECT ?1, (SELECT value FROM site_content WHERE key = ?1), ?2, ?3, ?4`,
      )
      .bind(key, Math.floor(nowMs / 1000), by, note ?? null),
  ];
  if (value === null) stmts.push(db.prepare('DELETE FROM site_content WHERE key = ?').bind(key));
  else
    stmts.push(
      db
        .prepare(
          `INSERT INTO site_content (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(key, JSON.stringify(value), nowMs, by),
    );
  // Gengivne sider for den gamle version er ikke længere gyldige
  stmts.push(db.prepare('DELETE FROM site_cache'));
  // Sikrer, at versionen altid ændrer sig (også ved nulstilling), så cachen bliver ugyldig
  stmts.push(
    db
      .prepare(
        `INSERT INTO site_content (key, value, updated_at, updated_by) VALUES ('_version', '0', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = CAST(site_content.value AS INTEGER) + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(nowMs + 1, by),
  );
  await db.batch(stmts);
}

export interface HistoryRow {
  id: number;
  key: string;
  value: string | null;
  replaced_at: number;
  replaced_by: string | null;
  note: string | null;
}

export async function listHistory(db: D1Database, key?: string, limit = 100): Promise<HistoryRow[]> {
  const q = key
    ? db.prepare('SELECT id, key, value, replaced_at, replaced_by, note FROM site_content_history WHERE key = ? ORDER BY id DESC LIMIT ?').bind(key, limit)
    : db.prepare("SELECT id, key, NULL AS value, replaced_at, replaced_by, note FROM site_content_history WHERE key != '_version' ORDER BY id DESC LIMIT ?").bind(limit);
  return (await q.all<HistoryRow>()).results ?? [];
}

/** Gendanner en tidligere version. Den nuværende version gemmes selv i historikken. */
export async function restoreHistory(db: D1Database, id: number, by: string): Promise<string | null> {
  const row = await db.prepare('SELECT key, value FROM site_content_history WHERE id = ?').bind(id).first<{ key: string; value: string | null }>();
  if (!row || row.key === '_version') return null;
  await saveContent(db, row.key, row.value === null ? null : JSON.parse(row.value), by, `Gendannet version #${id}`);
  return row.key;
}

/** Læsbart navn for en indholdsnøgle (bruges i historikken) */
export function keyLabel(key: string, site?: SiteData): string {
  if (key === 'settings') return 'Temaindstillinger';
  if (key === 'menus') return 'Menuer';
  if (key.startsWith('group:')) return key === 'group:header-group' ? 'Sidehoved' : key === 'group:footer-group' ? 'Sidefod' : key.slice(6);
  if (key.startsWith('template:')) {
    const n = key.slice(9);
    if (n === 'index') return 'Forsiden (sektioner)';
    if (n === 'product') return 'Produktsider (sektioner)';
    if (n === 'cart') return 'Kurven (sektioner)';
    if (n === '404') return 'Siden findes ikke (sektioner)';
    if (n === 'page') return 'Tekstsider (layout)';
    const page = site?.pages.find((p) => p.template === n.replace(/^page\./, ''));
    return `${page?.title ?? n} (sektioner)`;
  }
  if (key.startsWith('page:')) return `Side: ${site?.pages.find((p) => p.handle === key.slice(5))?.title ?? key.slice(5)}`;
  if (key.startsWith('product:')) return `Abonnement: ${site?.products.find((p) => p.handle === key.slice(8))?.title ?? key.slice(8)}`;
  return key;
}
