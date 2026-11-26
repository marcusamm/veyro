import { renderWebmail } from './view';
import { previewHtml, previewCss, previewJs } from './preview';
import { sogoCss, webmailCss } from './styles';

const PUBLIC = 'https://mail.veyro.dk';
const ORIGIN = 'https://post.veyro.dk';
const assetPaths = new Set(['/favicon.svg', '/manrope.woff2', '/Manrope-OFL.txt']);
const readMethods = new Set(['GET', 'HEAD']);
const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const browserHeaders = [
  'accept', 'accept-language', 'content-type', 'content-disposition', 'user-agent',
  'if-none-match', 'if-modified-since', 'if-match', 'range', 'if-range',
  'x-requested-with', 'x-xsrf-token',
];
const localPolicy = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

interface Env {
  WEBMAIL_ENABLED?: string;
  ASSETS: Fetcher;
}

function localResponse(req: Request, body: string, status: number, type = 'text/plain; charset=utf-8') {
  return new Response(req.method === 'HEAD' ? null : body, {
    status,
    headers: {
      'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': localPolicy,
    },
  });
}

function nativePath(path: string): boolean {
  if (!(/^\/SOGo(?:\/|$)/.test(path) || /^\/(?:SOGo)?\.woa\/WebServerResources\//.test(path))) return false;
  // Check the spelling seen by the upstream HTTP server before passing a path on.
  try {
    const decoded = decodeURIComponent(path);
    return !/[\\\u0000-\u001f\u007f]/.test(decoded)
      && !decoded.split('/').some(part => part === '.' || part === '..')
      && !/%(?:25)*(?:2e|2f|5c)/i.test(decoded);
  } catch { return false; }
}

function allowedWrite(req: Request): boolean {
  const origin = req.headers.get('Origin');
  if (origin !== null) return origin === PUBLIC;
  try {
    return new URL(req.headers.get('Referer') || '').origin === PUBLIC;
  } catch { return false; }
}

// SOGo / SOPE cookies. Do not forward unrelated parent-domain Veyro cookies.
function sogoCookie(value: string): boolean {
  const name = value.split('=', 1)[0];
  return !!name && /^(?:0xHIGHFLYxSOGo|SOGoLogin|XSRF-TOKEN|sogo-user-domain|(?:cas|openid|saml2)-location)$/.test(name);
}

function requestHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const name of browserHeaders) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const cookies = req.headers.get('Cookie')?.split(/;\s*/).filter(sogoCookie);
  if (cookies?.length) headers.set('Cookie', cookies.join('; '));
  headers.set('Host', new URL(PUBLIC).host);
  headers.set('X-Forwarded-Host', new URL(PUBLIC).host);
  headers.set('X-Forwarded-Proto', 'https');
  if (req.headers.has('Origin')) headers.set('Origin', PUBLIC);
  // Cloudflare supplies this header at ingress. A normal client cannot select the upstream address.
  const clientIp = req.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set('X-Real-IP', clientIp);
  return headers;
}

function nativeHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  for (const name of ['Set-Cookie', 'Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Refresh']) {
    headers.delete(name);
  }
  for (let cookie of response.headers.getSetCookie()) {
    if (!sogoCookie(cookie)) continue;
    cookie = cookie.replace(/;\s*Domain=[^;]*/gi, '');
    if (!/;\s*Secure(?:;|$)/i.test(cookie)) cookie += '; Secure';
    if (!/;\s*SameSite=/i.test(cookie)) cookie += '; SameSite=Lax';
    if (cookie.startsWith('0xHIGHFLYxSOGo=') && !/;\s*HttpOnly(?:;|$)/i.test(cookie)) cookie += '; HttpOnly';
    headers.append('Set-Cookie', cookie);
  }
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.append('Content-Security-Policy', "frame-ancestors 'self'");
  return headers;
}

const html = 'text/html; charset=utf-8';

function unavailable(req: Request, installing = false) {
  const isPage = readMethods.has(req.method) && (req.headers.get('Accept') || '').includes('text/html');
  return localResponse(req, isPage ? renderWebmail(false, installing) : 'Mailserveren er midlertidigt utilgængelig.', 503, isPage ? html : undefined);
}

