const issuer = 'https://mail.veyro.dk';
const backend = 'https://post.veyro.dk/webmail-api';
const resource = issuer + '/mcp';
const scopes = ['mail.read', 'mail.draft'];
const assetPaths = new Map([
  ['/ai', '/ai.html'], ['/ai/authorize', '/ai.html'], ['/ai.css', '/ai.css'], ['/ai.js', '/ai.js'],
]);
const machinePaths = new Map([
  ['/mcp', '/api/ai/protocol/mcp'], ['/ai/register', '/api/ai/protocol/register'],
  ['/ai/token', '/api/ai/protocol/token'], ['/ai/revoke-token', '/api/ai/protocol/revoke'],
]);
const staffPaths = new Set(['/api/ai/connections', '/api/ai/authorize', '/api/ai/revoke']);
const metadata = new Map<string, unknown>([
  ['/.well-known/oauth-authorization-server', {
    issuer, authorization_endpoint: issuer + '/ai/authorize', token_endpoint: issuer + '/ai/token',
    registration_endpoint: issuer + '/ai/register', revocation_endpoint: issuer + '/ai/revoke-token',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'], scopes_supported: scopes,
    authorization_response_iss_parameter_supported: true,
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
  }],
]);
for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
  metadata.set(path, { resource, authorization_servers: [issuer], scopes_supported: scopes,
    bearer_methods_supported: ['header'], resource_name: 'Veyro Mail' });
}

interface AiEnv {
  WEBMAIL_ENABLED?: string;
  VEYRO_MAIL_ORIGIN_TOKEN?: string;
  ASSETS: Fetcher;
}

const security = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function error(status: number, message: string, allow?: string) {
  const headers = new Headers(security);
  if (allow) headers.set('Allow', allow);
  return Response.json({ error: message }, { status, headers });
}

export async function aiRoute(req: Request, env: AiEnv, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const asset = assetPaths.get(path);
  const machine = machinePaths.get(path);
  if (!asset && !machine && !staffPaths.has(path) && !metadata.has(path)) return null;
  if (url.origin !== issuer) return error(404, 'Ukendt adresse.');
  if (env.WEBMAIL_ENABLED !== '1') return error(503, 'Webmail er midlertidigt lukket.');
  if (asset || metadata.has(path)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return error(405, 'Metoden er ikke tilladt.', 'GET, HEAD');
    if (asset) {
      const upstream = await env.ASSETS.fetch(new Request(issuer + asset, { method: req.method }));
      if (!upstream.ok) return error(503, 'Siden kunne ikke hentes.');
      const type = asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'text/html';
      return new Response(upstream.body, { headers: { ...security, 'Content-Type': type + '; charset=utf-8' } });
    }
    return new Response(req.method === 'HEAD' ? null : JSON.stringify(metadata.get(path)),
      { headers: { ...security, 'Content-Type': 'application/json' } });
  }
  const read = path === '/api/ai/connections' || (path === '/mcp' && req.method === 'GET');
  const method = read ? 'GET' : 'POST';
  if (req.method !== method) return error(405, 'Metoden er ikke tilladt.', path === '/mcp' ? 'GET, POST' : method);
  if (!env.VEYRO_MAIL_ORIGIN_TOKEN) return error(503, 'Webmail er midlertidigt lukket.');
  const headers = new Headers({ 'X-Veyro-Origin-Token': env.VEYRO_MAIL_ORIGIN_TOKEN, 'Accept-Encoding': 'identity' });
  const ip = req.headers.get('CF-Connecting-IP');
  if (ip && /^[0-9a-f:.]{2,45}$/i.test(ip)) headers.set('X-Veyro-Client-IP', ip);
  const origin = req.headers.get('Origin');
  if (origin !== null && origin !== issuer) return error(403, 'Ugyldig oprindelse.');
  if (!machine) {
    const cookie = (req.headers.get('Cookie') || '').split(';').map(x => x.trim())
      .find(x => /^__Host-veyro_session=[A-Za-z0-9_-]{1,256}$/.test(x));
    if (!cookie) return error(401, 'Log ind i Veyro Mail.');
    headers.set('Cookie', cookie);
    if (!read) {
      const csrf = req.headers.get('X-CSRF-Token');
      if (origin !== issuer || !csrf || csrf.length > 256) return error(403, 'Genindlæs siden og prøv igen.');
      headers.set('Origin', issuer);
      headers.set('X-CSRF-Token', csrf);
    }
  } else {
    const auth = req.headers.get('Authorization');
    if (auth && auth.length <= 4096 && (path === '/mcp' || path === '/ai/token')) headers.set('X-Veyro-AI-Authorization', auth);
    const version = req.headers.get('MCP-Protocol-Version');
    if (version && path === '/mcp') headers.set('MCP-Protocol-Version', version);
  }
  let body: ArrayBuffer | null = null;
  if (!read) {
    const content = req.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
    const expected = ['/ai/token', '/ai/revoke-token'].includes(path) ? 'application/x-www-form-urlencoded' : 'application/json';
    if (content !== expected) return error(415, 'Ugyldigt dataformat.');
    const limit = path === '/mcp' ? 160 * 1024 : 16 * 1024;
    if (Number(req.headers.get('Content-Length')) > limit) return error(413, 'Forespørgslen er for stor.');
    headers.set('Content-Type', expected);
    // Bound chunked inputs before they reach the Flask process.
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) { await reader.cancel(); return error(413, 'Forespørgslen er for stor.'); }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = bytes.buffer;
  }
  try {
    const upstream = await fetch(backend + (machine || path), { method, headers, body, redirect: 'manual', cache: 'no-store' });
    if (upstream.status >= 300 && upstream.status < 400) return error(502, 'Uventet svar fra mailserveren.');
    const out = new Headers(security);
    out.set('Content-Type', 'application/json; charset=utf-8');
    for (const name of ['WWW-Authenticate', 'Allow', 'Retry-After']) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    if (!upstream.headers.get('Content-Type')?.includes('application/json') && ![200, 202, 405].includes(upstream.status)) {
      return error(502, 'Mailserveren er midlertidigt utilgængelig.');
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return error(502, 'Mailserveren er midlertidigt utilgængelig.');
  }
}
