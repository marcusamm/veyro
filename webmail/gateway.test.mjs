import { afterEach, describe, expect, it, vi } from 'vitest';
import gateway from './worker.ts';

const publicOrigin = 'https://mail.veyro.dk';
const backendOrigin = 'https://post.veyro.dk';
const originToken = 'fixture-edge-credential';
const sessionValue = '0123456789abcdef'.repeat(4);
const csrfToken = 'fedcba9876543210'.repeat(4);
const shell = '<title>Veyro Mail</title><script src="/inbox.js" defer></script>';
const bookmarks = ['/forhaandsvisning', '/forhaandsvisning/', '/SOGo', '/SOGo/', '/SOGo/so', '/SOGo/so/'];

function setup(env = {}) {
  const assets = vi.fn(async (input, init) => {
    const req = new Request(input, init);
    const body = new URL(req.url).pathname === '/inbox.html' ? shell : 'static content';
    return new Response(req.method === 'HEAD' ? null : body);
  });
  const config = { WEBMAIL_ENABLED: '1', VEYRO_MAIL_ORIGIN_TOKEN: originToken, ASSETS: { fetch: assets }, ...env };
  const fetch = (path, init = {}) => gateway.fetch(new Request(new URL(path, publicOrigin), init), config);
  return { fetch, assets };
}

function mockBackend(response) {
  const upstream = vi.fn(async () => response);
  vi.stubGlobal('fetch', upstream);
  return upstream;
}

afterEach(() => vi.unstubAllGlobals());