async function proxy(req: Request, url: URL): Promise<Response> {
  const upstream = new URL(ORIGIN);
  upstream.pathname = url.pathname;
  upstream.search = url.search;
  const target = new Request(upstream, req);
  let result: Response;
  try {
    result = await fetch(target, { headers: requestHeaders(req), redirect: 'manual', cache: 'no-store' });
  } catch { return unavailable(req); }
  if (result.status >= 500) return unavailable(req);

  const headers = nativeHeaders(result);
  const location = headers.get('Location');
  if (location !== null) {
    let redirect: URL;
    try { redirect = new URL(location, upstream); } catch { return unavailable(req); }
    if (redirect.username || redirect.password || ![ORIGIN, PUBLIC].includes(redirect.origin)
      || !(redirect.pathname === '/' || nativePath(redirect.pathname))) return unavailable(req);
    headers.set('Location', PUBLIC + redirect.pathname + redirect.search + redirect.hash);
  }
  const response = new Response(req.method === 'HEAD' ? null : result.body, { status: result.status, headers });
  // Never modify message contents, frames, downloads or attachments.
  const shell = /^\/SOGo(?:\/so(?:\/[^/]+(?:\/(?:Mail|Calendar|Contacts)(?:\/view)?|\/view))?)?\/?$/.test(url.pathname);
  if (shell && req.method === 'GET' && result.status === 200 && !headers.has('Content-Disposition')
    && headers.get('Content-Type')?.toLowerCase().startsWith('text/html')) {
    return new HTMLRewriter().on('head', {
      element(head) { head.append('<link rel="stylesheet" href="/sogo-theme.css">', { html: true }); },
    }).transform(response);
  }
  return response;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== PUBLIC && !(local && env.WEBMAIL_ENABLED !== '1')) {
      return localResponse(req, 'Ukendt adresse.', 404);
    }
    const read = readMethods.has(req.method);
    const preview = url.pathname === '/forhaandsvisning' || url.pathname === '/forhaandsvisning/'
      || (url.pathname === '/' && env.WEBMAIL_ENABLED !== '1');
    if (read && preview) {
      const example = localResponse(req, previewHtml(), 200, html);
      example.headers.set('Content-Security-Policy', localPolicy + "; script-src 'self'");
      return example;
    }
    if (read && url.pathname === '/forhaandsvisning.css') return localResponse(req, previewCss, 200, 'text/css; charset=utf-8');
    if (read && url.pathname === '/forhaandsvisning.js') return localResponse(req, previewJs, 200, 'text/javascript; charset=utf-8');
    if (read && url.pathname === '/') return localResponse(req, renderWebmail(env.WEBMAIL_ENABLED === '1', env.WEBMAIL_ENABLED !== '1'), 200, html);
    if (read && url.pathname === '/robots.txt') return localResponse(req, 'User-agent: *\nDisallow: /\n', 200);
    if (read && assetPaths.has(url.pathname)) {
      // Assets receive no mailbox cookies or login data.
      return env.ASSETS.fetch(new Request(PUBLIC + url.pathname, { method: req.method }));
    }
    if (read && (url.pathname === '/webmail.css' || url.pathname === '/sogo-theme.css')) {
      return localResponse(req, url.pathname === '/webmail.css' ? webmailCss : sogoCss, 200, 'text/css; charset=utf-8');
    }
    if (!nativePath(url.pathname)) return localResponse(req, 'Siden findes ikke.', 404);
    if (env.WEBMAIL_ENABLED !== '1') return unavailable(req, true);
    if (!read && (!writeMethods.has(req.method) || !url.pathname.startsWith('/SOGo/'))) {
      return localResponse(req, 'Metoden er ikke tilladt.', 405);
    }
    if (!read && !allowedWrite(req)) return localResponse(req, 'Anmodningen skal komme fra Veyro Mail.', 403);
    return proxy(req, url);
  },
};
