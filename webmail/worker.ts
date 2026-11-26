import { unavailablePage } from './view';

const webOrigin = 'https://mail.veyro.dk';
const apiOrigin = 'https://post.veyro.dk/webmail-api';
const bookmarks = new Set(['/forhaandsvisning', '/forhaandsvisning/', '/SOGo', '/SOGo/', '/SOGo/so', '/SOGo/so/']);
const staticFiles = new Map([
  ['/inbox.css', '/inbox.css'], ['/webmail.css', '/inbox.css'], ['/inbox.js', '/inbox.js'],
  ['/favicon.svg', '/favicon.svg'], ['/manrope.woff2', '/manrope.woff2'], ['/Manrope-OFL.txt', '/Manrope-OFL.txt'],
]);
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const readApi = /^\/api\/(?:session|folders|messages(?:\/[0-9]{1,10}\.[0-9]{1,10}(?:\/attachments\/[1-9][0-9]*(?:\.[1-9][0-9]*)*)?)?)$/;
const recoveryRequest = '/api/recovery/request';
const accountWrites = new Set(['/api/password', '/api/recovery/enroll/start', '/api/recovery/enroll/confirm']);
const writeApi = new Set(['/api/login', '/api/logout', '/api/send', recoveryRequest, ...accountWrites]);
const sessionName = '__Host-veyro_session';
const maxBody = 256 * 1024;

interface Env {
  WEBMAIL_ENABLED?: string;
  VEYRO_MAIL_ORIGIN_TOKEN?: string;
  ASSETS: Fetcher;
}

function responseHeaders(type = 'text/plain; charset=utf-8') {
  return new Headers({
    'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': policy, 'X-Frame-Options': 'DENY',
  });
}

function localResponse(req: Request, body: string, status: number, type?: string) {
  return new Response(req.method === 'HEAD' ? null : body, { status, headers: responseHeaders(type) });
}

function apiError(req: Request, message: string, status: number) {
  return localResponse(req, JSON.stringify({ error: message }), status, 'application/json; charset=utf-8');
}

function methodNotAllowed(req: Request, allowed: string) {
  const response = localResponse(req, 'Metoden er ikke tilladt.', 405);
  response.headers.set('Allow', allowed);
  return response;
}

function redirect(to: string) {
  const headers = responseHeaders();
  headers.set('Location', to);
  return new Response(null, { status: 308, headers });
}

async function asset(req: Request, env: Env, path: string, isPage = false) {
  const bundled = await env.ASSETS.fetch(new Request(webOrigin + path, { method: req.method, redirect: 'manual' }));
  if (!bundled.ok) return localResponse(req, 'Webmail er midlertidigt utilgængelig.', 503);
  const headers = responseHeaders(bundled.headers.get('Content-Type') || 'application/octet-stream');
  if (isPage) headers.set('Content-Type', 'text/html; charset=utf-8');
  else headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  if (!isPage && bundled.headers.has('ETag')) headers.set('ETag', bundled.headers.get('ETag')!);
  return new Response(req.method === 'HEAD' ? null : bundled.body, { status: 200, headers });
}

