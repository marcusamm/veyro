/** Dedicated staging entry point. All data and sessions belong to the pilot database. */
import app from '../../src/aj/app';
import type { Env } from '../../src/env';
import { calendarConnectionGuide } from '../../src/views/calendar-connection-guide';

const publicAssets = new Set(['/aj.css', '/aj-admin.css', '/aj.js', '/aj-admin.js']);
const publicReads = new Set(['/api/admin/session', '/api/calendar.ics']);
const testBanner = '<aside class="adm-notice pilot-banner"><strong>Veyro · Kalendertest</strong> Brug en Apple-testkonto og fiktive bookingoplysninger. Testen sender ingen mails. <a href="/admin#kalender">Kalender på mobilen</a> · <a href="/booking">Prøv booking</a></aside>';

function landing() {
  return new Response(`<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kalenderguide · Veyros testside</title><link rel="stylesheet" href="/aj.css"><link rel="stylesheet" href="/aj-admin.css"><main class="aj-admin"><h1>Veyros kalendertest</h1><p>Brug dit personlige testlogin for at forbinde en Apple-testkonto eller prøve at booke. Her kan du læse guiden uden login. Er du allerede logget ind, kan du åbne bookingadministrationen nedenfor.</p><p><a class="adm-button" href="/admin#kalender">Åbn bookingadministrationen</a></p>${calendarConnectionGuide()}</main></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function respond(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  // No fallback to aj.veyro.dk for feeds, booking links or test notifications.
  const stagingEnv = { ...env, AJ_URL: url.origin, AJ_HOSTS: url.hostname, ADMIN_EMAILS: '', DEV_MODE: '0' };
  if (request.method === 'GET' && pathname === '/') return landing();
  if (request.method === 'GET' && pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
  if (pathname === '/api/admin/login') return Response.json({ error: 'Åbn dit personlige testlink for at logge ind.' }, { status: 403 });
  const isPublic = request.method === 'GET' && (pathname === '/admin' || publicAssets.has(pathname) || publicReads.has(pathname));
  const isVerification = request.method === 'POST' && pathname === '/api/admin/verify';
  if (!isPublic && !isVerification) {
    if (pathname !== '/booking' && pathname !== '/booking/aftale' && !pathname.startsWith('/api/')) return new Response(null, { status: 404 });
    const session = await app.fetch(new Request(new URL('/api/admin/session', url), { headers: { Cookie: request.headers.get('Cookie') ?? '' } }), stagingEnv, ctx);
    const identity = await session.json<{ authenticated: boolean }>();
    if (!identity.authenticated) return Response.json({ error: 'Åbn dit personlige testlink for at fortsætte.' }, { status: 401 });
  }
  const result = await app.fetch(request, stagingEnv, ctx);
  if (!result.headers.get('Content-Type')?.includes('text/html')) return result;
  return new HTMLRewriter()
    .on('body', { element(element) { element.prepend(testBanner, { html: true }); } })
    .on('#adm-login-form', { element(element) { element.setAttribute('hidden', ''); } })
    .on('#adm-login > p', { element(element) { element.setInnerContent('Åbn det personlige testlink, du har fået af Veyro.'); } })
    .on('header.site-header', { element(element) { element.remove(); } })
    .on('footer.site-footer', { element(element) { element.remove(); } })
    .transform(result);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const head = request.method === 'HEAD';
    const result = await respond(head ? new Request(request.url, { method: 'GET', headers: request.headers }) : request, env, ctx);
    const response = new Response(head ? null : result.body, result);
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    return response;
  },
};
