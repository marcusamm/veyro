import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { rateLimit } from '../lib/db';
import { ANALYTICS_CONSENT_VERSION, ANALYTICS_RETENTION_SECONDS, ANALYTICS_SESSION_SECONDS, recordAnalyticsEvent, type AnalyticsContext } from '../lib/site-analytics';
import { loadSite, type SiteData } from './content';
import { languagePath } from './localization';

const analytics = new Hono<{ Bindings: Env }>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOT = /bot|crawl|spider|slurp|preview|monitor|headless/i;

/** Only actual public content can enter analytics; never account, cart or form URLs. */
export function analyticsPage(data: SiteData, path: string): boolean {
  if (path.length > 200 || !/^\/(?:(?:en|sv)\/)?(?:$|(?:pages|products)\/[a-z0-9-]+$)/.test(path)) return false;
  const normalized = languagePath(path).path;
  if (normalized === '/') return true;
  if (normalized.startsWith('/pages/')) return data.pages.some(p => p.handle === normalized.slice(7) && p.published && !p.archived);
  return data.products.some(p => p.handle === normalized.slice(10) && p.status === 'active');
}

/** Coarse categories only. The original User-Agent is never persisted in analytics. */
export function analyticsDevice(ua: string): Pick<AnalyticsContext, 'device' | 'browser' | 'os'> {
  const device = /ipad|tablet|android(?!.*mobile)/i.test(ua) ? 'tablet' : /mobile|iphone|ipod/i.test(ua) ? 'mobile' : ua ? 'desktop' : 'unknown';
  const browser = /SamsungBrowser/i.test(ua) ? 'Samsung Internet' : /Edg(?:e|A|iOS)?\//i.test(ua) ? 'Edge' : /OPR\/|Opera/i.test(ua) ? 'Opera' : /Firefox|FxiOS/i.test(ua) ? 'Firefox' : /Chrome|CriOS/i.test(ua) ? 'Chrome' : /Safari/i.test(ua) ? 'Safari' : 'unknown';
  const os = /iphone|ipad|ipod/i.test(ua) ? 'iOS' : /android/i.test(ua) ? 'Android' : /windows/i.test(ua) ? 'Windows' : /macintosh|mac os/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : 'unknown';
  return { device, browser, os };
}

analytics.use('/events', bodyLimit({ maxSize: 4096, onError: c => c.json({ accepted: false }, 413) }));
analytics.post('/events', async c => {
  c.header('Cache-Control', 'private, no-store');
  const url = new URL(c.req.url);
  if (c.req.header('Origin') !== url.origin || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ accepted: false }, 403);
  if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return c.json({ accepted: false }, 415);
  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return c.json({ accepted: false }, 400);
    body = parsed;
  } catch { return c.json({ accepted: false }, 400); }
  const secure = url.protocol === 'https:';
  const visitorCookie = secure ? '__Host-veyro_visitor' : 'veyro_visitor';
  const sessionCookie = secure ? '__Host-veyro_visit' : 'veyro_visit';
  const cookieOptions = { path: '/', httpOnly: true, secure, sameSite: 'Lax' as const };
  const clear = () => {
    setCookie(c, visitorCookie, '', { ...cookieOptions, maxAge: 0 });
    setCookie(c, sessionCookie, '', { ...cookieOptions, maxAge: 0 });
  };
  const ua = c.req.header('User-Agent') ?? '';
  if (body.type === 'revoke' || body.consent !== true || body.consentVersion !== ANALYTICS_CONSENT_VERSION || c.req.header('DNT') === '1' || c.req.header('Sec-GPC') === '1' || BOT.test(ua)) {
    clear();
    return c.body(null, 204);
  }
  if (url.host !== new URL(c.env.SITE_URL || 'https://veyro.dk').host) return c.body(null, 204);
  if (!['pageview', 'engagement'].includes(String(body.type)) || typeof body.eventId !== 'string' || !UUID.test(body.eventId) || typeof body.path !== 'string') return c.json({ accepted: false }, 400);
  for (const key of ['activeSeconds', 'scrollDepth']) {
    if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0)) return c.json({ accepted: false }, 400);
  }
  try {
    if (!analyticsPage(await loadSite(c.env.DB), body.path)) return c.json({ accepted: false }, 400);
    // Short-lived abuse protection, separate from visitor reports. Never store the raw IP.
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const day = Math.floor(Date.now() / 86400000);
    const key = 'analytics:' + await sha256Hex(`${day}:${ip}`);
    if (!await rateLimit(c.env.DB, key, 240, 60)) return c.json({ accepted: false }, 429);
    const cf = c.req.raw.cf;
    const receipt = await recordAnalyticsEvent(c.env.DB, {
      type: body.type as 'pageview' | 'engagement', eventId: body.eventId, path: body.path,
      activeSeconds: body.activeSeconds as number | undefined, scrollDepth: body.scrollDepth as number | undefined,
      referrer: typeof body.referrer === 'string' ? body.referrer.slice(0, 1024) : undefined,
      campaignSource: typeof body.campaignSource === 'string' ? body.campaignSource.slice(0, 30) : undefined,
    }, {
      visitorId: getCookie(c, visitorCookie), sessionId: getCookie(c, sessionCookie),
      country: typeof cf?.country === 'string' ? cf.country : undefined,
      region: typeof cf?.region === 'string' ? cf.region : undefined,
      city: typeof cf?.city === 'string' ? cf.city : undefined,
      ...analyticsDevice(ua),
    });
    if (receipt.accepted && receipt.visitorId && receipt.sessionId) {
      setCookie(c, visitorCookie, receipt.visitorId, { ...cookieOptions, maxAge: ANALYTICS_RETENTION_SECONDS });
      setCookie(c, sessionCookie, receipt.sessionId, { ...cookieOptions, maxAge: ANALYTICS_SESSION_SECONDS });
    }
    return c.json({ accepted: receipt.accepted });
  } catch {
    // Optional analytics must not affect browsing if storage is temporarily unavailable.
    return c.json({ accepted: false }, 503);
  }
});

export default analytics;
