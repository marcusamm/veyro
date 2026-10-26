// Forespørgsler fra hjemmesidens formularer og kurv.
import { nowSec, sha256Hex } from '../lib/crypto';
import { COMMON_MAIL_DOMAINS } from '../lib/prospects';

export type LeadKind = 'kontakt' | 'vurdering' | 'kurv';
export const LEAD_STATUSES = ['ny', 'besvaret', 'dialog', 'demo', 'proeve', 'tilbud', 'kunde', 'lukket', 'spam'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
/** Forespørgsler, der stadig er i gang (fanen "Åbne") */
export const OPEN_LEAD_STATUSES: LeadStatus[] = ['ny', 'besvaret', 'dialog', 'demo', 'proeve', 'tilbud'];
export const OPEN_LEAD_SQL = `status IN (${OPEN_LEAD_STATUSES.map((s) => `'${s}'`).join(', ')})`;
export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  ny: 'Ny',
  besvaret: 'Besvaret',
  dialog: 'I dialog',
  demo: 'Demo oprettet',
  proeve: 'I prøveperiode',
  tilbud: 'Tilbud sendt',
  kunde: 'Blev kunde',
  lukket: 'Lukket',
  spam: 'Spam',
};
export const LEAD_KIND_LABEL: Record<LeadKind, string> = { kontakt: 'Kontaktformular', vurdering: 'Gratis vurdering', kurv: 'Kurv' };

export interface LeadCartLine {
  handle: string;
  title: string;
  quantity: number;
  price: number;
  interval: string;
}