async function proxy(req: Request, env: Env, url: URL, write: boolean) {
  if (!env.VEYRO_MAIL_ORIGIN_TOKEN) return apiError(req, 'Webmail er midlertidigt utilgængelig.', 503);
  const headers = new Headers({ 'X-Veyro-Origin-Token': env.VEYRO_MAIL_ORIGIN_TOKEN, 'Accept-Encoding': 'identity' });
  const ip = req.headers.get('CF-Connecting-IP');
  if (ip && /^[0-9a-f:.]{2,45}$/i.test(ip)) headers.set('X-Veyro-Client-IP', ip);
  const session = (req.headers.get('Cookie') || '').split(';').map(c => c.trim()).find(c => c.startsWith(sessionName + '='));
  if (url.pathname !== recoveryRequest && session && /^[A-Za-z0-9_-]{1,256}$/.test(session.slice(sessionName.length + 1))) headers.set('Cookie', session);

  if (write) {
    if (req.headers.get('Origin') !== webOrigin) return apiError(req, 'Ugyldig oprindelse.', 403);
    if (req.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return apiError(req, 'Send data som JSON.', 415);
    if (Number(req.headers.get('Content-Length')) > maxBody) return apiError(req, 'Beskeden er for stor.', 413);
    if (accountWrites.has(url.pathname) && !headers.has('Cookie')) return apiError(req, 'Log ind igen.', 401);
    if (url.pathname !== '/api/login' && url.pathname !== recoveryRequest) {
      const csrf = req.headers.get('X-CSRF-Token');
      if (!csrf || csrf.length > 256) return apiError(req, 'Log ind igen.', 403);
      headers.set('X-CSRF-Token', csrf);
    }
    if (url.pathname === '/api/send') {
      const operationId = req.headers.get('Idempotency-Key');
      if (operationId !== null) {
        if (!/^[A-Za-z0-9_-]{16,100}$/.test(operationId)) return apiError(req, 'Ugyldig afsendelsesnøgle.', 400);
        headers.set('Idempotency-Key', operationId);
      }
    }
    headers.set('Origin', webOrigin);
    headers.set('Content-Type', 'application/json');
  }

  try {
    const upstream = await fetch(apiOrigin + url.pathname + (write ? '' : url.search), {
      method: req.method, headers, body: write ? req.body : null, redirect: 'manual', cache: 'no-store',
    });
    if (upstream.status >= 300 && upstream.status < 400) return apiError(req, 'Mailserveren svarede uventet.', 502);
    const download = url.pathname.includes('/attachments/') && upstream.ok;
    const out = responseHeaders(download ? 'application/octet-stream' : 'application/json; charset=utf-8');
    if (!download && !upstream.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
      if (upstream.status === 413) return apiError(req, 'Beskeden er for stor.', 413);
      return apiError(req, 'Mailserveren er midlertidigt utilgængelig.', 502);
    }
    if (download) {
      const disposition = upstream.headers.get('Content-Disposition');
      out.set('Content-Disposition', disposition?.startsWith('attachment;') ? disposition : 'attachment');
      out.set('Content-Security-Policy', "default-src 'none'; sandbox");
    }
    const cookie = upstream.headers.get('Set-Cookie');
    if (url.pathname !== recoveryRequest && cookie?.startsWith(sessionName + '=') && !/[,;]\s*domain=/i.test(cookie)) out.set('Set-Cookie', cookie);
    const retryAfter = upstream.headers.get('Retry-After');
    if (retryAfter && /^\d{1,6}$/.test(retryAfter)) out.set('Retry-After', retryAfter);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return apiError(req, 'Forbindelsen til mailserveren blev afbrudt.', 502);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (url.origin !== webOrigin) {
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && read && (path === '/' || bookmarks.has(path))) return redirect(webOrigin + '/');
      return localResponse(req, 'Ukendt adresse.', 404);
    }
    const isReadApi = readApi.test(path);
    const isWriteApi = writeApi.has(path);
    if (env.WEBMAIL_ENABLED !== '1' && (path === '/' || bookmarks.has(path) || path === '/SOGo/connect' || isReadApi || isWriteApi)) {
      if (isReadApi || isWriteApi) return apiError(req, 'Webmail er midlertidigt lukket.', 503);
      const page = read && req.headers.get('Accept')?.includes('text/html');
      return localResponse(req, page ? unavailablePage : 'Webmail er midlertidigt lukket.', 503, page ? 'text/html; charset=utf-8' : undefined);
    }
    if (isReadApi || isWriteApi) {
      const method = isWriteApi ? 'POST' : 'GET';
      return req.method === method ? proxy(req, env, url, isWriteApi) : methodNotAllowed(req, method);
    }
    if (!read) return methodNotAllowed(req, 'GET, HEAD');
    if (path === '/') return asset(req, env, '/inbox.html', true);
    if (bookmarks.has(path)) return redirect('/');
    if (path === '/robots.txt') return localResponse(req, 'User-agent: *\nDisallow: /\n', 200);
    const file = staticFiles.get(path);
    return file ? asset(req, env, file) : localResponse(req, 'Siden findes ikke.', 404);
  },
};
