// First-party, consent-only visitor analytics. Cookie identities are pseudonymous browsers, not people.
import { daysBetween, midnight, type Period } from './stats';

export const ANALYTICS_RETENTION_DAYS = 90;
export const ANALYTICS_SESSION_SECONDS = 30 * 60;
export const ANALYTICS_RETENTION_SECONDS = ANALYTICS_RETENTION_DAYS * 86400;
export const ANALYTICS_CONSENT_VERSION = 2;

export interface AnalyticsEvent {
  type: 'pageview' | 'engagement';
  eventId: string;
  path: string;
  activeSeconds?: number;
  scrollDepth?: number;
  referrer?: string;
  campaignSource?: string;
}
export interface AnalyticsContext {
  visitorId?: string;
  sessionId?: string;
  country?: string;
  region?: string;
  city?: string;
  device?: string;
  browser?: string;
  os?: string;
}
export interface AnalyticsReceipt { accepted: boolean; visitorId?: string; sessionId?: string }
export interface AnalyticsBreakdown { label: string; visits: number }
export interface AnalyticsPageStat { path: string; pageviews: number; activeSeconds: number; averageScrollDepth: number }
export interface AnalyticsSession {
  id: string;
  startedAt: number;
  lastSeenAt: number;
  returning: boolean;
  country: string;
  region: string;
  city: string;
  device: string;
  browser: string;
  os: string;
  source: string;
  entryPath: string;
  exitPath: string;
  pageviews: number;
  activeSeconds: number;
}
export interface AnalyticsJourneyPage {
  id: string;
  path: string;
  viewedAt: number;
  lastSeenAt: number;
  activeSeconds: number;
  scrollDepth: number;
}
export interface AnalyticsReport {
  period: Period;
  totals: { visits: number; uniqueVisitors: number; returningVisits: number; pageviews: number; activeSeconds: number; averageActiveSeconds: number; pagesPerVisit: number; returningRate: number };
  daily: { day: string; visits: number; uniqueVisitors: number; pageviews: number }[];
  countries: AnalyticsBreakdown[];
  cities: AnalyticsBreakdown[];
  sources: AnalyticsBreakdown[];
  devices: AnalyticsBreakdown[];
  browsers: AnalyticsBreakdown[];
  pages: AnalyticsPageStat[];
  entryPages: AnalyticsBreakdown[];
  exitPages: AnalyticsBreakdown[];
  recentSessions: AnalyticsSession[];
  /** Legacy aggregate HTTP pageviews, independent of consented browser sessions; UTC day boundaries. */
  allPageviews: number;
  firstRecordedAt: number | null;
}
export interface AnalyticsSessionDetail { session: AnalyticsSession; pages: AnalyticsJourneyPage[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId = (v: string | undefined): v is string => typeof v === 'string' && UUID.test(v);
const clean = (v: string | undefined, max = 80) => (v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const category = (v: string | undefined, values: string[]) => values.find(x => x.toLowerCase() === v?.toLowerCase()) ?? 'unknown';
const finite = (v: number | undefined, max: number) => Math.min(max, Math.max(0, Number.isFinite(v) ? Math.floor(v!) : 0));

/** Never persist URL query strings, full referrers or arbitrary UTM values. */
export function analyticsSource(referrer?: string, campaign?: string): string {
  const source = clean(campaign, 30).toLowerCase();
  if (['instagram', 'facebook', 'linkedin', 'google', 'bing', 'tiktok', 'newsletter', 'email'].includes(source)) return `${source} (kampagne)`;
  if (!referrer) return 'Direkte / ukendt';
  try {
    const url = new URL(referrer.includes('://') ? referrer : `https://${referrer}`);
    if (!['https:', 'http:'].includes(url.protocol)) return 'Direkte / ukendt';
    const host = url.hostname.toLowerCase();
    if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'Direkte / ukendt';
    if (host === 'veyro.dk' || host.endsWith('.veyro.dk') || ['localhost', '127.0.0.1', '[::1]'].includes(host)) return 'Direkte / ukendt';
    return clean(host, 253) || 'Direkte / ukendt';
  } catch { return 'Direkte / ukendt'; }
}

interface SessionRow {
  id: string; visitor_id: string; started_at: number; last_seen_at: number; is_returning: number;
  country: string; region: string; city: string; device: string; browser: string; os: string; source: string;
  entry_path: string; exit_path: string; pageviews: number; active_seconds: number;
}
interface PageRow { id: string; session_id: string; path: string; viewed_at: number; last_seen_at: number; active_seconds: number; scroll_depth: number }
const sessionFromRow = (s: SessionRow): AnalyticsSession => ({ id: s.id, startedAt: s.started_at, lastSeenAt: s.last_seen_at, returning: !!s.is_returning, country: s.country, region: s.region, city: s.city, device: s.device, browser: s.browser, os: s.os, source: s.source, entryPath: s.entry_path, exitPath: s.exit_path, pageviews: s.pageviews, activeSeconds: s.active_seconds });

/** The endpoint must validate current consent and same-origin requests before calling this function. */
export async function recordAnalyticsEvent(db: D1Database, event: AnalyticsEvent, context: AnalyticsContext, nowSec = Math.floor(Date.now() / 1000)): Promise<AnalyticsReceipt> {
  const now = Math.floor(nowSec);
  // Defensive boundary: public site paths only, with no search/fragment or account identifiers.
  if (!validId(event.eventId) || !/^\/(?:(?:en|sv)\/)?(?:$|pages\/[a-z0-9-]+$|products\/[a-z0-9-]+$)/.test(event.path)) return { accepted: false };
  const existing = await db.prepare(`SELECT p.*, s.visitor_id, s.last_seen_at AS session_last_seen_at FROM site_analytics_pageviews p JOIN site_analytics_sessions s ON s.id = p.session_id WHERE p.id = ?`).bind(event.eventId).first<PageRow & { visitor_id: string; session_last_seen_at: number }>();
  if (event.type === 'engagement') {
    if (!existing || existing.path !== event.path || existing.visitor_id !== context.visitorId || existing.session_id !== context.sessionId || existing.session_last_seen_at <= now - ANALYTICS_SESSION_SECONDS || existing.viewed_at < now - ANALYTICS_RETENTION_SECONDS) return { accepted: false };
    const active = finite(event.activeSeconds, Math.min(86400, Math.max(0, now - existing.viewed_at)));
    const scroll = finite(event.scrollDepth, 100);
    // Replayed heartbeats cannot add time twice; session totals are recomputed inside the same transaction.
    await db.batch([
      db.prepare(`UPDATE site_analytics_pageviews SET active_seconds = MAX(active_seconds, ?), scroll_depth = MAX(scroll_depth, ?), last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`).bind(active, scroll, now, event.eventId),
      db.prepare(`UPDATE site_analytics_sessions SET active_seconds = (SELECT COALESCE(SUM(active_seconds), 0) FROM site_analytics_pageviews WHERE session_id = ?), last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`).bind(existing.session_id, now, existing.session_id),
      db.prepare('UPDATE site_analytics_visitors SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?').bind(now, existing.visitor_id),
    ]);
    return { accepted: true, visitorId: existing.visitor_id, sessionId: existing.session_id };
  }
  if (event.type !== 'pageview') return { accepted: false };
  if (existing) return existing.visitor_id === context.visitorId && existing.path === event.path && existing.session_last_seen_at > now - ANALYTICS_SESSION_SECONDS && existing.viewed_at >= now - ANALYTICS_RETENTION_SECONDS ? { accepted: true, visitorId: existing.visitor_id, sessionId: existing.session_id } : { accepted: false };

  const visitor = validId(context.visitorId) ? await db.prepare('SELECT id FROM site_analytics_visitors WHERE id = ? AND last_seen_at > ?').bind(context.visitorId, now - ANALYTICS_RETENTION_SECONDS).first<{ id: string }>() : null;
  const visitorId = visitor?.id ?? crypto.randomUUID();
  const proposedSessionId = crypto.randomUUID();
  const country = /^[A-Z]{2}$/.test(context.country ?? '') && context.country !== 'XX' ? context.country! : '';
  const device = category(context.device, ['desktop', 'mobile', 'tablet']);
  const browser = category(context.browser, ['Chrome', 'Edge', 'Firefox', 'Safari', 'Opera', 'Samsung Internet']);
  const os = category(context.os, ['Windows', 'macOS', 'iOS', 'Android', 'Linux']);
  // Every mutation is conditional on the page ID still being absent. D1 batch transactions serialize
  // simultaneous replays, so they cannot create orphan visitors/sessions or increment counters twice.
  const absent = 'NOT EXISTS (SELECT 1 FROM site_analytics_pageviews WHERE id = ?)';
  await db.batch([
    db.prepare(`INSERT INTO site_analytics_visitors (id, first_seen_at, last_seen_at, consent_version) SELECT ?, ?, ?, ? WHERE ${absent} ON CONFLICT(id) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`).bind(visitorId, now, now, ANALYTICS_CONSENT_VERSION, event.eventId),
    // Session selection is inside the transaction: concurrent page loads from one known browser
    // reuse whichever active session was inserted first, even without a session cookie.
    db.prepare(`INSERT INTO site_analytics_sessions (id, visitor_id, started_at, last_seen_at, is_returning, country, region, city, device, browser, os, source, entry_path, exit_path) SELECT ?, ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM site_analytics_sessions WHERE visitor_id = ?) THEN 1 ELSE 0 END, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${absent} AND NOT EXISTS (SELECT 1 FROM site_analytics_sessions WHERE visitor_id = ? AND last_seen_at > ?)`).bind(proposedSessionId, visitorId, now, now, visitorId, country, clean(context.region), clean(context.city), device, browser, os, analyticsSource(event.referrer, event.campaignSource), event.path, event.path, event.eventId, visitorId, now - ANALYTICS_SESSION_SECONDS),
    db.prepare(`INSERT INTO site_analytics_pageviews (id, session_id, path, viewed_at, last_seen_at) SELECT ?, s.id, ?, ?, ? FROM site_analytics_sessions s WHERE s.visitor_id = ? AND s.last_seen_at > ? AND ${absent} ORDER BY s.last_seen_at DESC, s.started_at DESC LIMIT 1`).bind(event.eventId, event.path, now, now, visitorId, now - ANALYTICS_SESSION_SECONDS, event.eventId),
    db.prepare(`UPDATE site_analytics_sessions SET pageviews = pageviews + 1, exit_path = ?, last_seen_at = MAX(last_seen_at, ?) WHERE id = (SELECT session_id FROM site_analytics_pageviews WHERE id = ?) AND changes() = 1`).bind(event.path, now, event.eventId),
  ]);
  const won = await db.prepare('SELECT s.id, s.visitor_id FROM site_analytics_pageviews p JOIN site_analytics_sessions s ON s.id = p.session_id WHERE p.id = ?').bind(event.eventId).first<{ id: string; visitor_id: string }>();
  return won?.visitor_id === visitorId ? { accepted: true, visitorId, sessionId: won.id } : { accepted: false };
}

/** Metrics are attributed to the session's start date; a journey is never split at midnight. */
export async function analyticsReport(db: D1Database, period: Period): Promise<AnalyticsReport> {
  const from = period.fromSec, to = period.toSec;
  const days = daysBetween(period.from, period.to);
  // SQLite has no Copenhagen timezone database. Use trusted boundaries from the existing DST-aware helper.
  const dayCase = `CASE ${[...days].reverse().map(day => `WHEN started_at >= ${midnight(day)} THEN '${day}'`).join(' ')} END`;
  const breakdown = (expression: string, limit = 15) => db.prepare(`SELECT ${expression} AS label, COUNT(*) AS visits FROM site_analytics_sessions WHERE started_at >= ? AND started_at < ? GROUP BY label ORDER BY visits DESC, label LIMIT ${limit}`).bind(from, to);
  const queries = [
    db.prepare(`SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS uniqueVisitors, COALESCE(SUM(is_returning),0) AS returningVisits, COALESCE(SUM(pageviews),0) AS pageviews, COALESCE(SUM(active_seconds),0) AS activeSeconds FROM site_analytics_sessions WHERE started_at >= ? AND started_at < ?`).bind(from, to),
    db.prepare(`SELECT ${dayCase} AS day, COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS uniqueVisitors, SUM(pageviews) AS pageviews FROM site_analytics_sessions WHERE started_at >= ? AND started_at < ? GROUP BY day ORDER BY day`).bind(from, to),
    breakdown("COALESCE(NULLIF(country,''),'Ukendt')"),
    breakdown("CASE WHEN city = '' THEN 'Ukendt' ELSE city || CASE WHEN country <> '' THEN ', ' || country ELSE '' END END"),
    breakdown('source'),
    breakdown('device'),
    breakdown('browser'),
    db.prepare(`SELECT p.path, COUNT(*) AS pageviews, SUM(p.active_seconds) AS activeSeconds, AVG(p.scroll_depth) AS averageScrollDepth FROM site_analytics_pageviews p JOIN site_analytics_sessions s ON s.id = p.session_id WHERE s.started_at >= ? AND s.started_at < ? GROUP BY p.path ORDER BY pageviews DESC, p.path LIMIT 20`).bind(from, to),
    breakdown('entry_path'),
    breakdown('exit_path'),
    db.prepare('SELECT * FROM site_analytics_sessions WHERE started_at >= ? AND started_at < ? ORDER BY started_at DESC, id DESC LIMIT 50').bind(from, to),
    db.prepare('SELECT COALESCE(SUM(views),0) AS n FROM site_views WHERE day >= ? AND day < ?').bind(period.from, period.to),
    db.prepare('SELECT MIN(started_at) AS n FROM site_analytics_sessions'),
  ];
  const result = await db.batch(queries);
  const rows = <T>(index: number) => (result[index]?.results ?? []) as T[];
  const base = rows<{ visits: number; uniqueVisitors: number; returningVisits: number; pageviews: number; activeSeconds: number }>(0)[0] ?? { visits: 0, uniqueVisitors: 0, returningVisits: 0, pageviews: 0, activeSeconds: 0 };
  const daily = new Map(rows<AnalyticsReport['daily'][number]>(1).map(r => [r.day, r]));
  return {
    period,
    totals: { ...base, averageActiveSeconds: base.visits ? base.activeSeconds / base.visits : 0, pagesPerVisit: base.visits ? base.pageviews / base.visits : 0, returningRate: base.visits ? base.returningVisits / base.visits : 0 },
    daily: days.map(day => daily.get(day) ?? { day, visits: 0, uniqueVisitors: 0, pageviews: 0 }),
    countries: rows<AnalyticsBreakdown>(2), cities: rows<AnalyticsBreakdown>(3), sources: rows<AnalyticsBreakdown>(4), devices: rows<AnalyticsBreakdown>(5), browsers: rows<AnalyticsBreakdown>(6), pages: rows<AnalyticsPageStat>(7), entryPages: rows<AnalyticsBreakdown>(8), exitPages: rows<AnalyticsBreakdown>(9),
    recentSessions: rows<SessionRow>(10).map(sessionFromRow),
    allPageviews: rows<{ n: number }>(11)[0]?.n ?? 0,
    firstRecordedAt: rows<{ n: number | null }>(12)[0]?.n ?? null,
  };
}

export async function analyticsSessionDetail(db: D1Database, id: string): Promise<AnalyticsSessionDetail | null> {
  if (!validId(id)) return null;
  const s = await db.prepare('SELECT * FROM site_analytics_sessions WHERE id = ?').bind(id).first<SessionRow>();
  if (!s) return null;
  const pages = (await db.prepare('SELECT * FROM site_analytics_pageviews WHERE session_id = ? ORDER BY viewed_at, rowid LIMIT 500').bind(id).all<PageRow>()).results ?? [];
  return { session: sessionFromRow(s), pages: pages.map(p => ({ id: p.id, path: p.path, viewedAt: p.viewed_at, lastSeenAt: p.last_seen_at, activeSeconds: p.active_seconds, scrollDepth: p.scroll_depth })) };
}

export async function purgeSiteAnalytics(db: D1Database, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  const before = Math.floor(nowSec) - ANALYTICS_RETENTION_SECONDS;
  await db.batch([
    db.prepare('DELETE FROM site_analytics_sessions WHERE started_at < ?').bind(before),
    db.prepare('DELETE FROM site_analytics_visitors WHERE last_seen_at < ? OR NOT EXISTS (SELECT 1 FROM site_analytics_sessions s WHERE s.visitor_id = site_analytics_visitors.id)').bind(before),
  ]);
}
