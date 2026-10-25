// Kundeemner: virksomheder, Veyro selv finder og undersøger. Statusser, kontakthistorik, opfølgning,
// dubletter, sammenlægning, blokeringer (blacklisting), arkivering og overgang til kunde.
// Alt her er internt for Veyro-administratorer (se routes/admin-prospects.ts).
import type { Env } from '../env';
import { nowSec } from './crypto';
import { normalizeEmail } from './db';
import { parseAdminEmails } from './session';
import { addDays, dayOf } from './stats';

// ---------- Konstanter ----------

export const PROSPECT_STATUSES = ['undersoeges', 'klar', 'afventer', 'dialog', 'afslag', 'kunde'] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
export const STATUS_LABEL: Record<ProspectStatus, string> = {
  undersoeges: 'Skal undersøges',
  klar: 'Klar til kontakt',
  afventer: 'Afventer svar',
  dialog: 'I dialog',
  afslag: 'Afslag',
  kunde: 'Blev kunde',
};
export const STATUS_TONE: Record<ProspectStatus, 'neutral' | 'info' | 'warn' | 'ok' | 'err' | 'accent'> = {
  undersoeges: 'neutral',
  klar: 'accent',
  afventer: 'warn',
  dialog: 'info',
  afslag: 'err',
  kunde: 'ok',
};

export const PRIORITIES = ['hoej', 'mellem', 'lav'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { hoej: 'Høj', mellem: 'Mellem', lav: 'Lav' };

export const CHANNELS = ['mail', 'telefon', 'moede', 'andet'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = { mail: 'Mail', telefon: 'Telefon', moede: 'Fysisk møde', andet: 'Andet' };

export const BLOCK_SCOPES = ['email', 'domain', 'company'] as const;
export type BlockScope = (typeof BLOCK_SCOPES)[number];
export const BLOCK_SCOPE_LABEL: Record<BlockScope, string> = { email: 'Mailadresse', domain: 'Virksomhedsdomæne', company: 'Virksomhed' };

/** Arbejdsfiltre i oversigten */
export const VIEWS = ['aktive', 'mine', 'uden-ansvarlig', 'klar', 'i-dag', 'overskredet', 'afventer', 'arkiverede', 'blacklistede', 'alle'] as const;
export type ProspectView = (typeof VIEWS)[number];
export const VIEW_LABEL: Record<ProspectView, string> = {
  aktive: 'Aktive',
  mine: 'Mine kundeemner',
  'uden-ansvarlig': 'Mangler ansvarlig',
  klar: 'Klar til kontakt',
  'i-dag': 'Opfølgning i dag',
  overskredet: 'Overskredet opfølgning',
  afventer: 'Afventer svar',
  arkiverede: 'Arkiverede',
  blacklistede: 'Blacklistede',
  alle: 'Alle',
};

/** Fælles mailudbydere: et domæne her siger intet om, hvilken virksomhed der står bag. */
export const COMMON_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.dk', 'outlook.com', 'outlook.dk', 'live.com', 'live.dk', 'msn.com',
  'yahoo.com', 'yahoo.dk', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'gmx.com', 'gmx.net',
  'mail.dk', 'jubii.dk', 'sol.dk', 'ofir.dk', 'webspeed.dk', 'post.tele.dk', 'tdcadsl.dk', 'youmail.dk', 'stofanet.dk',
  'privat.dk', 'mail.com', 'zoho.com', 'yandex.com', 'fastmail.com', 'hey.com',
]);

export const PAGE_SIZE = 50;

// ---------- Rækker ----------

export interface ProspectRow {
  id: number;
  company: string;
  cvr: string | null;
  industry: string | null;
  city: string | null;
  address: string | null;
  area: string | null;
  website: string | null;
  domain: string | null;
  contact_name: string | null;
  source: string | null;
  source_url: string | null;
  found_on: string | null;
  needs: string | null;
  services: string | null;
  priority: Priority;
  owner: string | null;
  status: ProspectStatus;
  status_set_at: number | null;
  status_set_by: string | null;
  next_action: string | null;
  follow_up_on: string | null;
  follow_up_review: number;
  suggested_status: string | null;
  suggested_owner: string | null;
  notes: string | null;
  last_contact_at: number | null;
  archived_at: number | null;
  import_id?: number | null;
  import_row?: number | null;
  archived_by: string | null;
  blacklisted: number;
  customer_id: number | null;
  lead_id: number | null;
  merged_into: number | null;
  unverified: string;
  fetched_from: string | null;
  fetched_at: number | null;
  assessment: string | null;
  assessment_approved_at: number | null;
  assessment_approved_by: string | null;
  version: number;
  created_at: number;
  created_by: string | null;
  updated_at: number;
  updated_by: string | null;
}

export interface ContactRow {
  id: number;
  prospect_id: number;
  kind: 'email' | 'phone';
  value: string;
  label: string | null;
  unverified: number;
  bounced_at: number | null;
  created_at: number;
}

export interface EventRow {
  id: number;
  prospect_id: number;
  at: number;
  kind: string;
  channel: string | null;
  actor: string | null;
  contact_person: string | null;
  body: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: number;
}

export interface BlockRow {
  id: number;
  scope: BlockScope;
  value: string;
  company: string | null;
  reason: string;
  prospect_id: number | null;
  created_at: number;
  created_by: string;
  lifted_at: number | null;
  lifted_by: string | null;
  lift_reason: string | null;
}

// ---------- Normalisering ----------

export function today(now = nowSec()): string {
  return dayOf(now);
}

export function isDay(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d && y! >= 2000 && y! <= 2100;
}

/** Lægger arbejdsdage (man–fre) til en dato. Helligdage tælles ikke med. */
export function addWorkdays(day: string, n: number): string {
  let d = day;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

/** Domæne fra en hjemmeside eller mailadresse: små bogstaver, uden "www." */
export function domainOf(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (s.includes('@') && !s.includes('/')) s = s.split('@').pop()!;
  else {
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'https://' + s;
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  s = s.replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) && s.length <= 253 ? s : null;
}

export function isCommonDomain(domain: string | null): boolean {
  return !!domain && COMMON_MAIL_DOMAINS.has(domain);
}

/** Virksomhedsdomæne, der kan bruges som signal (ikke fælles mailudbydere) */
export function companyDomain(input: string | null | undefined): string | null {
  const d = domainOf(input);
  return d && !isCommonDomain(d) ? d : null;
}

/** Navn til sammenligning: små bogstaver, uden selskabsform og tegn */
export function normName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/\b(aps|a\/s|as|i\/s|ivs|k\/s|p\/s|smba|amba|holding|v\/.*)$/g, '')
    .replace(/[^a-z0-9æøå]+/g, ' ')
    .replace(/\b(aps|as|is|ivs|ks|ps)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normCvr(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const d = raw.replace(/^\s*(dk)?/i, '').replace(/[\s-]/g, '');
  return /^\d{8}$/.test(d) ? d : null;
}

export function normWebsite(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!domainOf(u.hostname)) return null;
    return u.toString().slice(0, 300);
  } catch {
    return null;
  }
}

/** Et sikkert link (kun http/https) eller null */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

// ---------- Medarbejdere ----------

