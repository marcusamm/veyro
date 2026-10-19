// Læsning af offentlige produktsider hos byggemarkeder.
//
// Kun sider, som alle kan se uden login, og kun hvor butikkens robots.txt tillader det. Prisen
// læses fra de strukturerede produktdata, butikken selv lægger på siden (schema.org Product i
// JSON-LD eller Open Graph product:price). Finder vi ikke en pris i kroner, er der ingen pris:
// der gættes aldrig ud fra sidens tekst. Login, CAPTCHA og adgangsbegrænsninger omgås aldrig.

import { normGtin } from './prices';

export const USER_AGENT = 'VeyroLagerstyring/1.0 (prisestimat; +https://veyro.dk)';
const AGENT_TOKEN = 'veyrolagerstyring';

// --- robots.txt -----------------------------------------------------------------------------

interface Rule {
  allow: boolean;
  path: string;
}

/** Reglerne i robots.txt, der gælder for os (vores egen gruppe, ellers "*"). */
export function robotsRules(txt: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === 'allow' || key === 'disallow') {
        // En tom Disallow betyder "alt er tilladt"
        if (key === 'disallow' && !val) continue;
        cur.rules.push({ allow: key === 'allow', path: val });
      }
    }
  }
  const own = groups.filter((g) => g.agents.some((a) => a.replace(/[^a-z]/g, '') === AGENT_TOKEN));
  const pick = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  return pick.flatMap((g) => g.rules);
}

function ruleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith('$');
  const body = (anchored ? rule.slice(0, -1) : rule).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + body.join('.*') + (anchored ? '$' : '')).test(path);
}

/** Må stien læses? Den længste regel vinder; ved lige lange vinder Allow. */
export function robotsAllows(rules: Rule[], pathAndQuery: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

// --- Produktdata fra siden ------------------------------------------------------------------

export interface PageProduct {
  name: string;
  price: number; // øre
  gtin: string;
  mpn: string;
  brand: string;
  sku: string;
  availability: string;
}

type Json = Record<string, unknown>;

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
}

function products(node: unknown, out: Json[]): void {
  for (const n of asArray(node)) {
    if (!n || typeof n !== 'object') continue;
    const o = n as Json;
    const types = asArray(o['@type']).map(String);
    if (types.includes('Product')) out.push(o);
    if (o['@graph']) products(o['@graph'], out);
    if (types.includes('ProductGroup') && o['hasVariant']) products(o['hasVariant'], out);
  }
}

function text(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (v && typeof v === 'object' && 'name' in (v as Json)) return text((v as Json)['name']);
  return '';
}

/** Pris i kroner som tal eller tekst ("1299.95", "1.299,95") -> øre. */
export function priceToOere(v: unknown): number | null {
  let s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim().replace(/\s|kr\.?|dkk/gi, '') : '';
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(parseFloat(s) * 100);
  return Number.isSafeInteger(n) && n > 0 && n < 100_000_000_00 ? n : null;
}

const AVAIL: Record<string, string> = {
  instock: 'På lager ifølge siden',
  outofstock: 'Ikke på lager ifølge siden',
  limitedavailability: 'Begrænset antal ifølge siden',
  preorder: 'Kan forudbestilles ifølge siden',
  backorder: 'Restordre ifølge siden',
  instoreonly: 'Kun i butik ifølge siden',
  onlineonly: 'Kun online ifølge siden',
};

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Finder ét entydigt produkt med én pris i danske kroner. Flere forskellige priser (fx et
 * prisinterval eller flere varianter) giver ingen pris, så vi ikke vælger en tilfældig.
 */
export function parseProductPage(html: string): { ok: true; product: PageProduct } | { ok: false; reason: string } {
  const found: Json[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      products(JSON.parse(m[1]!.trim()), found);
    } catch {
      // Ugyldig JSON-LD springes over
    }
  }
  const candidates: PageProduct[] = [];
  for (const p of found) {
    for (const offer of asArray(p['offers'])) {
      if (!offer || typeof offer !== 'object') continue;
      const o = offer as Json;
      const types = asArray(o['@type']).map(String);
      if (types.includes('AggregateOffer') && !o['price']) continue; // prisinterval: ingen entydig pris
      const spec = asArray(o['priceSpecification'])[0] as Json | undefined;
      const currency = text(o['priceCurrency'] ?? spec?.['priceCurrency']).toUpperCase();
      const price = priceToOere(o['price'] ?? spec?.['price']);
      if (currency !== 'DKK' || price === null) continue;
      const avail = text(o['availability']).replace(/^https?:\/\/schema\.org\//i, '').toLowerCase();
      candidates.push({
        name: text(p['name']).slice(0, 200),
        price,
        gtin: normGtin(text(p['gtin13'] ?? p['gtin'] ?? p['gtin14'] ?? p['gtin12'] ?? p['gtin8'])) ?? '',
        mpn: text(p['mpn']).slice(0, 60),
        brand: text(p['brand']).slice(0, 60),
        sku: text(p['sku']).slice(0, 60),
        availability: AVAIL[avail] ?? '',
      });
    }
  }
  if (!candidates.length) {
    // Open Graph som reserve (kun når valutaen er kroner)
    const meta = (prop: string) => {
      const m =
        new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i').exec(html) ??
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i').exec(html);
      return m ? decodeEntities(m[1]!) : '';
    };
    const price = priceToOere(meta('product:price:amount') || meta('og:price:amount'));
    const cur = (meta('product:price:currency') || meta('og:price:currency')).toUpperCase();
    if (price !== null && cur === 'DKK') {
      candidates.push({ name: meta('og:title').slice(0, 200), price, gtin: '', mpn: '', brand: meta('product:brand').slice(0, 60), sku: '', availability: '' });
    }
  }
  if (!candidates.length) {
    if (/captcha|cf-challenge|are you a robot|er du et menneske/i.test(html)) return { ok: false, reason: 'Siden viser en robotkontrol (CAPTCHA). Den omgås ikke.' };
    return { ok: false, reason: 'Siden har ingen entydig pris i kroner i sine produktdata.' };
  }
  const prices = new Set(candidates.map((c) => c.price));
  if (prices.size > 1) return { ok: false, reason: 'Siden har flere forskellige priser (fx varianter). Link til den præcise variant.' };
  const best = candidates.find((c) => c.gtin) ?? candidates[0]!;
  return { ok: true, product: { ...best, name: best.name || candidates.find((c) => c.name)?.name || '' } };
}
