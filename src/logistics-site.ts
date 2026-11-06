import type { Env } from './env';
import { PUBLIC_LOGISTICS_PATHS } from './lib/logistics-seo';

export const LOGISTICS_ORIGIN = 'https://xn--logistikvrktjer-5lb32a.dk';
const ASSET_ROOT = '/logistics-site';
const HOSTS = new Set([
  'logistikvaerktojer.dk', 'www.logistikvaerktojer.dk',
  'xn--logistikvrktjer-5lb32a.dk', 'www.xn--logistikvrktjer-5lb32a.dk',
]);
const PAGES = new Set<string>(PUBLIC_LOGISTICS_PATHS.map(path => path.slice('/logistik'.length)));
const ACCOUNT_PAGES = new Set(['/mine/']);
const ACCOUNT_ROUTE = /^\/logistik\/(?:api(?:\/|$)|login$|verify$|logout$)/;
const RESOURCES = ['/assets/', '/fonts/', '/downloads/'];
const FILES = new Set(['/logo.svg', '/sitemap.xml']);
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
].join('; ');

export function isLogisticsSiteRequest(request: Request): boolean {
  return HOSTS.has(new URL(request.url).hostname);
}

function response(request: Request, original: Response, indexable = false): Response {
  const headers = new Headers(original.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  // Preserve same-origin POST/CSRF behaviour, without sending referrers off-site.
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.delete('Set-Cookie');
  if (indexable) headers.delete('X-Robots-Tag');
  else headers.set('X-Robots-Tag', 'noindex, nofollow');
  if (!indexable || !headers.has('Cache-Control')) {
    headers.set('Cache-Control', indexable ? 'public, max-age=300' : 'no-store');
  }
  return new Response(request.method === 'HEAD' ? null : original.body, { status: original.status, headers });
}

function redirect(request: Request, location: string, status: 302 | 308): Response {
  return response(request, new Response(null, { status, headers: { Location: location } }));
}

function robots(): string {
  const pages = [...PAGES, ...FILES].map(path => `Allow: ${path}$`);
  return `User-agent: *\nDisallow: /\n${[...pages, ...RESOURCES.map(path => `Allow: ${path}`)].join('\n')}\n\nSitemap: ${LOGISTICS_ORIGIN}/sitemap.xml\n`;
}

async function notFound(request: Request, env: Env): Promise<Response> {
  if (env.ASSETS) {
    // The native asset service redirects .html to its extensionless URL.
    const asset = await env.ASSETS.fetch(new Request(`${LOGISTICS_ORIGIN}${ASSET_ROOT}/404`));
    if (asset.ok && asset.headers.get('Content-Type')?.includes('text/html')) {
      return response(request, new Response(asset.body, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    }
  }
  return response(request, new Response('Siden findes ikke.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
}

type AccountHandler = (request: Request, environment: Env) => Response | Promise<Response>;

/** Dedicated website: only its existing logistics account routes may enter the shared account app. */
export async function fetchLogisticsSite(request: Request, env: Env, account?: AccountHandler): Promise<Response> {
  const url = new URL(request.url);
  if (!isLogisticsSiteRequest(request)) return notFound(request, env);
  // Keep the original URL/Origin for the existing CSRF checks. APP_URL is replaced
  // only on this exact trusted host so login emails return to the same website.
  // Return the app response untouched: its private headers and session cookies are required.
  if (url.origin === LOGISTICS_ORIGIN && ACCOUNT_ROUTE.test(url.pathname)) {
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
      return response(request, new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, HEAD, POST' } }));
    }
    if (!account) return response(request, new Response('Login er midlertidigt utilgængeligt.', { status: 503 }));
    return account(request, { ...env, APP_URL: LOGISTICS_ORIGIN });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return response(request, new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, HEAD' } }));
  }
  if (url.origin !== LOGISTICS_ORIGIN) return redirect(request, `${LOGISTICS_ORIGIN}${url.pathname}${url.search}`, 308);

  let path = url.pathname;
  if (/%(?:2f|5c|00)/i.test(path) || path.includes('\\')) return notFound(request, env);
  if (path === '/logistik' || path.startsWith('/logistik/')) {
    return redirect(request, `${LOGISTICS_ORIGIN}${path.slice('/logistik'.length) || '/'}${url.search}`, 308);
  }
  if (/^\/(?:login|verify)\/?$/.test(path)) {
    return redirect(request, `${LOGISTICS_ORIGIN}/logistik${path.replace(/\/$/, '')}${url.search}`, 302);
  }

  // HTML is an identity-free shell; saved data is loaded only through the shared
  // authenticated API. Drafts and login remain on this origin throughout.
  const pagePath = path.endsWith('/index.html') ? path.slice(0, -'index.html'.length)
    : path.endsWith('/') ? path : `${path}/`;
  if (PAGES.has(pagePath) || ACCOUNT_PAGES.has(pagePath)) {
    if (path !== pagePath) return redirect(request, `${LOGISTICS_ORIGIN}${pagePath}${url.search}`, 308);
    path = pagePath;
  }
  if (path === '/robots.txt') {
    return response(request, new Response(robots(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }), true);
  }
  if (path === '/favicon.ico') return redirect(request, `${LOGISTICS_ORIGIN}/logo.svg`, 308);
  if (!PAGES.has(path) && !ACCOUNT_PAGES.has(path) && !FILES.has(path) && !RESOURCES.some(prefix => path.startsWith(prefix))) return notFound(request, env);
  if (!env.ASSETS) return response(request, new Response('Logistikværktøjer er midlertidigt utilgængelige.', { status: 503 }));

  const assetUrl = new URL(request.url);
  assetUrl.pathname = `${ASSET_ROOT}${path}`;
  assetUrl.search = '';
  // Do not send customer cookies or authorization headers to the public asset service.
  const assetHeaders = new Headers();
  for (const name of ['Accept', 'Accept-Encoding', 'Range', 'If-None-Match', 'If-Modified-Since']) {
    const value = request.headers.get(name);
    if (value) assetHeaders.set(name, value);
  }
  const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: assetHeaders }));
  if (asset.status >= 300 && asset.status < 400 && asset.headers.has('Location')) {
    const location = new URL(asset.headers.get('Location')!, assetUrl);
    if (location.origin !== LOGISTICS_ORIGIN || !location.pathname.startsWith(`${ASSET_ROOT}/`)) return notFound(request, env);
    const publicPath = location.pathname.slice(ASSET_ROOT.length);
    if (publicPath === path) return notFound(request, env);
    return redirect(request, `${LOGISTICS_ORIGIN}${publicPath}${url.search}`, 308);
  }
  if (asset.status === 404) return notFound(request, env);
  const privateView = ACCOUNT_PAGES.has(path) || url.searchParams.has('saved') || url.searchParams.has('resume');
  return response(request, asset, !privateView && (asset.ok || asset.status === 304));
}