export interface LeadRow {
  id: number;
  kind: LeadKind;
  form_name: string | null;
  name: string | null;
  email: string;
  phone: string | null;
  company: string | null;
  website: string | null;
  service: string | null;
  message: string | null;
  fields: string;
  cart: string | null;
  page: string | null;
  status: LeadStatus;
  note: string | null;
  offer_id: number | null;
  notified_at: number | null;
  ip_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface NewLead {
  kind: LeadKind;
  form_name: string | null;
  name: string | null;
  email: string;
  phone: string | null;
  company: string | null;
  website: string | null;
  service: string | null;
  message: string | null;
  fields: Record<string, string>;
  cart: LeadCartLine[] | null;
  page: string | null;
  ip_hash: string | null;
}

export async function createLead(db: D1Database, l: NewLead): Promise<number> {
  const now = nowSec();
  const row = await db
    .prepare(
      `INSERT INTO leads (kind, form_name, name, email, phone, company, website, service, message, fields, cart, page, ip_hash, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?14, 'ny', ?13, ?13) RETURNING id`,
    )
    .bind(l.kind, l.form_name, l.name, l.email, l.phone, l.company, l.website, l.service, l.message, JSON.stringify(l.fields), l.cart ? JSON.stringify(l.cart) : null, l.page, now, l.ip_hash)
    .first<{ id: number }>();
  return row!.id;
}

export async function markLeadNotified(db: D1Database, id: number): Promise<void> {
  await db.prepare('UPDATE leads SET notified_at = ? WHERE id = ?').bind(nowSec(), id).run();
}

export async function listLeads(db: D1Database, status: string | null): Promise<LeadRow[]> {
  const q =
    status && (LEAD_STATUSES as readonly string[]).includes(status)
      ? db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC LIMIT 500').bind(status)
      : status === 'aabne'
        ? db.prepare(`SELECT * FROM leads WHERE ${OPEN_LEAD_SQL} ORDER BY created_at DESC LIMIT 500`)
        : db.prepare("SELECT * FROM leads WHERE status != 'spam' ORDER BY created_at DESC LIMIT 500");
  return (await q.all<LeadRow>()).results ?? [];
}

export async function getLead(db: D1Database, id: number): Promise<LeadRow | null> {
  return db.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first<LeadRow>();
}

export async function leadCounts(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status').all<{ status: string; n: number }>();
  return Object.fromEntries((results ?? []).map((r) => [r.status, r.n]));
}

/**
 * Opdaterer en forespørgsel. En statusændring registreres i historikken med tidspunkt og bruger.
 * Status er kun en markering: der sendes ingen mails, og der oprettes ingen abonnementer, betalinger eller kunder.
 */
export async function updateLead(
  db: D1Database,
  id: number,
  patch: { status?: LeadStatus; note?: string | null; offer_id?: number | null },
  actor: string | null = null,
): Promise<boolean> {
  const sets: string[] = [];
  const args: unknown[] = [];
  const pre: D1PreparedStatement[] = [];
  if (patch.status) {
    sets.push('status = ?');
    args.push(patch.status);
    // Historik før selve ændringen, så den gamle status kan læses i samme transaktion
    pre.push(
      db
        .prepare("INSERT INTO lead_events (lead_id, at, kind, actor, old_value, new_value) SELECT id, ?, 'status', ?, status, ? FROM leads WHERE id = ? AND status != ?")
        .bind(nowSec(), actor, patch.status, id, patch.status),
    );
  }
  if (patch.note !== undefined) {
    sets.push('note = ?');
    args.push(patch.note);
  }
  if (patch.offer_id !== undefined) {
    sets.push('offer_id = ?');
    args.push(patch.offer_id);
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  args.push(nowSec(), id);
  const res = await db.batch([...pre, db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).bind(...args)]);
  return (res[res.length - 1]!.meta.changes ?? 0) > 0;
}

export interface LeadEventRow {
  id: number;
  lead_id: number;
  at: number;
  kind: string;
  actor: string | null;
  old_value: string | null;
  new_value: string | null;
}

export async function leadEvents(db: D1Database, id: number): Promise<LeadEventRow[]> {
  return (await db.prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY at DESC, id DESC LIMIT 200').bind(id).all<LeadEventRow>()).results ?? [];
}

/** Sletter en forespørgsel helt (fx på anmodning efter GDPR) */
export async function deleteLead(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM leads WHERE id = ?').bind(id).run();
}

/**
 * Privatlivspolitikken: forespørgsler, der ikke førte til et samarbejde, slettes senest
 * 12 måneder efter sidste kontakt. Forespørgsler med tilbud eller som blev kunder beholdes.
 */
export async function purgeOldLeads(db: D1Database): Promise<void> {
  const cutoff = nowSec() - 365 * 86400;
  await db.prepare("DELETE FROM leads WHERE updated_at < ? AND offer_id IS NULL AND status != 'kunde'").bind(cutoff).run();
  await db.prepare('DELETE FROM site_views WHERE day < ?').bind(new Date((nowSec() - 400 * 86400) * 1000).toISOString().slice(0, 10)).run();
}

// ---------- Blokerede afsendere ----------

export type LeadBlockKind = 'email' | 'domain' | 'ip' | 'name';
export const LEAD_BLOCK_KIND_LABEL: Record<LeadBlockKind, string> = { email: 'Mailadresse', domain: 'Domæne', ip: 'IP-adresse', name: 'Navn' };

export interface LeadBlockRow {
  id: number;
  kind: LeadBlockKind;
  value: string;
  label: string | null;
  lead_id: number | null;
  hits: number;
  last_hit_at: number | null;
  created_at: number;
  created_by: string | null;
}

/**
 * Mailadressen i den form, der blokeres på: uden "+tillæg", og for Gmail uden punktummer,
 * så "s.p.a.m+1@gmail.com" rammes af en blokering af "spam@gmail.com".
 */
export function blockEmailKey(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at).replace(/\+.*$/, '');
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local || e.slice(0, at)}@${domain}`;
}

/** Navnet i den form, der blokeres på: små bogstaver og enkelte mellemrum */
export function blockNameKey(name: string | null | undefined): string | null {
  const n = (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return n.length >= 2 ? n : null;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).trim().toLowerCase();
}

/** Hash af en IP-adresse. Samme nøgle som hastighedsbegrænsningen, så rå IP-adresser aldrig gemmes. */
export async function ipHash(ip: string): Promise<string> {
  return sha256Hex(ip);
}

/**
 * Er afsenderen blokeret? Rammer en blokering, tælles den med (så admin kan se, at den virker).
 */
export async function isBlockedSender(db: D1Database, email: string | null, ip_hash: string | null, name: string | null = null): Promise<boolean> {
  const conds: string[] = [];
  const args: string[] = [];
  const nameKey = blockNameKey(name);
  if (nameKey) {
    conds.push("(kind = 'name' AND value = ?)");
    args.push(nameKey);
  }
  if (email) {
    conds.push("(kind = 'email' AND value = ?)", "(kind = 'domain' AND value = ?)");
    args.push(blockEmailKey(email), emailDomain(email));
  }
  if (ip_hash) {
    conds.push("(kind = 'ip' AND value = ?)");
    args.push(ip_hash);
  }
  if (!conds.length) return false;
  const res = await db
    .prepare(`UPDATE lead_blocks SET hits = hits + 1, last_hit_at = ? WHERE ${conds.join(' OR ')} RETURNING id`)
    .bind(nowSec(), ...args)
    .all<{ id: number }>();
  return (res.results?.length ?? 0) > 0;
}

/**
 * Blokerer afsenderen af en forespørgsel. Forespørgslen og alle andre fra samme afsender markeres som spam.
 * Returnerer antal nye blokeringer.
 */
export async function blockLeadSender(
  db: D1Database,
  lead: LeadRow,
  opts: { email: boolean; domain: boolean; ip: boolean; name?: boolean },
  actor: string | null,
): Promise<number> {
  const now = nowSec();
  const add = (kind: LeadBlockKind, value: string, label: string) =>
    db
      .prepare('INSERT INTO lead_blocks (kind, value, label, lead_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (kind, value) DO NOTHING')
      .bind(kind, value, label, lead.id, now, actor);
  const stmts: D1PreparedStatement[] = [];
  const emailKey = blockEmailKey(lead.email);
  const domain = emailDomain(lead.email);
  if (opts.email) stmts.push(add('email', emailKey, lead.email));
  if (opts.domain && domain && !COMMON_MAIL_DOMAINS.has(domain)) stmts.push(add('domain', domain, domain));
  if (opts.ip && lead.ip_hash) stmts.push(add('ip', lead.ip_hash, `IP fra forespørgsel #${lead.id}`));
  const nameKey = blockNameKey(lead.name);
  if (opts.name && nameKey) stmts.push(add('name', nameKey, lead.name!.trim()));
  if (!stmts.length) return 0;
  const res = await db.batch(stmts);
  const added = res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  // Alle forespørgsler fra den blokerede afsender flyttes til Spam (med historik)
  const ids = new Set<number>([lead.id]);
  const others = await db
    .prepare("SELECT id, email, ip_hash, name FROM leads WHERE status != 'spam' AND (email LIKE ?1 OR (?2 != '' AND ip_hash = ?2) OR (?3 != '' AND lower(trim(name)) = ?3)) LIMIT 500")
    .bind('%@' + domain, opts.ip && lead.ip_hash ? lead.ip_hash : '', opts.name && nameKey ? nameKey : '')
    .all<{ id: number; email: string; ip_hash: string | null; name: string | null }>();
  for (const o of others.results ?? []) {
    if (
      (opts.email && blockEmailKey(o.email) === emailKey) ||
      (opts.domain && !COMMON_MAIL_DOMAINS.has(domain) && emailDomain(o.email) === domain) ||
      (opts.ip && lead.ip_hash && o.ip_hash === lead.ip_hash) ||
      (opts.name && nameKey && blockNameKey(o.name) === nameKey)
    )
      ids.add(o.id);
  }
  for (const id of ids) await updateLead(db, id, { status: 'spam' }, actor);
  return added;
}

