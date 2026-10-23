// Forslag til virksomhedsoplysninger og en kort, dokumenteret vurdering ud fra en offentlig hjemmeside.
// Kun det, der faktisk står på de hentede sider, foreslås. Ukendte oplysninger er tomme, og alt er
// markeret som ubekræftet, indtil en medarbejder har gennemgået det.
import type { Env } from '../env';
import { normalizeEmail } from './db';
import { COMMON_MAIL_DOMAINS, domainOf, normCvr } from './prospects';
import { checkLink, safeFetch, type FetchedPage } from './safe-fetch';

export interface Suggestion {
  company: string | null;
  website: string | null;
  emails: string[];
  phones: string[];
  cvr: string | null;
  address: string | null;
  city: string | null;
  description: string | null;
  pages: { url: string; status: number; title: string | null }[];
  fetchedAt: number;
}

export interface Observation {
  kind: string;
  text: string;
  page: string;
}

export interface Assessment {
  observations: Observation[];
  suggestions: string[];
  notChecked: string[];
  pages: string[];
  checkedLinks: number;
  createdAt: number;
}

// ---------- HTML-hjælpere (uden DOM; regulære udtryk på et begrænset dokument) ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aelig: 'æ', oslash: 'ø', aring: 'å', AElig: 'Æ', Oslash: 'Ø', Aring: 'Å', copy: '©' };
export function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n] ?? m);
}

/** Synlig tekst: uden scripts, styles, kommentarer og tags */
export function visibleText(html: string): string {
  return decode(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function meta(html: string, key: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const t = m[0];
    if ((attr(t, 'name') ?? attr(t, 'property') ?? '').toLowerCase() === key) return attr(t, 'content')?.trim() || null;
  }
  return null;
}

export function titleOf(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decode(m[1]!).replace(/\s+/g, ' ').trim() || null : null;
}

export interface Link {
  href: string;
  text: string;
}

export function linksOf(html: string, base: string): Link[] {
  const out: Link[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1]!, 'href');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    let abs: string;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    out.push({ href: abs, text: visibleText(m[2]!).replace(/\s+/g, ' ').slice(0, 120) || (attr(m[1]!, 'title') ?? attr(m[1]!, 'aria-label') ?? '') });
    if (out.length >= 1500) break;
  }
  return out;
}

function jsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const v = JSON.parse(m[1]!.trim());
      const walk = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === 'object') {
          out.push(x as Record<string, unknown>);
          const g = (x as Record<string, unknown>)['@graph'];
          if (g) walk(g);
        }
      };
      walk(v);
    } catch {
      /* ugyldig JSON-LD ignoreres */
    }
  }
  return out;
}

const ORG_TYPES = /Organization|LocalBusiness|Store|Restaurant|Corporation|ProfessionalService|Hotel|Shop|Bakery|Cafe|Brewery|Winery|Farm|Dentist|Physician|HealthAndBeautyBusiness|AutomotiveBusiness|HomeAndConstructionBusiness|FoodEstablishment/i;

// ---------- Udtræk ----------

export function extractContacts(html: string, siteDomain: string | null): { emails: string[]; phones: string[]; cvr: string | null } {
  const emails = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) {
    const e = normalizeEmail(decodeURIComponent(m[1]!));
    if (e) emails.add(e);
  }
  const text = visibleText(html);
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const e = normalizeEmail(m[0]);
    if (e && !/\.(png|jpe?g|gif|webp|svg)$/i.test(e)) emails.add(e);
  }
  // Kun adresser på virksomhedens eget domæne eller en almindelig mailudbyder (ikke fx webbureauets)
  const keep = [...emails].filter((e) => {
    const d = e.split('@')[1]!;
    return !siteDomain || d === siteDomain || d.endsWith('.' + siteDomain) || COMMON_MAIL_DOMAINS.has(d);
  });
  const phones = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)/gi)) {
    const digits = decodeURIComponent(m[1]!).replace(/[^\d+]/g, '');
    const local = digits.replace(/^(\+45|0045)/, '');
    if (/^\d{8}$/.test(local)) phones.add(local.replace(/(\d{2})(?=\d)/g, '$1 ').trim());
  }
  // Telefonnumre i teksten kun, når de står ved "tlf", "telefon" eller "phone"
  for (const m of text.matchAll(/(?:tlf|telefon|phone|mobil|ring)\.?:?\s*((?:\+45[\s.-]?)?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2})/gi)) {
    const local = m[1]!.replace(/[^\d]/g, '').replace(/^45(?=\d{8}$)/, '');
    if (/^\d{8}$/.test(local)) phones.add(local.replace(/(\d{2})(?=\d)/g, '$1 ').trim());
  }
  const cvrM = /CVR(?:[\s.-]*(?:nr|nummer|no))?\.?\s*:?\s*(?:DK)?\s*(\d{2}\s?\d{2}\s?\d{2}\s?\d{2})\b/i.exec(text);
  return { emails: keep.slice(0, 10), phones: [...phones].slice(0, 5), cvr: cvrM ? normCvr(cvrM[1]!.replace(/\s/g, '')) : null };
}

