import { unavailablePage } from './view';
import { aiRoute } from './ai_gateway';

const webOrigin = 'https://mail.veyro.dk';
const apiOrigin = 'https://post.veyro.dk/webmail-api';
const bookmarks = new Set(['/forhaandsvisning', '/forhaandsvisning/', '/SOGo', '/SOGo/', '/SOGo/so', '/SOGo/so/']);
const staticFiles = new Map([
  ['/inbox.css', '/inbox.css'], ['/webmail.css', '/inbox.css'], ['/inbox.js', '/inbox.js'],
  ['/favicon.svg', '/favicon.svg'], ['/manrope.woff2', '/manrope.woff2'], ['/Manrope-OFL.txt', '/Manrope-OFL.txt'],
  ['/administration.css', '/administration.css'], ['/administration.js', '/administration.js'],
  ['/message-frame.js', '/message-frame.js'],
]);
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
export function messageFramePolicy(images = false, origin = webOrigin) {
  return `default-src 'none'; script-src ${origin}/message-frame.js; style-src 'unsafe-inline'; img-src data:${images ? ' https:' : ''}; font-src 'none'; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`;
}
const readApi = /^\/api\/(?:session|folders|messages(?:\/[0-9]{1,10}\.[0-9]{1,10}(?:\/attachments\/[1-9][0-9]*(?:\.[1-9][0-9]*)*)?)?)$/;
const recoveryRequest = '/api/recovery/request';
const adminReads = new Set(['/api/admin/organizations', '/api/admin/mailboxes', '/api/admin/dns']);
const accountWrites = new Set(['/api/password', '/api/recovery/enroll/start', '/api/recovery/enroll/confirm',
  '/api/admin/organizations', '/api/admin/mailboxes', '/api/admin/mailboxes/status',
  '/api/admin/mailboxes/password', '/api/admin/mailboxes/role']);
const writeApi = new Set(['/api/login', '/api/logout', '/api/send', recoveryRequest, ...accountWrites]);
const messageWrite = /^\/api\/messages\/[0-9]{1,10}\.[0-9]{1,10}\/(?:action|snooze)$/;
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
    'Content-Security-Policy': policy, 'X-Frame-Options': 'DENY', 'X-DNS-Prefetch-Control': 'off',
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
  if (url.pathname.startsWith('/api/admin/') && !headers.has('Cookie')) return apiError(req, 'Log ind igen.', 401);

  if (write) {
    if (req.headers.get('Origin') !== webOrigin) return apiError(req, 'Ugyldig oprindelse.', 403);
    if (req.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return apiError(req, 'Send data som JSON.', 415);
    if (Number(req.headers.get('Content-Length')) > maxBody) return apiError(req, 'Beskeden er for stor.', 413);
    if ((accountWrites.has(url.pathname) || messageWrite.test(url.pathname)) && !headers.has('Cookie')) return apiError(req, 'Log ind igen.', 401);
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
    let search = write || url.pathname.startsWith('/api/admin/') ? '' : url.search;
    if (!write && (url.pathname === '/api/admin/mailboxes' || url.pathname === '/api/admin/dns')) {
      const domains = url.searchParams.getAll('domain');
      if (domains.length !== 1 || !domains[0] || domains[0].length > 253) return apiError(req, 'Vælg en organisation.', 400);
      search = '?' + new URLSearchParams({domain: domains[0]});
    }
    if (messageWrite.test(url.pathname)) {
      const folders = url.searchParams.getAll('folder');
      if (folders.length !== 1 || !folders[0] || !/^[A-Za-z0-9_-]{1,1600}$/.test(folders[0])) return apiError(req, 'Ugyldig mappe.', 400);
      search = '?folder=' + folders[0];
    }
    const upstream = await fetch(apiOrigin + url.pathname + search, {
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

async function administrationPage(req: Request, env: Env) {
  const url = new URL('/api/session', webOrigin);
  const session = await proxy(new Request(url, {headers:req.headers}), env, url, false);
  const data = await session.json<{canManageOrganizations?: boolean}>().catch(() => null);
  if (session.ok && data?.canManageOrganizations === true) return asset(req, env, '/administration.html', true);
  const status = session.ok ? 403 : session.status;
  const message = status === 401 ? 'Log ind i Veyro Mail for at fortsætte.'
    : status === 403 ? 'Din konto har ikke adgang til mailadministrationen.' : 'Mailadministrationen er midlertidigt utilgængelig.';
  return localResponse(req, '<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mailadministration · Veyro Mail</title><link rel="stylesheet" href="/administration.css"><main class="access"><h1>Mailadministration</h1><p>' + message + '</p><a href="/">Åbn Veyro Mail</a></main></html>', status, 'text/html; charset=utf-8');
}

async function serveWebmail(req: Request, env: Env, url: URL, read: boolean): Promise<Response> {
  const path = url.pathname;
  const assistant = await aiRoute(req, env, url);
  if (assistant) return assistant;
  const isReadApi = readApi.test(path) || adminReads.has(path);
  const isWriteApi = writeApi.has(path) || messageWrite.test(path);
  if (env.WEBMAIL_ENABLED !== '1' && (path === '/' || path === '/administration' || bookmarks.has(path) || path === '/SOGo/connect' || isReadApi || isWriteApi)) {
    if (isReadApi || isWriteApi) return apiError(req, 'Webmail er midlertidigt lukket.', 503);
    const page = read && req.headers.get('Accept')?.includes('text/html');
    return localResponse(req, page ? unavailablePage : 'Webmail er midlertidigt lukket.', 503, page ? 'text/html; charset=utf-8' : undefined);
  }
  if (isReadApi || isWriteApi) {
    if (isWriteApi && req.method === 'POST') return proxy(req, env, url, true);
    if (isReadApi && req.method === 'GET') return proxy(req, env, url, false);
    return methodNotAllowed(req, isReadApi && isWriteApi ? 'GET, POST' : isWriteApi ? 'POST' : 'GET');
  }
  if (!read) return methodNotAllowed(req, 'GET, HEAD');
  if (path === '/message-frame') {
    const response = await asset(req, env, '/message-frame.html', true);
    response.headers.set('Content-Security-Policy', messageFramePolicy(url.searchParams.get('images') === '1'));
    response.headers.set('X-Frame-Options', 'SAMEORIGIN');
    return response;
  }
  if (path === '/') return asset(req, env, '/inbox.html', true);
  if (path === '/administration') return administrationPage(req, env);
  if (bookmarks.has(path)) return redirect('/');
  if (path === '/robots.txt') return localResponse(req, 'User-agent: *\nDisallow: /\n', 200);
  const file = staticFiles.get(path);
  return file ? asset(req, env, file) : localResponse(req, 'Siden findes ikke.', 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (url.origin !== webOrigin) {
      if (read && url.origin === 'http://mail.veyro.dk') return redirect(webOrigin + url.pathname + url.search);
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && read && (url.pathname === '/' || bookmarks.has(url.pathname))) return redirect(webOrigin + '/');
      return localResponse(req, 'Ukendt adresse.', 404);
    }
    const response = await serveWebmail(req, env, url, read);
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
    return response;
  },
};
