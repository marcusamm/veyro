// Forespørgsler fra hjemmesidens formularer og kurv.
import { nowSec } from '../lib/crypto';

export type LeadKind = 'kontakt' | 'vurdering' | 'kurv';
export const LEAD_STATUSES = ['ny', 'besvaret', 'tilbud', 'kunde', 'lukket', 'spam'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  ny: 'Ny',
  besvaret: 'Besvaret',
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
}

export async function createLead(db: D1Database, l: NewLead): Promise<number> {
  const now = nowSec();
  const row = await db
    .prepare(
      `INSERT INTO leads (kind, form_name, name, email, phone, company, website, service, message, fields, cart, page, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'ny', ?13, ?13) RETURNING id`,
    )
    .bind(l.kind, l.form_name, l.name, l.email, l.phone, l.company, l.website, l.service, l.message, JSON.stringify(l.fields), l.cart ? JSON.stringify(l.cart) : null, l.page, now)
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
        ? db.prepare("SELECT * FROM leads WHERE status IN ('ny', 'besvaret', 'tilbud') ORDER BY created_at DESC LIMIT 500")
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

export async function updateLead(db: D1Database, id: number, patch: { status?: LeadStatus; note?: string | null; offer_id?: number | null }): Promise<boolean> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.status) {
    sets.push('status = ?');
    args.push(patch.status);
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
  const r = await db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  return (r.meta.changes ?? 0) > 0;
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
