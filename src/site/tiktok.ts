import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { rateLimit } from '../lib/db';
import { analyticsPage } from './analytics';
import { loadSite } from './content';

const tiktok = new Hono<{ Bindings: Env }>();
const PIXEL_ID = 'DBMMVK3C77UDLIGRBECG';
const ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.=-]{1,512}$/.test(value) ? value : undefined;

tiktok.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  if (new URL(c.req.url).origin !== 'https://veyro.dk') return c.body(null, 404);
  await next();
});
tiktok.use('/events', bodyLimit({ maxSize: 2048, onError: c => c.json({ accepted: false }, 413) }));
tiktok.post('/events', async c => {
  if (c.req.header('Origin') !== 'https://veyro.dk' || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ accepted: false }, 403);
  if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return c.json({ accepted: false }, 415);
  let body;
  try { body = await c.req.json(); } catch { return c.json({ accepted: false }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ accepted: false }, 400);
  const age = Date.now() - body.consentAt;
  const ua = c.req.header('User-Agent') ?? '';
  // A server relay is never a way around the visitor's marketing choice.
  if (body.marketing !== true || body.tiktok !== true || body.consentVersion !== 2 ||
      typeof body.consentAt !== 'number' || !Number.isFinite(age) || age < 0 || age >= 31536000000 ||
      c.req.header('DNT') === '1' || c.req.header('Sec-GPC') === '1' || /bot|crawl|spider|preview|monitor|headless/i.test(ua)) return c.body(null, 204);
  if (typeof body.eventId !== 'string' || !UUID.test(body.eventId) || typeof body.path !== 'string' ||
      !/^\/(?:$|en\/?$|(?:en\/)?(?:pages|products)\/[a-z0-9-]+\/?$)/.test(body.path)) return c.json({ accepted: false }, 400);
  const path = /^\/en\/?$/.test(body.path) ? '/en/' : body.path === '/' ? '/' : body.path.replace(/\/$/, '');
  if (!c.env.TIKTOK_EVENTS_ACCESS_TOKEN) return c.json({ accepted: false, reason: 'not_configured' }, 503);
  try {
    if (!analyticsPage(await loadSite(c.env.DB), path)) return c.json({ accepted: false }, 400);
    // Trust only Cloudflare's connection address; never a client-supplied IP or X-Forwarded-For.
    const ip = c.req.header('CF-Connecting-IP');
    if (!ip || !ua || ua.length > 1024) return c.json({ accepted: false }, 400);
    const bucket = await sha256Hex(`${Math.floor(Date.now() / 86400000)}:${ip}`);
    if (!await rateLimit(c.env.DB, `tiktok:${bucket}`, 60, 60)) return c.json({ accepted: false }, 429);
    const response = await fetch(ENDPOINT, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', 'Access-Token': c.env.TIKTOK_EVENTS_ACCESS_TOKEN },
      body: JSON.stringify({ event_source: 'web', event_source_id: PIXEL_ID, data: [{
        event: 'Pageview', event_time: Math.floor(Date.now() / 1000), event_id: body.eventId,
        user: { ip, user_agent: ua, ttp: identifier(getCookie(c, '_ttp')), ttclid: identifier(body.ttclid) },
        // Query strings, fragments, referrers and form/customer data are intentionally omitted.
        page: { url: `https://veyro.dk${path === '/en' ? '/en/' : path}` },
      }] }),
    });
    const result = await response.json() as { code?: number };
    if (!response.ok || result.code !== 0) {
      // Vendor error messages can echo payloads. Log only the numeric status/code.
      console.warn('TikTok Events API rejected event', response.status, typeof result.code === 'number' ? result.code : 'invalid_response');
      return c.json({ accepted: false }, 502);
    }
    return c.json({ accepted: true });
  } catch {
    return c.json({ accepted: false }, 503);
  }
});

export default tiktok;
