// Indgangen: /api/* går til værkstedets Durable Object, resten er de færdigbyggede sider.
import type { Env } from './vaerksted';

export { Vaerksted } from './vaerksted';

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  'frame-src https://www.google.com https://challenges.cloudflare.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function medSikkerhed(res: Response, env: Env, privat: boolean): Response {
  const r = new Response(res.body, res);
  r.headers.set('Content-Security-Policy', CSP);
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  r.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  r.headers.set('Strict-Transport-Security', 'max-age=31536000');
  // Demoen må ikke findes i søgemaskiner, og admin/bookingsider aldrig
  if (env.DEMO_MODE === '1' || privat) r.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return r;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.VAERKSTED.get(env.VAERKSTED.idFromName('vaerksted'));
      return medSikkerhed(await stub.fetch(req), env, true);
    }
    if (url.pathname === '/robots.txt') {
      const tekst = env.DEMO_MODE === '1'
        ? 'User-agent: *\nDisallow: /\n'
        : `User-agent: *\nDisallow: /admin\nDisallow: /booking/\nDisallow: /api/\nSitemap: ${env.APP_URL ?? url.origin}/sitemap.xml\n`;
      return new Response(tekst, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    // Admin og kundens bookingside er rene app-sider uden forudrenderet indhold
    const privat = url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/booking/');
    if (privat) {
      const res = await env.ASSETS.fetch(new Request(new URL('/app', url), req));
      return medSikkerhed(res, env, true);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Metoden er ikke tilladt', { status: 405 });
    let res = await env.ASSETS.fetch(req);
    if (res.status === 404) {
      const side = await env.ASSETS.fetch(new Request(new URL('/404', url), req));
      res = new Response(side.body, { status: 404, headers: side.headers });
    }
    return medSikkerhed(res, env, false);
  },
} satisfies ExportedHandler<Env>;