function cleanTitle(t: string | null): string | null {
  if (!t) return null;
  const parts = t.split(/\s+[|–—-]\s+/).map((x) => x.trim()).filter(Boolean);
  const pick = parts.length > 1 ? parts[parts.length - 1]! : parts[0]!;
  return pick && pick.length <= 80 && !/^(forside|home|hjem|velkommen|welcome)$/i.test(pick) ? pick : null;
}

const CONTACT_RE = /kontakt|contact|om-os|om_os|omos|about|find-os|findos/i;

/** Henter forsiden og op til to kontakt-/om-os-sider og foreslår oplysninger */
export async function scanSite(env: Env, rawUrl: string): Promise<{ suggestion: Suggestion; pages: FetchedPage[] }> {
  const first = await safeFetch(env, /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  if (!first.body) throw new Error(first.status >= 400 ? `Hjemmesiden svarede med fejl ${first.status}.` : 'Adressen er ikke en HTML-side.');
  const origin = new URL(first.url);
  const domain = domainOf(origin.hostname);
  const pages: FetchedPage[] = [first];
  const contactLinks = linksOf(first.body, first.url)
    .filter((l) => {
      try {
        const u = new URL(l.href);
        return domainOf(u.hostname) === domain && (CONTACT_RE.test(u.pathname) || CONTACT_RE.test(l.text)) && u.pathname !== origin.pathname;
      } catch {
        return false;
      }
    })
    .map((l) => l.href.split('#')[0]!);
  for (const href of [...new Set(contactLinks)].slice(0, 2)) {
    try {
      const p = await safeFetch(env, href);
      if (p.body) pages.push(p);
    } catch {
      /* en kontaktside, der ikke kan hentes, springes over */
    }
  }
  const emails = new Set<string>();
  const phones = new Set<string>();
  let cvr: string | null = null;
  let company: string | null = null;
  let address: string | null = null;
  let city: string | null = null;
  for (const p of pages) {
    const c = extractContacts(p.body, domain);
    c.emails.forEach((e) => emails.add(e));
    c.phones.forEach((x) => phones.add(x));
    cvr ??= c.cvr;
    for (const o of jsonLd(p.body)) {
      const t = String(o['@type'] ?? '');
      if (!ORG_TYPES.test(t)) continue;
      if (!company && typeof o.name === 'string') company = o.name.trim().slice(0, 120) || null;
      if (typeof o.email === 'string') {
        const e = normalizeEmail(o.email.replace(/^mailto:/i, ''));
        if (e) emails.add(e);
      }
      if (typeof o.telephone === 'string') {
        const local = o.telephone.replace(/[^\d]/g, '').replace(/^45(?=\d{8}$)/, '');
        if (/^\d{8}$/.test(local)) phones.add(local.replace(/(\d{2})(?=\d)/g, '$1 ').trim());
      }
      const vat = typeof o.vatID === 'string' ? o.vatID : typeof o.taxID === 'string' ? o.taxID : null;
      if (!cvr && vat) cvr = normCvr(vat.replace(/^DK/i, ''));
      const adr = o.address as Record<string, unknown> | undefined;
      if (adr && typeof adr === 'object') {
        if (!address && typeof adr.streetAddress === 'string') address = [adr.streetAddress, adr.postalCode].filter((x) => typeof x === 'string').join(', ').slice(0, 200);
        if (!city && typeof adr.addressLocality === 'string') city = adr.addressLocality.slice(0, 100);
      }
    }
  }
  company ??= meta(first.body, 'og:site_name')?.slice(0, 120) ?? cleanTitle(titleOf(first.body));
  return {
    pages,
    suggestion: {
      company,
      website: origin.origin + '/',
      emails: [...emails].slice(0, 10),
      phones: [...phones].slice(0, 5),
      cvr,
      address,
      city,
      description: meta(first.body, 'description')?.slice(0, 300) ?? null,
      pages: pages.map((p) => ({ url: p.url, status: p.status, title: titleOf(p.body) })),
      fetchedAt: first.fetchedAt,
    },
  };
}

// ---------- Vurdering ----------

const PLACEHOLDERS: [RegExp, string][] = [
  [/lorem ipsum/i, 'lorem ipsum'],
  [/\bcoming soon\b/i, 'coming soon'],
  [/\bkommer snart\b/i, 'kommer snart'],
  [/\bunder (?:opbygning|konstruktion|construction)\b/i, 'under opbygning'],
  [/just another wordpress site/i, 'Just another WordPress site'],
  [/\bhello world!?/i, 'Hello world'],
  [/\bsample page\b/i, 'Sample Page'],
  [/skriv (?:din|jeres) tekst her|your text here|indsæt tekst her/i, 'pladsholdertekst ("skriv din tekst her")'],
];

const BUY_RE = /læg i kurv|tilføj til kurv|add to cart|\bkurv\b|\bcheckout\b|\bbestil\b|\bbook\b|\bbooking\b|\bkøb\b|\bwebshop\b|\bpriser?\b|\d\s?kr\.|\bdkk\b/i;

/**
 * Kort vurdering ud fra de hentede sider. Kun konkrete fund noteres som observationer, med siden, de stammer fra.
 * Hastighed, mobilvisning og lignende påstås ikke, da de ikke er testet.
 */
export async function assess(env: Env, pages: FetchedPage[], opts: { checkLinks?: number; now?: number } = {}): Promise<Assessment> {
  const obs: Observation[] = [];
  const sugg = new Set<string>();
  const first = pages[0]!;
  const origin = new URL(first.url);
  const domain = domainOf(origin.hostname);
  if (origin.protocol === 'http:') {
    obs.push({ kind: 'https', text: 'Forsiden blev leveret uden HTTPS (http://).', page: first.url });
    sugg.add('Sæt HTTPS op, så besøgende ikke får advarsler i browseren.');
  }
  if (!titleOf(first.body)) {
    obs.push({ kind: 'titel', text: 'Forsiden har ingen sidetitel (<title>).', page: first.url });
    sugg.add('Giv forsiden en sidetitel med virksomhedens navn og ydelse.');
  }
  if (!meta(first.body, 'description')) {
    obs.push({ kind: 'beskrivelse', text: 'Forsiden har ingen metabeskrivelse (vises ofte i søgeresultater).', page: first.url });
    sugg.add('Skriv en kort metabeskrivelse af virksomheden.');
  }
  for (const p of pages) {
    const text = visibleText(p.body);
    for (const [re, label] of PLACEHOLDERS) {
      if (re.test(text)) {
        obs.push({ kind: 'pladsholder', text: `Siden indeholder pladsholdertekst: "${label}".`, page: p.url });
        sugg.add('Erstat pladsholdertekst med rigtigt indhold.');
      }
    }
  }
  const year = new Date((opts.now ?? Date.now() / 1000) * 1000).getUTCFullYear();
  const years = [...visibleText(first.body).matchAll(/(?:©|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1]));
  if (years.length && Math.max(...years) <= year - 2) {
    obs.push({ kind: 'aarstal', text: `Copyright-året på forsiden er ${Math.max(...years)}.`, page: first.url });
    sugg.add('Opdatér årstal og indhold, så siden ikke virker forladt.');
  }
  const allText = pages.map((p) => visibleText(p.body)).join('\n');
  const contacts = pages.map((p) => extractContacts(p.body, domain));
  if (!contacts.some((c) => c.emails.length || c.phones.length)) {
    obs.push({ kind: 'kontakt', text: `Vi fandt hverken mailadresse eller telefonnummer på de ${pages.length} hentede sider.`, page: first.url });
    sugg.add('Vis mail og telefon tydeligt, fx i sidens bund og på en kontaktside.');
  }
  if (!BUY_RE.test(allText)) {
    obs.push({ kind: 'koeb', text: `Vi fandt ingen priser, kurv, bestillings- eller bookingknap på de ${pages.length} hentede sider.`, page: first.url });
    sugg.add('Gør det tydeligt, hvordan man køber, bestiller eller booker, og hvad det koster.');
  }
  if (!/<meta[^>]+name\s*=\s*["']?viewport/i.test(first.body)) {
    obs.push({ kind: 'viewport', text: 'Forsiden har ingen viewport-angivelse i koden (meta viewport). Visningen på mobil er ikke testet.', page: first.url });
  }
  // Brudte links: kontrollér et begrænset antal links på samme domæne
  const max = opts.checkLinks ?? 12;
  const internal = [
    ...new Map(
      linksOf(first.body, first.url)
        .filter((l) => {
          try {
            const u = new URL(l.href);
            return (u.protocol === 'https:' || u.protocol === 'http:') && domainOf(u.hostname) === domain;
          } catch {
            return false;
          }
        })
        .map((l) => [l.href.split('#')[0]!, l] as const),
    ).values(),
  ].slice(0, max);
  let checked = 0;
  for (const l of internal) {
    const status = await checkLink(env, l.href);
    if (status === null) continue;
    checked++;
    if (status === 404 || status === 410 || status >= 500) {
      obs.push({ kind: 'brudt-link', text: `Linket "${l.text || l.href}" (${l.href}) gav fejl ${status} ved kontrol.`, page: first.url });
      sugg.add('Ret eller fjern brudte links.');
    }
  }
  const notChecked = [
    'Hastighed og indlæsningstid er ikke målt.',
    'Visning på mobil og tablet er ikke testet på en enhed.',
    'Placering i Google og anden synlighed er ikke undersøgt.',
    'Tilgængelighed (fx WCAG) er ikke undersøgt.',
    'Indhold, der først vises med JavaScript, er ikke set.',
    `Kun ${pages.length} ${pages.length === 1 ? 'side' : 'sider'} er hentet${internal.length ? `, og ${checked} links er kontrolleret` : ''}; resten af hjemmesiden er ikke gennemgået.`,
  ];
  return { observations: obs, suggestions: [...sugg], notChecked, pages: pages.map((p) => p.url), checkedLinks: checked, createdAt: Math.floor(Date.now() / 1000) };
}

// ---------- Søgning i offentlige kilder ----------

const SKIP_HOSTS = /(^|\.)((facebook|instagram|linkedin|twitter|x|youtube|youtu|tiktok|pinterest|google|goo|apple|microsoft|wikipedia|vimeo|spotify|mailchimp|cookiebot|cookieinformation|wordpress|wix|squarespace|shopify|issuu|flickr|tripadvisor|trustpilot|maps|bit|linktr)\.[a-z.]+)$/i;

export interface FoundCompany {
  company: string;
  website: string;
  domain: string;
}

/** Eksterne links på en kildeside (fx en udstillerliste) som mulige virksomheder */
export function companiesFromSource(page: FetchedPage, limit = 200): FoundCompany[] {
  const srcDomain = domainOf(new URL(page.url).hostname);
  const out = new Map<string, FoundCompany>();
  for (const l of linksOf(page.body, page.url)) {
    let u: URL;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    const d = domainOf(u.hostname);
    if (!d || d === srcDomain || d.endsWith('.' + srcDomain) || SKIP_HOSTS.test(d) || COMMON_MAIL_DOMAINS.has(d)) continue;
    if (out.has(d)) continue;
    const text = l.text.replace(/\s+/g, ' ').trim();
    const name = text && text.length >= 2 && text.length <= 80 && !/^(læs mere|read more|hjemmeside|website|www\.|https?:)/i.test(text) ? text : d;
    out.set(d, { company: name, website: `${u.protocol}//${u.host}/`, domain: d });
    if (out.size >= limit) break;
  }
  return [...out.values()];
}