describe('Veyro Mail gateway', () => {
  it('serves the mailbox on its own origin and keeps visitor data out of static asset requests', async () => {
    const { fetch, assets } = setup();
    const upstream = mockBackend();
    const init = { headers: { Cookie: 'private=visitor', Authorization: 'Bearer example' } };
    const result = await fetch('/?search=private', init);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe(shell);
    expect(result.headers.get('Cache-Control')).toContain('no-store');
    expect(result.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(result.headers.has('Location')).toBe(false);
    for (const file of ['inbox.js', 'inbox.css', 'webmail.css', 'favicon.svg', 'manrope.woff2']) {
      expect((await fetch('/' + file + '?irrelevant=1', init)).status).toBe(200);
    }
    const requests = assets.mock.calls.map(call => new Request(...call));
    expect(requests.map(req => new URL(req.url).pathname)).toEqual(['/inbox.html', '/inbox.js', '/inbox.css', '/inbox.css', '/favicon.svg', '/manrope.woff2']);
    for (const req of requests) {
      expect(new URL(req.url).search).toBe('');
      expect(req.headers.has('Cookie')).toBe(false);
      expect(req.headers.has('Authorization')).toBe(false);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('canonicalizes old bookmarks without following visitor-provided destinations', async () => {
    const { fetch } = setup();
    for (const origin of [publicOrigin, 'http://localhost:8787', 'http://127.0.0.1:8787']) {
      for (const path of bookmarks) {
        const result = await fetch(origin + path + '?next=https://outside.invalid/', { method: 'HEAD' });
        expect(result.status).toBe(308);
        expect(new URL(result.headers.get('Location'), origin).href).toBe(publicOrigin + '/');
      }
    }
  });

  it('keeps disabled mailboxes, unpublished paths and other hosts off the backend', async () => {
    const { fetch } = setup();
    const upstream = mockBackend();
    const disabled = setup({ WEBMAIL_ENABLED: '0' });
    expect((await disabled.fetch('/', { headers: { Accept: 'text/html' } })).status).toBe(503);
    expect((await disabled.fetch('/api/session')).status).toBe(503);
    for (const path of ['/admin', '/api/v1', '/sogo-auth.php', '/SOGo/so/example/Mail', '/forhaandsvisning.css', '/forhaandsvisning.js', 'https://other.veyro.dk/api/session']) {
      expect((await fetch(path)).status).toBe(404);
    }
    expect((await setup({ VEYRO_MAIL_ORIGIN_TOKEN: undefined }).fetch('/api/session')).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes the trusted origin credential and just the webmail cookie to the fixed API', async () => {
    const { fetch } = setup();
    const upstream = mockBackend(Response.json({ error: 'Login kræves' }, { status: 401 }));
    const result = await fetch('/api/session', { headers: {
      Cookie: `MCSESSID=other; __Host-veyro_session=${sessionValue}; SOGoLogin=other`,
      Authorization: 'Bearer another-account', 'CF-Connecting-IP': '192.0.2.7',
      'X-Veyro-Origin-Token': 'browser-value', 'X-Veyro-Client-IP': '192.0.2.99',
    } });
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: 'Login kræves' });
    expect(result.headers.get('Cache-Control')).toContain('no-store');
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0];
    const sent = new Request(url, { ...init, duplex: 'half' });
    expect(sent.url).toBe(backendOrigin + '/webmail-api/api/session');
    expect(sent.redirect).toBe('manual');
    expect(sent.headers.get('Cookie')).toBe('__Host-veyro_session=' + sessionValue);
    expect(sent.headers.get('X-Veyro-Origin-Token')).toBe(originToken);
    expect(sent.headers.get('X-Veyro-Client-IP')).toBe('192.0.2.7');
    expect(sent.headers.has('Authorization')).toBe(false);
    expect(result.headers.has('X-Veyro-Origin-Token')).toBe(false);
  });

  it('rejects off-origin writes before contacting the API', async () => {
    const { fetch } = setup();
    const upstream = mockBackend();
    for (const origin of ['https://outside.invalid', 'null']) {
      const result = await fetch('/api/send', { method: 'POST', headers: {
        Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken,
      }, body: '{}' });
      expect(result.status).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('returns a local error for an unexpected upstream redirect or HTML login page', async () => {
    const { fetch } = setup();
    for (const reply of [
      new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid/auth' } }),
      new Response('<html>Other login</html>', { headers: { 'Content-Type': 'text/html' } }),
    ]) {
      mockBackend(reply);
      const res = await fetch('/api/session');
      expect(res.status).toBe(502);
      expect(res.headers.has('Location')).toBe(false);
      expect((await res.json()).error).toBeTypeOf('string');
    }
  });

  it('passes same-origin mutations and a valid host-only session cookie', async () => {
    const { fetch } = setup();
    const cookie = `__Host-veyro_session=${sessionValue}; Path=/; HttpOnly; Secure; SameSite=Strict`;
    const upstream = mockBackend(Response.json({ ok: true }, { headers: { 'Set-Cookie': cookie } }));
    const result = await fetch('/api/login', { method: 'POST', headers: {
      Origin: publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken,
    }, body: JSON.stringify({ email: 'user@example.test', password: 'fixture' }) });
    expect(result.status).toBe(200);
    const [url, init] = upstream.mock.calls[0];
    const sent = new Request(url, { ...init, duplex: 'half' });
    expect(sent.url).toBe(backendOrigin + '/webmail-api/api/login');
    expect(sent.headers.get('Origin')).toBe(publicOrigin);
    expect(await sent.json()).toEqual({ email: 'user@example.test', password: 'fixture' });
    expect(result.headers.get('Set-Cookie')).toContain('__Host-veyro_session=' + sessionValue);
  });

  it('requires a CSRF header on signed-in mutations and forwards it only to the mail API', async () => {
    const { fetch } = setup();
    const upstream = mockBackend(Response.json({ ok: true }));
    const headers = { Origin: publicOrigin, 'Content-Type': 'application/json' };
    const missing = await fetch('/api/send', { method: 'POST', headers, body: '{}' });
    expect(missing.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    const signedHeaders = { ...headers, 'X-CSRF-Token': csrfToken };
    const invalid = await fetch('/api/send', { method: 'POST', headers: { ...signedHeaders, 'Idempotency-Key': 'short' }, body: '{}' });
    expect(invalid.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    const key = '16bd9113-d1e6-46b6-8149-0338ce118c87';
    const sent = await fetch('/api/send', { method: 'POST', headers: { ...signedHeaders, 'Idempotency-Key': key }, body: '{}' });
    expect(sent.status).toBe(200);
    expect(upstream.mock.calls[0][1].headers.get('X-CSRF-Token')).toBe(csrfToken);
    expect(upstream.mock.calls[0][1].headers.get('Idempotency-Key')).toBe(key);
  });

  it('limits reads to message and MIME part identifiers and serves attachments as downloads', async () => {
    const { fetch } = setup();
    const data = new Uint8Array([31, 139, 8]);
    const upstream = mockBackend(new Response(data, { headers: { 'Content-Type': 'text/html' } }));
    for (const path of ['/api/messages/abc', '/api/messages/420.9/attachments/image.png', '/api/messages/420.9/attachments/1.']) {
      expect((await fetch(path)).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
    const path = '/api/messages/420.9/attachments/2.1?folder=inbox';
    const res = await fetch(path);
    expect(upstream.mock.calls[0][0]).toBe(backendOrigin + '/webmail-api' + path);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toBe('attachment');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
  });
});