export async function listLeadBlocks(db: D1Database): Promise<LeadBlockRow[]> {
  return (await db.prepare('SELECT * FROM lead_blocks ORDER BY created_at DESC, id DESC LIMIT 1000').all<LeadBlockRow>()).results ?? [];
}

/** Blokeringer, der rammer en bestemt forespørgsel */
export async function blocksForLead(db: D1Database, lead: LeadRow): Promise<LeadBlockRow[]> {
  return (
    (
      await db
        .prepare("SELECT * FROM lead_blocks WHERE (kind = 'email' AND value = ?) OR (kind = 'domain' AND value = ?) OR (kind = 'ip' AND value = ?) OR (kind = 'name' AND value = ?) ORDER BY id")
        .bind(blockEmailKey(lead.email), emailDomain(lead.email), lead.ip_hash ?? '', blockNameKey(lead.name) ?? '')
        .all<LeadBlockRow>()
    ).results ?? []
  );
}

export async function deleteLeadBlock(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM lead_blocks WHERE id = ?').bind(id).run();
}

// ---------- Sidevisninger (uden cookies og uden IP-adresser) ----------

export async function countView(db: D1Database, path: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await db
    .prepare('INSERT INTO site_views (day, path, views) VALUES (?1, ?2, 1) ON CONFLICT(day, path) DO UPDATE SET views = views + 1')
    .bind(day, path.slice(0, 200))
    .run();
}

export async function viewStats(db: D1Database, days: number): Promise<{ total: number; byDay: { day: string; views: number }[]; byPath: { path: string; views: number }[] }> {
  const since = new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10);
  const [byDay, byPath] = await db.batch([
    db.prepare('SELECT day, SUM(views) AS views FROM site_views WHERE day >= ? GROUP BY day ORDER BY day').bind(since),
    db.prepare('SELECT path, SUM(views) AS views FROM site_views WHERE day >= ? GROUP BY path ORDER BY views DESC LIMIT 15').bind(since),
  ]);
  const d = (byDay?.results ?? []) as { day: string; views: number }[];
  return { total: d.reduce((s, r) => s + r.views, 0), byDay: d, byPath: (byPath?.results ?? []) as { path: string; views: number }[] };
}
