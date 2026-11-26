import { installationPage } from './view';
import { previewHtml, previewCss, previewJs } from './preview';
import { webmailCss } from './styles';

const PUBLIC = 'https://mail.veyro.dk';
const mailboxLogin = 'https://post.veyro.dk/';
const entryPaths = new Set(['/', '/SOGo', '/SOGo/', '/SOGo/so', '/SOGo/so/']);
const assetPaths = new Set(['/favicon.svg', '/manrope.woff2', '/Manrope-OFL.txt']);
const readMethods = new Set(['GET', 'HEAD']);
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

const html = 'text/html; charset=utf-8';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== PUBLIC && !(local && env.WEBMAIL_ENABLED !== '1')) {
      return localResponse(req, 'Ukendt adresse.', 404);
    }
    const enabled = env.WEBMAIL_ENABLED === '1';
    const read = readMethods.has(req.method);
    const preview = url.pathname === '/forhaandsvisning' || url.pathname === '/forhaandsvisning/'
      || (url.pathname === '/' && !enabled);
    if (read && preview) {
      const example = localResponse(req, previewHtml(), 200, html);
      example.headers.set('Content-Security-Policy', localPolicy + "; script-src 'self'");
      return example;
    }
    if (!enabled && (entryPaths.has(url.pathname) || url.pathname === '/SOGo/connect')) {
      const page = read && (req.headers.get('Accept') || '').includes('text/html');
      return localResponse(req, page ? installationPage : 'Postkasserne er under opsætning.', 503, page ? html : undefined);
    }
    if (!read) {
      const response = localResponse(req, 'Metoden er ikke tilladt.', 405);
      response.headers.set('Allow', 'GET, HEAD');
      return response;
    }
    if (entryPaths.has(url.pathname)) {
      // mailcow owns the login, MFA, SOGo handoff and logout on the same origin.
      const response = localResponse(req, '', 302);
      response.headers.set('Location', mailboxLogin);
      return response;
    }
    if (url.pathname === '/forhaandsvisning.css') return localResponse(req, previewCss, 200, 'text/css; charset=utf-8');
    if (url.pathname === '/forhaandsvisning.js') return localResponse(req, previewJs, 200, 'text/javascript; charset=utf-8');
    if (url.pathname === '/webmail.css') return localResponse(req, webmailCss, 200, 'text/css; charset=utf-8');
    if (url.pathname === '/robots.txt') return localResponse(req, 'User-agent: *\nDisallow: /\n', 200);
    if (assetPaths.has(url.pathname)) {
      // Assets receive no mailbox cookies or login data.
      return env.ASSETS.fetch(new Request(PUBLIC + url.pathname, { method: req.method }));
    }
    return localResponse(req, 'Siden findes ikke.', 404);
  },
};