/** Fælles postkasser (ikke personer), fx kontakt@veyro.dk */
export function sharedMailboxes(env: Env): Set<string> {
  return new Set((env.SHARED_MAILBOXES ?? 'kontakt@veyro.dk').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** Veyro-medarbejdere, der kan være ansvarlige og registrere tid: admins og personlige mailkonti, ikke fælles postkasser. */
export function staffList(env: Env): string[] {
  const shared = sharedMailboxes(env);
  const all = new Set<string>([...parseAdminEmails(env), ...mailAccounts(env)]);
  return [...all].filter((e) => !shared.has(e)).sort();
}

/** Google Workspace-konti, der kan forbindes (MAIL_ACCOUNTS) */
export function mailAccounts(env: Env): string[] {
  return (env.MAIL_ACCOUNTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => !!normalizeEmail(s));
}

export function staffName(email: string | null | undefined): string {
  if (!email) return '–';
  const local = email.split('@')[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// ---------- Oversigt og søgning ----------

export interface ListFilter {
  view: ProspectView;
  q: string;
  status: ProspectStatus | null;
  owner: string | null; // e-mail eller 'ingen'
  priority: Priority | null;
  industry: string | null;
  area: string | null;
  importId: number | null; // kun kundeemner fra én import
  page: number;
}

export function readFilter(query: (k: string) => string | undefined): ListFilter {
  const v = query('visning');
  const s = query('status');
  const p = query('prioritet');
  const page = Number.parseInt(query('side') ?? '1', 10);
  const imp = Number.parseInt(query('import') ?? '', 10);
  const str = (k: string) => (query(k) ?? '').trim().slice(0, 100) || null;
  return {
    view: (VIEWS as readonly string[]).includes(v ?? '') ? (v as ProspectView) : 'aktive',
    q: (query('q') ?? '').trim().slice(0, 100),
    status: (PROSPECT_STATUSES as readonly string[]).includes(s ?? '') ? (s as ProspectStatus) : null,
    owner: str('ansvarlig'),
    priority: (PRIORITIES as readonly string[]).includes(p ?? '') ? (p as Priority) : null,
    industry: str('branche'),
    area: str('omraade'),
    importId: Number.isSafeInteger(imp) && imp > 0 ? imp : null,
    page: Number.isSafeInteger(page) && page > 0 && page < 10000 ? page : 1,
  };
}

/** Salgsaktivt: ikke afslag, kunde, arkiveret eller blokeret. Kun salgsaktive emner har opfølgning. */
export const SALES_ACTIVE_SQL = "p.archived_at IS NULL AND p.blacklisted = 0 AND p.status NOT IN ('afslag', 'kunde')";

function where(f: ListFilter, me: string, todayStr: string): { sql: string; args: unknown[] } {
  const w: string[] = ['p.merged_into IS NULL'];
  const args: unknown[] = [];
  const add = (clause: string, ...a: unknown[]) => {
    w.push(clause);
    args.push(...a);
  };
  if (f.view === 'arkiverede') add('p.archived_at IS NOT NULL');
  else if (f.view === 'blacklistede') add('p.blacklisted = 1');
  else if (f.view !== 'alle') add('p.archived_at IS NULL AND p.blacklisted = 0');
  if (f.view === 'mine') add('p.owner = ?', me);
  if (f.view === 'uden-ansvarlig') add('p.owner IS NULL');
  if (f.view === 'klar') add("p.status = 'klar'");
  if (f.view === 'afventer') add("p.status = 'afventer'");
  if (f.view === 'i-dag') add(`${SALES_ACTIVE_SQL} AND p.follow_up_on = ?`, todayStr);
  if (f.view === 'overskredet') add(`${SALES_ACTIVE_SQL} AND p.follow_up_on < ?`, todayStr);
  if (f.status) add('p.status = ?', f.status);
  if (f.owner === 'ingen') add('p.owner IS NULL');
  else if (f.owner) add('p.owner = ?', f.owner.toLowerCase());
  if (f.priority) add('p.priority = ?', f.priority);
  if (f.industry) add('p.industry = ? COLLATE NOCASE', f.industry);
  if (f.area) add('(p.area = ? COLLATE NOCASE OR p.city = ? COLLATE NOCASE)', f.area, f.area);
  if (f.importId) add('p.import_id = ?', f.importId);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    const cols = ['p.company', 'p.city', 'p.contact_name', 'p.domain', 'p.cvr', 'p.industry'];
    add(
      `(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')}
        OR EXISTS (SELECT 1 FROM prospect_contacts pc WHERE pc.prospect_id = p.id AND pc.value LIKE ? ESCAPE '\\'))`,
      ...cols.map(() => like),
      like,
    );
  }
  return { sql: w.join(' AND '), args };
}

export interface ProspectListRow extends ProspectRow {}

export async function listProspects(
  db: D1Database,
  f: ListFilter,
  me: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ rows: ProspectListRow[]; total: number }> {
  const { sql, args } = where(f, me, today());
  const limit = opts.limit ?? PAGE_SIZE;
  const offset = opts.offset ?? (f.page - 1) * PAGE_SIZE;
  const order =
    f.view === 'i-dag' || f.view === 'overskredet'
      ? 'p.follow_up_on ASC, p.id'
      : "CASE p.priority WHEN 'hoej' THEN 0 WHEN 'mellem' THEN 1 ELSE 2 END, COALESCE(p.follow_up_on, '9999'), p.updated_at DESC";
  const [rows, count] = await db.batch([
    db.prepare(`SELECT p.* FROM prospects p WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...args, limit, offset),
    db.prepare(`SELECT COUNT(*) AS n FROM prospects p WHERE ${sql}`).bind(...args),
  ]);
  return { rows: (rows?.results ?? []) as ProspectListRow[], total: ((count?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0 };
}

/** Antal pr. arbejdsfilter (til fanerne) */
export async function viewCounts(db: D1Database, me: string): Promise<Record<string, number>> {
  const t = today();
  const row = await db
    .prepare(
      `SELECT
        SUM(CASE WHEN archived_at IS NULL AND blacklisted = 0 THEN 1 ELSE 0 END) AS aktive,
        SUM(CASE WHEN archived_at IS NULL AND blacklisted = 0 AND owner = ?1 THEN 1 ELSE 0 END) AS mine,
        SUM(CASE WHEN archived_at IS NULL AND blacklisted = 0 AND owner IS NULL THEN 1 ELSE 0 END) AS uden,
        SUM(CASE WHEN archived_at IS NULL AND blacklisted = 0 AND status = 'klar' THEN 1 ELSE 0 END) AS klar,
        SUM(CASE WHEN archived_at IS NULL AND blacklisted = 0 AND status NOT IN ('afslag','kunde') AND follow_up_on = ?2 THEN 1 ELSE 0 END) AS idag,
        SUM(CASE WHEN archived_at IS NULL AND blacklisted = 0 AND status NOT IN ('afslag','kunde') AND follow_up_on < ?2 THEN 1 ELSE 0 END) AS over,
        SUM(CASE WHEN archived_at IS NULL AND blacklisted = 0 AND status = 'afventer' THEN 1 ELSE 0 END) AS afventer,
        SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS arkiv,
        SUM(CASE WHEN blacklisted = 1 THEN 1 ELSE 0 END) AS black
       FROM prospects WHERE merged_into IS NULL`,
    )
    .bind(me, t)
    .first<Record<string, number | null>>();
  const n = (k: string) => Number(row?.[k] ?? 0);
  return {
    aktive: n('aktive'),
    mine: n('mine'),
    'uden-ansvarlig': n('uden'),
    klar: n('klar'),
    'i-dag': n('idag'),
    overskredet: n('over'),
    afventer: n('afventer'),
    arkiverede: n('arkiv'),
    blacklistede: n('black'),
  };
}

/** Brancher og områder, der er i brug (til filtrene) */
export async function filterOptions(db: D1Database): Promise<{ industries: string[]; areas: string[] }> {
  const [ind, area] = await db.batch([
    db.prepare("SELECT DISTINCT industry AS v FROM prospects WHERE industry IS NOT NULL AND industry != '' ORDER BY industry COLLATE NOCASE LIMIT 200"),
    db.prepare(
      "SELECT v FROM (SELECT area AS v FROM prospects WHERE area IS NOT NULL AND area != '' UNION SELECT city FROM prospects WHERE city IS NOT NULL AND city != '') ORDER BY v COLLATE NOCASE LIMIT 300",
    ),
  ]);
  return {
    industries: ((ind?.results ?? []) as { v: string }[]).map((r) => r.v),
    areas: ((area?.results ?? []) as { v: string }[]).map((r) => r.v),
  };
}

// ---------- Ét kundeemne ----------

export async function getProspect(db: D1Database, id: number): Promise<ProspectRow | null> {
  return db.prepare('SELECT * FROM prospects WHERE id = ?').bind(id).first<ProspectRow>();
}

export async function listContacts(db: D1Database, id: number): Promise<ContactRow[]> {
  return (await db.prepare('SELECT * FROM prospect_contacts WHERE prospect_id = ? ORDER BY kind, id').bind(id).all<ContactRow>()).results ?? [];
}

export async function listEvents(db: D1Database, id: number, limit = 200): Promise<EventRow[]> {
  return (await db.prepare('SELECT * FROM prospect_events WHERE prospect_id = ? ORDER BY at DESC, id DESC LIMIT ?').bind(id, limit).all<EventRow>()).results ?? [];
}

export function addEvent(
  db: D1Database,
  prospectId: number,
  e: { kind: string; actor: string | null; at?: number; channel?: string | null; contact_person?: string | null; body?: string | null; old_value?: string | null; new_value?: string | null },
): D1PreparedStatement {
  const now = nowSec();
  return db
    .prepare(
      'INSERT INTO prospect_events (prospect_id, at, kind, channel, actor, contact_person, body, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(prospectId, e.at ?? now, e.kind, e.channel ?? null, e.actor, e.contact_person ?? null, e.body ?? null, e.old_value ?? null, e.new_value ?? null, now);
}

// ---------- Formular ----------

export interface ProspectForm {
  company: string;
  cvr: string;
  industry: string;
  city: string;
  address: string;
  area: string;
  website: string;
  contact_name: string;
  emails: string;
  phones: string;
  source: string;
  source_url: string;
  found_on: string;
  needs: string;
  services: string;
  priority: string;
  owner: string;
  status: string;
  next_action: string;
  follow_up_on: string;
  notes: string;
}

export const FORM_FIELDS: (keyof ProspectForm)[] = [
  'company', 'cvr', 'industry', 'city', 'address', 'area', 'website', 'contact_name', 'emails', 'phones', 'source', 'source_url',
  'found_on', 'needs', 'services', 'priority', 'owner', 'status', 'next_action', 'follow_up_on', 'notes',
];

export function readProspectForm(body: Record<string, unknown>): ProspectForm {
  const out = {} as ProspectForm;
  for (const k of FORM_FIELDS) out[k] = typeof body[k] === 'string' ? (body[k] as string).trim() : '';
  return out;
}

export function emptyForm(): ProspectForm {
  const f = readProspectForm({});
  f.priority = 'mellem';
  f.status = 'undersoeges';
  f.found_on = today();
  return f;
}

export function formFromProspect(p: ProspectRow, contacts: ContactRow[]): ProspectForm {
  return {
    company: p.company,
    cvr: p.cvr ?? '',
    industry: p.industry ?? '',
    city: p.city ?? '',
    address: p.address ?? '',
    area: p.area ?? '',
    website: p.website ?? '',
    contact_name: p.contact_name ?? '',
    emails: contacts.filter((c) => c.kind === 'email').map((c) => c.value).join('\n'),
    phones: contacts.filter((c) => c.kind === 'phone').map((c) => c.value).join('\n'),
    source: p.source ?? '',
    source_url: p.source_url ?? '',
    found_on: p.found_on ?? '',
    needs: p.needs ?? '',
    services: p.services ?? '',
    priority: p.priority,
    owner: p.owner ?? '',
    status: p.status,
    next_action: p.next_action ?? '',
    follow_up_on: p.follow_up_on ?? '',
    notes: p.notes ?? '',
  };
}

export interface ProspectDraft {
  company: string;
  cvr: string | null;
  industry: string | null;
  city: string | null;
  address: string | null;
  area: string | null;
  website: string | null;
  domain: string | null;
  contact_name: string | null;
  emails: string[];
  phones: string[];
  source: string | null;
  source_url: string | null;
  found_on: string | null;
  needs: string | null;
  services: string | null;
  priority: Priority;
  owner: string | null;
  status: ProspectStatus;
  next_action: string | null;
  follow_up_on: string | null;
  notes: string | null;
}

const opt = (s: string, max: number) => (s ? s.slice(0, max) : null);

export function splitList(s: string): string[] {
  return s
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function validateProspect(env: Env, f: ProspectForm, opts: { quick?: boolean } = {}): { draft: ProspectDraft } | { error: string; field: string } {
  if (!f.company) return { error: 'Skriv virksomhedens navn.', field: 'company' };
  if (f.company.length > 200) return { error: 'Virksomhedsnavnet er for langt.', field: 'company' };
  const cvr = f.cvr ? normCvr(f.cvr) : null;
  if (f.cvr && !cvr) return { error: 'CVR skal være 8 cifre.', field: 'cvr' };
  const website = f.website ? normWebsite(f.website) : null;
  if (f.website && !website) return { error: 'Hjemmesiden er ikke en gyldig adresse.', field: 'website' };
  const sourceUrl = f.source_url ? safeUrl(/^https?:\/\//i.test(f.source_url) ? f.source_url : `https://${f.source_url}`) : null;
  if (f.source_url && !sourceUrl) return { error: 'Kildelinket er ikke en gyldig adresse.', field: 'source_url' };
  const emails: string[] = [];
  for (const raw of splitList(f.emails)) {
    const e = normalizeEmail(raw);
    if (!e) return { error: `"${raw.slice(0, 60)}" er ikke en gyldig mailadresse.`, field: 'emails' };
    if (!emails.includes(e)) emails.push(e);
  }
  if (emails.length > 20) return { error: 'Højst 20 mailadresser.', field: 'emails' };
  const phones: string[] = [];
  for (const raw of splitList(f.phones)) {
    if (!/^[+0-9 ()-]{6,24}$/.test(raw)) return { error: `"${raw.slice(0, 30)}" er ikke et gyldigt telefonnummer.`, field: 'phones' };
    if (!phones.includes(raw)) phones.push(raw);
  }
  if (phones.length > 10) return { error: 'Højst 10 telefonnumre.', field: 'phones' };
  if (f.found_on && !isDay(f.found_on)) return { error: 'Vælg en gyldig funddato.', field: 'found_on' };
  if (f.follow_up_on && !isDay(f.follow_up_on)) return { error: 'Vælg en gyldig opfølgningsdato.', field: 'follow_up_on' };
  const priority = (PRIORITIES as readonly string[]).includes(f.priority) ? (f.priority as Priority) : 'mellem';
  const status = (PROSPECT_STATUSES as readonly string[]).includes(f.status) ? (f.status as ProspectStatus) : 'undersoeges';
  if (status === 'kunde' && !opts.quick) return { error: '"Blev kunde" kræver en tilknyttet kunde. Brug "Knyt til kunde" på kundeemnet.', field: 'status' };
  const owner = f.owner ? f.owner.toLowerCase() : null;
  if (owner && !staffList(env).includes(owner)) return { error: 'Vælg en ansvarlig fra listen.', field: 'owner' };
  return {
    draft: {
      company: f.company.slice(0, 200),
      cvr,
      industry: opt(f.industry, 100),
      city: opt(f.city, 100),
      address: opt(f.address, 200),
      area: opt(f.area, 100),
      website,
      domain: companyDomain(website) ?? (emails.map(companyDomain).find(Boolean) as string | undefined) ?? null,
      contact_name: opt(f.contact_name, 150),
      emails,
      phones,
      source: opt(f.source, 100),
      source_url: sourceUrl,
      found_on: f.found_on || null,
      needs: opt(f.needs, 4000),
      services: opt(f.services, 500),
      priority,
      owner,
      status,
      next_action: opt(f.next_action, 300),
      follow_up_on: f.follow_up_on || null,
      notes: opt(f.notes, 8000),
    },
  };
}

// ---------- Dubletter og blokeringer ----------

export interface Candidate {
  company: string;
  cvr: string | null;
  domain: string | null;
  emails: string[];
}

export interface DuplicateHit {
  kind: 'prospect' | 'customer';
  id: number;
  name: string;
  signals: string[];
  strong: boolean;
  status?: string;
}

/**
 * Mulige dubletter blandt kundeemner og kunder. CVR, domæne og mailadresse er signaler;
 * et lignende navn vises også, men fører aldrig selv til sammenlægning.
 */
export async function findDuplicates(db: D1Database, cand: Candidate, excludeId: number | null = null): Promise<DuplicateHit[]> {
  const hits = new Map<string, DuplicateHit>();
  const add = (kind: 'prospect' | 'customer', id: number, name: string, signal: string, strong: boolean, status?: string) => {
    if (kind === 'prospect' && id === excludeId) return;
    const k = `${kind}:${id}`;
    const h = hits.get(k) ?? { kind, id, name, signals: [], strong: false, status };
    if (!h.signals.includes(signal)) h.signals.push(signal);
    h.strong ||= strong;
    hits.set(k, h);
  };
  const emails = cand.emails.slice(0, 20);
  const domains = [...new Set([companyDomain(cand.domain), ...emails.map(companyDomain)].filter(Boolean) as string[])];
  const name = normName(cand.company);
  const stmts: D1PreparedStatement[] = [];
  const kinds: string[] = [];
  if (cand.cvr) {
    stmts.push(db.prepare('SELECT id, company AS name, status FROM prospects WHERE cvr = ? AND merged_into IS NULL').bind(cand.cvr));
    kinds.push('p-cvr');
    stmts.push(db.prepare('SELECT id, COALESCE(company, name, email) AS name FROM customers WHERE cvr = ?').bind(cand.cvr));
    kinds.push('c-cvr');
  }
  for (const d of domains.slice(0, 5)) {
    stmts.push(db.prepare('SELECT id, company AS name, status FROM prospects WHERE domain = ? AND merged_into IS NULL').bind(d));
    kinds.push('p-domain:' + d);
    stmts.push(db.prepare("SELECT id, COALESCE(company, name, email) AS name FROM customers WHERE email LIKE ? ESCAPE '\\'").bind('%@' + d.replace(/[\\%_]/g, (m) => '\\' + m)));
    kinds.push('c-domain:' + d);
  }
  for (const e of emails) {
    stmts.push(
      db.prepare("SELECT p.id, p.company AS name, p.status FROM prospect_contacts pc JOIN prospects p ON p.id = pc.prospect_id WHERE pc.kind = 'email' AND pc.value = ? AND p.merged_into IS NULL").bind(e),
    );
    kinds.push('p-email:' + e);
    stmts.push(db.prepare('SELECT id, COALESCE(company, name, email) AS name FROM customers WHERE email = ?').bind(e));
    kinds.push('c-email:' + e);
  }
  if (name.length >= 3) {
    // Første ord som grovfilter; den præcise sammenligning sker herunder
    const first = name.split(' ')[0]!;
    stmts.push(db.prepare("SELECT id, company AS name, status FROM prospects WHERE company LIKE ? AND merged_into IS NULL LIMIT 50").bind(`%${first}%`));
    kinds.push('p-name');
    stmts.push(db.prepare("SELECT id, COALESCE(company, name, email) AS name FROM customers WHERE company LIKE ? OR name LIKE ? LIMIT 50").bind(`%${first}%`, `%${first}%`));
    kinds.push('c-name');
  }
  if (!stmts.length) return [];
  const res = await db.batch(stmts);
  res.forEach((r, i) => {
    const k = kinds[i]!;
    const kind = k.startsWith('p') ? 'prospect' : 'customer';
    for (const row of (r.results ?? []) as { id: number; name: string; status?: string }[]) {
      if (k.endsWith('-cvr')) add(kind, row.id, row.name, 'Samme CVR', true, row.status);
      else if (k.includes('-domain:')) add(kind, row.id, row.name, `Samme domæne (${k.split(':')[1]})`, false, row.status);
      else if (k.includes('-email:')) add(kind, row.id, row.name, `Samme mailadresse (${k.split(':').slice(1).join(':')})`, true, row.status);
      else if (normName(row.name) === name) add(kind, row.id, row.name, 'Lignende navn', false, row.status);
    }
  });
  return [...hits.values()].sort((a, b) => Number(b.strong) - Number(a.strong) || b.signals.length - a.signals.length);
}

export async function activeBlocksFor(db: D1Database, cand: Candidate): Promise<BlockRow[]> {
  const values: [BlockScope, string][] = [];
  for (const e of cand.emails) values.push(['email', e]);
  const domains = new Set([companyDomain(cand.domain), ...cand.emails.map(companyDomain)].filter(Boolean) as string[]);
  for (const d of domains) values.push(['domain', d]);
  if (cand.cvr) values.push(['company', `cvr:${cand.cvr}`]);
  const n = normName(cand.company);
  if (n) values.push(['company', `navn:${n}`]);
  if (!values.length) return [];
  const res = await db.batch(
    values.map(([s, v]) => db.prepare('SELECT * FROM prospect_blocks WHERE scope = ? AND value = ? AND lifted_at IS NULL').bind(s, v)),
  );
  const out = new Map<number, BlockRow>();
  for (const r of res) for (const b of (r.results ?? []) as BlockRow[]) out.set(b.id, b);
  return [...out.values()];
}

/** Blokeringer knyttet til et kundeemne eller som rammer dets adresser/domæne/CVR */
export async function blocksForProspect(db: D1Database, p: ProspectRow, contacts: ContactRow[]): Promise<BlockRow[]> {
  const direct = (await db.prepare('SELECT * FROM prospect_blocks WHERE prospect_id = ? ORDER BY created_at DESC').bind(p.id).all<BlockRow>()).results ?? [];
  const matching = await activeBlocksFor(db, candidateOf(p, contacts));
  const out = new Map<number, BlockRow>();
  for (const b of [...direct, ...matching]) out.set(b.id, b);
  return [...out.values()].sort((a, b) => b.created_at - a.created_at);
}

export function candidateOf(p: ProspectRow, contacts: ContactRow[]): Candidate {
  return { company: p.company, cvr: p.cvr, domain: p.domain, emails: contacts.filter((c) => c.kind === 'email').map((c) => c.value) };
}

// ---------- Oprettelse og ændringer ----------

export async function createProspect(
  db: D1Database,
  d: ProspectDraft,
  actor: string,
  extra: { unverified?: string[]; unverifiedEmails?: string[]; unverifiedPhones?: string[]; fetched_from?: string | null; fetched_at?: number | null; assessment?: string | null; lead_id?: number | null; body?: string } = {},
): Promise<number> {
  const now = nowSec();
  const row = await db
    .prepare(
      `INSERT INTO prospects (company, cvr, industry, city, address, area, website, domain, contact_name, source, source_url, found_on,
         needs, services, priority, owner, status, status_set_at, status_set_by, next_action, follow_up_on, notes, unverified, fetched_from, fetched_at,
         assessment, lead_id, created_at, created_by, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?18, ?19, ?18, ?19)
       RETURNING id`,
    )
    .bind(
      d.company, d.cvr, d.industry, d.city, d.address, d.area, d.website, d.domain, d.contact_name, d.source, d.source_url, d.found_on ?? today(),
      d.needs, d.services, d.priority, d.owner, d.status, now, actor, d.next_action, d.follow_up_on, d.notes,
      JSON.stringify(extra.unverified ?? []), extra.fetched_from ?? null, extra.fetched_at ?? null, extra.assessment ?? null, extra.lead_id ?? null,
    )
    .first<{ id: number }>();
  const id = row!.id;
  const stmts = [
    addEvent(db, id, { kind: 'created', actor, body: extra.body ?? null, new_value: d.status }),
    ...contactStmts(db, id, d.emails, d.phones, new Set(extra.unverifiedEmails ?? (extra.unverified?.includes('emails') ? d.emails : [])), new Set(extra.unverifiedPhones ?? (extra.unverified?.includes('phones') ? d.phones : []))),
  ];
  if (d.owner) stmts.push(addEvent(db, id, { kind: 'owner', actor, new_value: d.owner }));
  await db.batch(stmts);
  return id;
}

function contactStmts(db: D1Database, id: number, emails: string[], phones: string[], unvE = new Set<string>(), unvP = new Set<string>()): D1PreparedStatement[] {
  const now = nowSec();
  return [
    ...emails.map((e) => db.prepare("INSERT INTO prospect_contacts (prospect_id, kind, value, unverified, created_at) VALUES (?, 'email', ?, ?, ?)").bind(id, e, unvE.has(e) ? 1 : 0, now)),
    ...phones.map((p) => db.prepare("INSERT INTO prospect_contacts (prospect_id, kind, value, unverified, created_at) VALUES (?, 'phone', ?, ?, ?)").bind(id, p, unvP.has(p) ? 1 : 0, now)),
  ];
}

export class ConflictError extends Error {
  constructor() {
    super('Kundeemnet er blevet ændret af en anden, siden du åbnede siden. Dine ændringer er ikke gemt. Genindlæs og prøv igen.');
  }
}

const FIELD_LABEL: Record<string, string> = {
  company: 'Virksomhed', cvr: 'CVR', industry: 'Branche', city: 'By', address: 'Adresse', area: 'Område', website: 'Hjemmeside',
  contact_name: 'Kontaktperson', source: 'Kilde', source_url: 'Kildelink', found_on: 'Funddato', needs: 'Behov', services: 'Ydelser',
  priority: 'Prioritet', next_action: 'Næste handling', follow_up_on: 'Opfølgning', notes: 'Noter', emails: 'Mailadresser', phones: 'Telefonnumre',
};

/**
 * Gemmer redigering af grundoplysningerne. Status og ansvarlig ændres med egne handlinger (setStatus/setOwner),
 * så de får historik. `version` beskytter mod at overskrive en andens samtidige ændring.
 */
export async function updateProspect(db: D1Database, p: ProspectRow, contacts: ContactRow[], d: ProspectDraft, version: number, actor: string): Promise<void> {
  const now = nowSec();
  const changed: string[] = [];
  const cmp: [string, unknown, unknown][] = [
    ['company', p.company, d.company], ['cvr', p.cvr, d.cvr], ['industry', p.industry, d.industry], ['city', p.city, d.city],
    ['address', p.address, d.address], ['area', p.area, d.area], ['website', p.website, d.website], ['contact_name', p.contact_name, d.contact_name],
    ['source', p.source, d.source], ['source_url', p.source_url, d.source_url], ['found_on', p.found_on, d.found_on], ['needs', p.needs, d.needs],
    ['services', p.services, d.services], ['priority', p.priority, d.priority], ['next_action', p.next_action, d.next_action],
    ['follow_up_on', p.follow_up_on, d.follow_up_on], ['notes', p.notes, d.notes],
  ];
  for (const [k, a, b] of cmp) if ((a ?? null) !== (b ?? null)) changed.push(k);
  const oldEmails = contacts.filter((c) => c.kind === 'email').map((c) => c.value);
  const oldPhones = contacts.filter((c) => c.kind === 'phone').map((c) => c.value);
  const emailsChanged = oldEmails.join('\n') !== d.emails.join('\n');
  const phonesChanged = oldPhones.join('\n') !== d.phones.join('\n');
  if (emailsChanged) changed.push('emails');
  if (phonesChanged) changed.push('phones');
  // Felter, der redigeres manuelt, er dermed bekræftet
  const unverified = (JSON.parse(p.unverified || '[]') as string[]).filter((k) => !changed.includes(k));
  const res = await db
    .prepare(
      `UPDATE prospects SET company = ?, cvr = ?, industry = ?, city = ?, address = ?, area = ?, website = ?, domain = ?, contact_name = ?,
         source = ?, source_url = ?, found_on = ?, needs = ?, services = ?, priority = ?, next_action = ?, follow_up_on = ?, notes = ?,
         follow_up_review = CASE WHEN ? THEN 0 ELSE follow_up_review END,
         unverified = ?, version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ? AND version = ?`,
    )
    .bind(
      d.company, d.cvr, d.industry, d.city, d.address, d.area, d.website, d.domain, d.contact_name, d.source, d.source_url, d.found_on,
      d.needs, d.services, d.priority, d.next_action, isSalesActive(p) ? d.follow_up_on : null, d.notes,
      changed.includes('follow_up_on') ? 1 : 0, JSON.stringify(unverified), now, actor, p.id, version,
    )
    .run();
  if (!res.meta.changes) throw new ConflictError();
  const stmts: D1PreparedStatement[] = [];
  if (emailsChanged || phonesChanged) {
    // Bevar eksisterende rækker (bounce-markering m.m.) for adresser, der stadig står der
    const keepE = new Set(d.emails);
    const keepP = new Set(d.phones);
    for (const c of contacts) {
      if ((c.kind === 'email' && !keepE.has(c.value)) || (c.kind === 'phone' && !keepP.has(c.value))) {
        stmts.push(db.prepare('DELETE FROM prospect_contacts WHERE id = ?').bind(c.id));
      } else if (c.unverified) stmts.push(db.prepare('UPDATE prospect_contacts SET unverified = 0 WHERE id = ?').bind(c.id));
    }
    stmts.push(...contactStmts(db, p.id, d.emails.filter((e) => !oldEmails.includes(e)), d.phones.filter((x) => !oldPhones.includes(x))));
  }
  if (changed.length) stmts.push(addEvent(db, p.id, { kind: 'edit', actor, body: `Rettede: ${changed.map((k) => FIELD_LABEL[k] ?? k).join(', ')}` }));
  if (stmts.length) await db.batch(stmts);
}

export function isSalesActive(p: Pick<ProspectRow, 'status' | 'archived_at' | 'blacklisted'>): boolean {
  return !p.archived_at && !p.blacklisted && p.status !== 'afslag' && p.status !== 'kunde';
}

/** Opfølgning stoppes, når emnet ikke længere er salgsaktivt (afslag, arkivering, blokering, kunde) */
function stopFollowUpStmts(db: D1Database, p: ProspectRow, actor: string, why: string): D1PreparedStatement[] {
  if (!p.follow_up_on) return [];
  return [
    db.prepare('UPDATE prospects SET follow_up_on = NULL, follow_up_review = 0 WHERE id = ?').bind(p.id),
    addEvent(db, p.id, { kind: 'followup', actor, body: `Opfølgning ${p.follow_up_on} stoppet (${why})`, old_value: p.follow_up_on }),
  ];
}

export async function setStatus(db: D1Database, p: ProspectRow, status: ProspectStatus, version: number, actor: string, note?: string | null): Promise<void> {
  if (status === p.status) return;
  if (status === 'kunde' && !p.customer_id) throw new Error('"Blev kunde" kræver en tilknyttet kunde.');
  if (p.blacklisted && status !== 'afslag') throw new Error('Kundeemnet er blacklistet og kan ikke gøres aktivt igen. Ophæv blokeringen først.');
  const now = nowSec();
  const res = await db
    .prepare('UPDATE prospects SET status = ?, status_set_at = ?, status_set_by = ?, suggested_status = NULL, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?')
    .bind(status, now, actor, now, actor, p.id, version)
    .run();
  if (!res.meta.changes) throw new ConflictError();
  const stmts = [addEvent(db, p.id, { kind: 'status', actor, old_value: p.status, new_value: status, body: note ?? null })];
  if (status === 'afslag' || status === 'kunde') stmts.push(...stopFollowUpStmts(db, p, actor, STATUS_LABEL[status].toLowerCase()));
  await db.batch(stmts);
}

export async function setOwner(db: D1Database, p: ProspectRow, owner: string | null, version: number, actor: string): Promise<void> {
  if ((p.owner ?? null) === owner) return;
  const now = nowSec();
  const res = await db
    .prepare('UPDATE prospects SET owner = ?, suggested_owner = NULL, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?')
    .bind(owner, now, actor, p.id, version)
    .run();
  if (!res.meta.changes) throw new ConflictError();
  await addEvent(db, p.id, { kind: 'owner', actor, old_value: p.owner, new_value: owner }).run();
}

export interface ContactInput {
  channel: Channel;
  at: number;
  staff: string;
  contact_person: string | null;
  body: string | null;
  status: ProspectStatus | null;
  next_action: string | null;
  follow_up_on: string | null; // '' = ingen opfølgning
  keep_follow_up: boolean;
}

/** Registrerer en kontakt (fungerer helt uden mailintegration) */
export async function registerContact(db: D1Database, p: ProspectRow, c: ContactInput, actor: string): Promise<void> {
  const now = nowSec();
  const stmts: D1PreparedStatement[] = [
    addEvent(db, p.id, { kind: 'contact', actor: c.staff, at: c.at, channel: c.channel, contact_person: c.contact_person, body: c.body }),
  ];
  const newStatus = c.status && c.status !== p.status ? c.status : null;
  if (newStatus === 'kunde' && !p.customer_id) throw new Error('"Blev kunde" kræver en tilknyttet kunde.');
  if (newStatus && p.blacklisted && newStatus !== 'afslag') throw new Error('Kundeemnet er blacklistet og kan ikke gøres aktivt igen.');
  const active = isSalesActive({ ...p, status: newStatus ?? p.status });
  const follow = !active ? null : c.keep_follow_up ? p.follow_up_on : c.follow_up_on || null;
  stmts.push(
    db
      .prepare(
        `UPDATE prospects SET last_contact_at = MAX(COALESCE(last_contact_at, 0), ?1),
           status = COALESCE(?2, status), status_set_at = CASE WHEN ?2 IS NULL THEN status_set_at ELSE ?3 END,
           status_set_by = CASE WHEN ?2 IS NULL THEN status_set_by ELSE ?4 END,
           suggested_status = CASE WHEN ?2 IS NULL THEN suggested_status ELSE NULL END,
           next_action = CASE WHEN ?5 THEN next_action ELSE ?6 END, follow_up_on = ?7, follow_up_review = 0,
           version = version + 1, updated_at = ?3, updated_by = ?4
         WHERE id = ?8`,
      )
      .bind(c.at, newStatus, now, actor, c.keep_follow_up ? 1 : 0, c.next_action, follow, p.id),
  );
  if (newStatus) stmts.push(addEvent(db, p.id, { kind: 'status', actor, old_value: p.status, new_value: newStatus, body: 'Ved registrering af kontakt' }));
  if (!c.keep_follow_up && (follow ?? null) !== (p.follow_up_on ?? null)) {
    stmts.push(addEvent(db, p.id, { kind: 'followup', actor, old_value: p.follow_up_on, new_value: follow, body: follow ? `Opfølgning ${follow}${c.next_action ? `: ${c.next_action}` : ''}` : 'Ingen opfølgning' }));
  }
  await db.batch(stmts);
}

export async function addNote(db: D1Database, p: ProspectRow, body: string, actor: string): Promise<void> {
  await db.batch([
    addEvent(db, p.id, { kind: 'note', actor, body }),
    db.prepare('UPDATE prospects SET updated_at = ?, updated_by = ? WHERE id = ?').bind(nowSec(), actor, p.id),
  ]);
}

export async function setFollowUp(db: D1Database, p: ProspectRow, day: string | null, nextAction: string | null, actor: string): Promise<void> {
  if (day && !isSalesActive(p)) throw new Error('Opfølgning kan kun sættes på aktive kundeemner (ikke afslag, kunde, arkiveret eller blacklistet).');
  await db.batch([
    db.prepare('UPDATE prospects SET follow_up_on = ?, next_action = ?, follow_up_review = 0, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?')
      .bind(day, nextAction, nowSec(), actor, p.id),
    addEvent(db, p.id, { kind: 'followup', actor, old_value: p.follow_up_on, new_value: day, body: day ? `Opfølgning ${day}${nextAction ? `: ${nextAction}` : ''}` : 'Opfølgning fravalgt' }),
  ]);
}

export async function archive(db: D1Database, p: ProspectRow, actor: string): Promise<void> {
  if (p.archived_at) return;
  const now = nowSec();
  await db.batch([
    db.prepare('UPDATE prospects SET archived_at = ?, archived_by = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').bind(now, actor, now, actor, p.id),
    addEvent(db, p.id, { kind: 'archive', actor }),
    ...stopFollowUpStmts(db, p, actor, 'arkiveret'),
  ]);
}

export async function restore(db: D1Database, p: ProspectRow, actor: string): Promise<void> {
  if (!p.archived_at) return;
  const now = nowSec();
  await db.batch([
    db.prepare('UPDATE prospects SET archived_at = NULL, archived_by = NULL, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').bind(now, actor, p.id),
    addEvent(db, p.id, { kind: 'restore', actor, body: p.blacklisted ? 'Gendannet fra arkivet; stadig blacklistet' : null }),
  ]);
}

// ---------- Blokering ----------

export function blockValue(scope: BlockScope, p: ProspectRow, raw: string): { value: string } | { error: string } {
  if (scope === 'email') {
    const e = normalizeEmail(raw);
    return e ? { value: e } : { error: 'Skriv en gyldig mailadresse.' };
  }
  if (scope === 'domain') {
    const d = domainOf(raw || p.domain || '');
    if (!d) return { error: 'Skriv et gyldigt domæne, fx firma.dk.' };
    if (isCommonDomain(d)) return { error: `${d} er en fælles mailudbyder. Bloker i stedet den konkrete mailadresse.` };
    if (d === 'veyro.dk' || d.endsWith('.veyro.dk')) return { error: 'Veyros eget domæne kan ikke blokeres.' };
    return { value: d };
  }
  return { value: p.cvr ? `cvr:${p.cvr}` : `navn:${normName(p.company)}` };
}

export async function addBlock(db: D1Database, p: ProspectRow, scope: BlockScope, value: string, reason: string, actor: string): Promise<void> {
  const now = nowSec();
  const exists = await db.prepare('SELECT id FROM prospect_blocks WHERE scope = ? AND value = ? AND lifted_at IS NULL').bind(scope, value).first();
  const stmts: D1PreparedStatement[] = [];
  if (!exists) {
    stmts.push(
      db.prepare('INSERT INTO prospect_blocks (scope, value, company, reason, prospect_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(scope, value, p.company, reason, p.id, now, actor),
    );
  }
  stmts.push(
    db.prepare('UPDATE prospects SET blacklisted = 1, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').bind(now, actor, p.id),
    addEvent(db, p.id, { kind: 'blacklist', actor, body: reason, new_value: `${BLOCK_SCOPE_LABEL[scope]}: ${value.replace(/^(cvr|navn):/, '')}` }),
    ...stopFollowUpStmts(db, p, actor, 'blacklistet'),
  );
  await db.batch(stmts);
}

/** Ophæver en blokering. Emnet er kun ude af blacklisten, når ingen aktive blokeringer rammer det. */
export async function liftBlock(db: D1Database, b: BlockRow, reason: string, actor: string): Promise<void> {
  const now = nowSec();
  await db.prepare('UPDATE prospect_blocks SET lifted_at = ?, lifted_by = ?, lift_reason = ? WHERE id = ? AND lifted_at IS NULL').bind(now, actor, reason, b.id).run();
  if (!b.prospect_id) return;
  const p = await getProspect(db, b.prospect_id);
  if (!p) return;
  const still = await activeBlocksFor(db, candidateOf(p, await listContacts(db, p.id)));
  const own = await db.prepare('SELECT COUNT(*) AS n FROM prospect_blocks WHERE prospect_id = ? AND lifted_at IS NULL').bind(p.id).first<{ n: number }>();
  await db.batch([
    db.prepare('UPDATE prospects SET blacklisted = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').bind(still.length || own?.n ? 1 : 0, now, actor, p.id),
    addEvent(db, p.id, { kind: 'unblacklist', actor, body: reason, old_value: `${BLOCK_SCOPE_LABEL[b.scope]}: ${b.value.replace(/^(cvr|navn):/, '')}` }),
  ]);
}

export async function listBlocks(db: D1Database, includeLifted: boolean): Promise<(BlockRow & { prospect_company: string | null })[]> {
  return (
    (await db
      .prepare(
        `SELECT b.*, p.company AS prospect_company FROM prospect_blocks b LEFT JOIN prospects p ON p.id = b.prospect_id
         ${includeLifted ? '' : 'WHERE b.lifted_at IS NULL'} ORDER BY b.created_at DESC LIMIT 500`,
      )
      .all<BlockRow & { prospect_company: string | null }>()).results ?? []
  );
}

// ---------- Kunde, forespørgsel og tilbud ----------

/** Knytter kundeemnet til en eksisterende kunde og sætter "Blev kunde". Tid og udgifter følger med via tilknytningen. */
export async function linkCustomer(db: D1Database, p: ProspectRow, customerId: number, actor: string, why: string): Promise<void> {
  const now = nowSec();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE prospects SET customer_id = ?, status = 'kunde', status_set_at = ?, status_set_by = ?, suggested_status = NULL, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?",
      )
      .bind(customerId, now, actor, now, actor, p.id),
    addEvent(db, p.id, { kind: 'customer', actor, new_value: String(customerId), body: why }),
  ];
  if (p.status !== 'kunde') stmts.push(addEvent(db, p.id, { kind: 'status', actor, old_value: p.status, new_value: 'kunde', body: why }));
  stmts.push(...stopFollowUpStmts(db, p, actor, 'blev kunde'));
  await db.batch(stmts);
}

export async function unlinkCustomer(db: D1Database, p: ProspectRow, actor: string): Promise<void> {
  const now = nowSec();
  await db.batch([
    db.prepare("UPDATE prospects SET customer_id = NULL, status = CASE WHEN status = 'kunde' THEN 'dialog' ELSE status END, status_set_at = ?, status_set_by = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?")
      .bind(now, actor, now, actor, p.id),
    addEvent(db, p.id, { kind: 'customer', actor, old_value: String(p.customer_id), body: 'Kundetilknytning fjernet' }),
    ...(p.status === 'kunde' ? [addEvent(db, p.id, { kind: 'status', actor, old_value: 'kunde', new_value: 'dialog', body: 'Kundetilknytning fjernet' })] : []),
  ]);
}

/** Kaldes, når et tilbud oprettet fra et kundeemne er betalt, og kunden er oprettet. */
export async function onOfferActivated(db: D1Database, offerId: number, customerId: number): Promise<void> {
  const o = await db.prepare('SELECT prospect_id FROM offers WHERE id = ?').bind(offerId).first<{ prospect_id: number | null }>();
  if (!o?.prospect_id) return;
  const p = await getProspect(db, o.prospect_id);
  if (!p || p.customer_id === customerId) return;
  if (p.customer_id) {
    await addEvent(db, p.id, { kind: 'auto', actor: 'system', body: `Tilbud #${offerId} er betalt af kunde #${customerId}, men emnet er allerede knyttet til kunde #${p.customer_id}. Tjek tilknytningen.` }).run();
    return;
  }
  await linkCustomer(db, p, customerId, 'system', `Tilbud #${offerId} er accepteret og betalt`);
}

export async function linkLead(db: D1Database, p: ProspectRow, leadId: number, actor: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE prospects SET lead_id = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').bind(leadId, nowSec(), actor, p.id),
    addEvent(db, p.id, { kind: 'lead', actor, new_value: String(leadId), body: `Forespørgsel #${leadId} fra hjemmesiden knyttet til` }),
  ]);
}

/** Forespørgsler fra hjemmesiden, der ligner kundeemnet (samme mail eller virksomhedsdomæne) */
export async function matchingLeads(db: D1Database, p: ProspectRow, contacts: ContactRow[]): Promise<{ id: number; email: string; name: string | null; company: string | null; created_at: number; why: string }[]> {
  const emails = contacts.filter((c) => c.kind === 'email').map((c) => c.value);
  const stmts: D1PreparedStatement[] = emails.slice(0, 10).map((e) => db.prepare("SELECT id, email, name, company, created_at, 'Samme mailadresse' AS why FROM leads WHERE email = ? AND status != 'spam'").bind(e));
  if (p.domain) stmts.push(db.prepare("SELECT id, email, name, company, created_at, 'Samme domæne' AS why FROM leads WHERE email LIKE ? AND status != 'spam' LIMIT 20").bind('%@' + p.domain));
  if (!stmts.length) return [];
  const out = new Map<number, { id: number; email: string; name: string | null; company: string | null; created_at: number; why: string }>();
  for (const r of await db.batch(stmts)) for (const row of (r.results ?? []) as any[]) if (!out.has(row.id) && row.id !== p.lead_id) out.set(row.id, row);
  return [...out.values()];
}

/** Kundeemner, der ligner en forespørgsel (vises på forespørgslen som forslag til tilknytning) */
export async function prospectsForLead(db: D1Database, lead: { id: number; email: string; company: string | null; website?: string | null }): Promise<(DuplicateHit & { linked: boolean })[]> {
  const linked = ((await db.prepare('SELECT id FROM prospects WHERE lead_id = ? AND merged_into IS NULL').bind(lead.id).all<{ id: number }>()).results ?? []).map((x) => x.id);
  const hits = (await findDuplicates(db, { company: lead.company ?? '', cvr: null, domain: companyDomain(lead.website) ?? companyDomain(lead.email), emails: [lead.email] })).filter((h) => h.kind === 'prospect');
  const out = hits.map((h) => ({ ...h, linked: linked.includes(h.id) }));
  for (const id of linked) {
    if (out.some((h) => h.id === id)) continue;
    const p = await getProspect(db, id);
    if (p) out.unshift({ kind: 'prospect', id, name: p.company, signals: ['Knyttet til forespørgslen'], strong: true, linked: true });
  }
  return out;
}

// ---------- Sammenlægning og sletning ----------

/**
 * Lægger `from` sammen med `into`: historik, kontakter, links, filer, tid, udgifter og tilbud flyttes; tomme felter
 * på `into` udfyldes. `from` bevares som "lagt sammen" (skjult), så intet går tabt.
 */
export async function mergeProspects(db: D1Database, into: ProspectRow, from: ProspectRow, actor: string): Promise<void> {
  if (into.id === from.id) throw new Error('Et kundeemne kan ikke lægges sammen med sig selv.');
  if (from.customer_id && into.customer_id && from.customer_id !== into.customer_id) throw new Error('De to kundeemner er knyttet til hver sin kunde. Fjern den ene tilknytning først.');
  const now = nowSec();
  const fill = ['cvr', 'industry', 'city', 'address', 'area', 'website', 'domain', 'contact_name', 'source', 'source_url', 'needs', 'services', 'owner', 'next_action', 'follow_up_on', 'lead_id', 'customer_id'] as const;
  const sets = fill.map((k) => `${k} = COALESCE(${k}, ?)`).join(', ');
  const intoContacts = await listContacts(db, into.id);
  const have = new Set(intoContacts.map((c) => `${c.kind}:${c.value}`));
  const fromContacts = await listContacts(db, from.id);
  const notes = [into.notes, from.notes ? `Fra ${from.company} (#${from.id}):\n${from.notes}` : null].filter(Boolean).join('\n\n') || null;
  await db.batch([
    db
      .prepare(
        `UPDATE prospects SET ${sets}, notes = ?, blacklisted = MAX(blacklisted, ?), last_contact_at = MAX(COALESCE(last_contact_at, 0), ?),
         status = CASE WHEN ? = 'kunde' AND customer_id IS NOT NULL THEN 'kunde' ELSE status END,
         version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
      )
      .bind(...fill.map((k) => from[k]), notes, from.blacklisted, from.last_contact_at ?? 0, from.status, now, actor, into.id),
    ...fromContacts.filter((c) => have.has(`${c.kind}:${c.value}`)).map((c) => db.prepare('DELETE FROM prospect_contacts WHERE id = ?').bind(c.id)),
    db.prepare('UPDATE prospect_contacts SET prospect_id = ? WHERE prospect_id = ?').bind(into.id, from.id),
    db.prepare('UPDATE prospect_events SET prospect_id = ? WHERE prospect_id = ?').bind(into.id, from.id),
    db.prepare('UPDATE prospect_links SET prospect_id = ? WHERE prospect_id = ?').bind(into.id, from.id),
    db.prepare('UPDATE prospect_files SET prospect_id = ? WHERE prospect_id = ?').bind(into.id, from.id),
    db.prepare('UPDATE prospect_blocks SET prospect_id = ? WHERE prospect_id = ?').bind(into.id, from.id),
    db.prepare('UPDATE time_entries SET prospect_id = ? WHERE prospect_id = ?').bind(into.id, from.id),
    db.prepare('UPDATE expenses SET prospect_id = ? WHERE prospect_id = ?').bind(into.id, from.id),
    db.prepare('UPDATE expense_allocations SET prospect_id = ? WHERE prospect_id = ?').bind(into.id, from.id),
    db.prepare('UPDATE offers SET prospect_id = ? WHERE prospect_id = ?').bind(into.id, from.id),
    db.prepare('UPDATE admin_notifications SET prospect_id = ? WHERE prospect_id = ?').bind(into.id, from.id),
    db.prepare('UPDATE prospects SET merged_into = ?, archived_at = COALESCE(archived_at, ?), follow_up_on = NULL, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?')
      .bind(into.id, now, now, actor, from.id),
    addEvent(db, into.id, { kind: 'merge', actor, body: `${from.company} (#${from.id}) er lagt sammen med dette kundeemne. Historik, kontakter, tid og udgifter er flyttet hertil.`, old_value: String(from.id) }),
    addEvent(db, from.id, { kind: 'merge', actor, body: `Lagt sammen med ${into.company} (#${into.id})`, new_value: String(into.id) }),
  ]);
}

/**
 * Sletter et kundeemne. Kundekonto, aftaler, tilbud og fakturaer slettes ikke. Tid og udgifter på et emne,
 * der er knyttet til en kunde, flyttes til kunden; ellers bevares de anonymt i statistikken med emnets navn.
 * Blokeringer bevares som en minimal særskilt registrering. Originale mails i Gmail berøres ikke.
 */
export async function deleteProspect(db: D1Database, p: ProspectRow): Promise<void> {
  const label = `${p.company} (slettet kundeemne)`;
  await db.batch([
    p.customer_id
      ? db.prepare('UPDATE time_entries SET customer_id = COALESCE(customer_id, ?), prospect_id = NULL WHERE prospect_id = ?').bind(p.customer_id, p.id)
      : db.prepare('UPDATE time_entries SET subject_label = ?, prospect_id = NULL WHERE prospect_id = ?').bind(label, p.id),
    p.customer_id
      ? db.prepare('UPDATE expenses SET customer_id = COALESCE(customer_id, ?), prospect_id = NULL WHERE prospect_id = ?').bind(p.customer_id, p.id)
      : db.prepare('UPDATE expenses SET subject_label = ?, prospect_id = NULL WHERE prospect_id = ?').bind(label, p.id),
    p.customer_id
      ? db.prepare('UPDATE expense_allocations SET customer_id = COALESCE(customer_id, ?), prospect_id = NULL WHERE prospect_id = ?').bind(p.customer_id, p.id)
      : db.prepare('UPDATE expense_allocations SET subject_label = ?, prospect_id = NULL WHERE prospect_id = ?').bind(label, p.id),
    db.prepare('UPDATE offers SET prospect_id = NULL WHERE prospect_id = ?').bind(p.id),
    db.prepare('UPDATE prospects SET merged_into = NULL WHERE merged_into = ?').bind(p.id),
    // Blokeringer: kun scope, værdi, navn, årsag og hvem/hvornår bevares
    db.prepare('UPDATE prospect_blocks SET prospect_id = NULL WHERE prospect_id = ?').bind(p.id),
    db.prepare('DELETE FROM prospects WHERE id = ?').bind(p.id),
  ]);
}

// ---------- Filer og links ----------

export const FILE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
export const MAX_FILE = 2_000_000;

/** Filtype ud fra filens første bytes (ikke filnavn eller browserens påstand) */
export function sniffType(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  return null;
}

export function safeFileName(name: string, type: string): string {
  return (name || `fil.${FILE_TYPES[type]}`).replace(/[^\wæøåÆØÅ. -]/g, '').slice(0, 100) || `fil.${FILE_TYPES[type]}`;
}

// ---------- Notifikationer ----------

export async function notify(db: D1Database, recipient: string | null, prospectId: number | null, kind: string, text: string): Promise<void> {
  await db.prepare('INSERT INTO admin_notifications (recipient, prospect_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)').bind(recipient, prospectId, kind, text.slice(0, 500), nowSec()).run();
}

export async function unreadNotifications(db: D1Database, me: string): Promise<{ id: number; prospect_id: number | null; kind: string; text: string; created_at: number }[]> {
  return (
    (await db
      .prepare('SELECT id, prospect_id, kind, text, created_at FROM admin_notifications WHERE (recipient = ? OR recipient IS NULL) AND read_at IS NULL ORDER BY created_at DESC LIMIT 30')
      .bind(me)
      .all<{ id: number; prospect_id: number | null; kind: string; text: string; created_at: number }>()).results ?? []
  );
}

// ---------- Mailudkast (uden AI: kun ud fra registrerede, bekræftede oplysninger) ----------

export interface DraftInput {
  p: ProspectRow;
  contacts: ContactRow[];
  events: EventRow[];
  sender: string;
  kind: 'foerste' | 'opfoelgning';
  observations: string[]; // bekræftede observationer (godkendt vurdering)
}

export function buildDraft(d: DraftInput): { to: string | null; subject: string; body: string; sources: string[] } {
  const p = d.p;
  const sources: string[] = [];
  const unverified = new Set(JSON.parse(p.unverified || '[]') as string[]);
  const contactName = p.contact_name && !unverified.has('contact_name') ? p.contact_name : null;
  if (contactName) sources.push('Kontaktperson fra kundeemnet');
  const to = d.contacts.find((c) => c.kind === 'email' && !c.unverified && !c.bounced_at)?.value ?? null;
  const greeting = contactName ? `Hej ${contactName.split(' ')[0]}` : 'Hej';
  const lastContact = d.events.find((e) => e.kind === 'contact' || e.kind === 'mail');
  const lines: string[] = [greeting, ''];
  if (d.kind === 'opfoelgning' && lastContact) {
    const when = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'long', timeZone: 'Europe/Copenhagen' }).format(new Date(lastContact.at * 1000));
    lines.push(`Jeg følger lige op på ${lastContact.channel === 'telefon' ? 'vores snak' : lastContact.channel === 'moede' ? 'vores møde' : 'min henvendelse'} den ${when}.`);
    sources.push(`Seneste kontakt ${when}`);
  } else {
    lines.push(`Jeg skriver fra Veyro, hvor vi laver hjemmesider og digitale løsninger til mindre virksomheder.`);
  }
  if (d.observations.length) {
    lines.push('', `Jeg har kigget på ${p.website ? p.website.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'jeres hjemmeside'} og lagt mærke til:`);
    for (const o of d.observations.slice(0, 3)) lines.push(`- ${o}`);
    sources.push('Godkendt vurdering af hjemmesiden');
  } else if (p.needs && !unverified.has('needs')) {
    lines.push('', p.needs.split('\n')[0]!.slice(0, 300));
    sources.push('Behov registreret på kundeemnet');
  }
  if (p.services && !unverified.has('services')) {
    lines.push('', `Det kunne vi hjælpe med gennem ${p.services}.`);
    sources.push('Relevante Veyro-ydelser');
  }
  lines.push('', 'Har du tid til en kort snak i den kommende uge?', '', 'Venlig hilsen', staffName(d.sender), 'Veyro', d.sender);
  const subject = d.kind === 'opfoelgning' ? `Opfølgning: ${p.company} og Veyro` : `${p.company} og Veyro`;
  return { to, subject, body: lines.join('\n'), sources };
}
