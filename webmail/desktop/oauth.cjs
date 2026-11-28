'use strict';
const http = require('node:http');
const {randomBytes, createHash, timingSafeEqual} = require('node:crypto');

const PROVIDERS = Object.freeze({
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/', redirectHost: '127.0.0.1', imap: 'imap.gmail.com', smtp: 'smtp.gmail.com',
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
    redirectHost: 'localhost', imap: 'outlook.office365.com', smtp: 'smtp.office365.com',
  },
});
function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  return {verifier, challenge: createHash('sha256').update(verifier).digest('base64url')};
}
function sameState(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function normalizeConfig(config = {}) {
  const result = {};
  for (const name of Object.keys(PROVIDERS)) {
    const id = config[name]?.clientId;
    if (typeof id === 'string' && /^[a-zA-Z0-9._-]{8,256}$/.test(id)) {
      result[name] = {clientId: id};
      // Some Google desktop registrations issue a public-client secret. It never reaches the renderer.
      if (name === 'google' && typeof config[name].clientSecret === 'string' && config[name].clientSecret.length <= 256) result[name].clientSecret = config[name].clientSecret;
    }
  }
  return result;
}
function providerAccount(provider, email, name = '') {
  const p = PROVIDERS[provider];
  if (!p || typeof email !== 'string' || email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) throw new Error('Skriv først din mailadresse.');
  return {email, name: String(name).slice(0, 160), authType: 'oauth', oauthProvider: provider, saveSent: false,
    imap: {host: p.imap, port: 993, secure: true, user: email},
    smtp: {host: p.smtp, port: 587, secure: false, user: email},
  };
}
function createOAuth({config = {}, openBrowser, fetchImpl = fetch, timeoutMs = 180000}) {
  const settings = normalizeConfig(config);
  const pending = new Map();
  function availability() { return Object.fromEntries(Object.keys(PROVIDERS).map((provider) => [provider, {available: !!settings[provider]}])); }
  function cancel(id) { pending.get(id)?.abort(); }
  async function tokenRequest(provider, params, signal) {
    const registration = settings[provider];
    if (!registration) throw new Error('Login hos denne udbyder er ikke aktiveret. Veyro skal først registrere en OAuth-app.');
    const body = new URLSearchParams({...params, client_id: registration.clientId});
    if (registration.clientSecret) body.set('client_secret', registration.clientSecret);
    let response;
    try { response = await fetchImpl(PROVIDERS[provider].token, {method: 'POST', body, redirect: 'error', signal: signal || AbortSignal.timeout(20000), headers: {'Content-Type': 'application/x-www-form-urlencoded'}}); }
    catch { throw new Error('Forbindelsen til loginudbyderen mislykkedes. Prøv igen.'); }
    let data;
    try { const text = await response.text(); if (text.length > 65536) throw new Error(); data = JSON.parse(text); }
    catch { throw new Error('Loginudbyderen sendte et ugyldigt svar.'); }
    if (!response.ok || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 32768 || (data.token_type && data.token_type.toLowerCase() !== 'bearer')) {
      throw new Error(data.error === 'invalid_grant' ? 'Din loginadgang er udløbet eller tilbagekaldt. Forbind kontoen igen.' : 'Login kunne ikke godkendes. Kontrollér appregistreringen og kontoens tilladelser.');
    }
    const seconds = Math.max(30, Math.min(Number(data.expires_in) || 3600, 86400));
    return {provider, clientId: registration.clientId, accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined, expiresAt: Date.now() + seconds * 1000};
  }
  async function connect(id, provider, email) {
    const p = PROVIDERS[provider], registration = settings[provider];
    if (!p || !registration) throw new Error('Login hos denne udbyder er ikke aktiveret. Veyro skal først registrere en OAuth-app.');
    if (pending.has(id)) throw new Error('Et login er allerede i gang for kontoen.');
    const controller = new AbortController();
    pending.set(id, controller);
    const {verifier, challenge} = pkce(), state = randomBytes(32).toString('base64url');
    let server, timer;
    try {
      let accept, fail;
      const callback = new Promise((resolve, reject) => { accept = resolve; fail = reject; });
      callback.catch(() => {});
      server = http.createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        response.setHeader('Referrer-Policy', 'no-referrer');
        const port = server.address()?.port;
        if (request.method !== 'GET' || request.headers.host !== `${p.redirectHost}:${port}` || request.url.length > 10000) { response.writeHead(400).end('Ugyldigt login-svar.'); return; }
        if (!request.url.startsWith('/') || request.url.startsWith('//')) { response.writeHead(400).end('Ugyldigt login-svar.'); return; }
        let url;
        try { url = new URL(request.url, `http://${p.redirectHost}:${port}`); }
        catch { response.writeHead(400).end('Ugyldigt login-svar.'); return; }
        if (url.pathname !== '/oauth/callback' || !sameState(url.searchParams.get('state'), state)) { response.writeHead(400).end('Ugyldigt login-svar.'); return; }
        if (url.searchParams.has('error')) { response.writeHead(200).end('Login blev ikke godkendt. Du kan vende tilbage til Veyro Mail.'); fail(new Error('Login blev annulleret eller afvist af udbyderen.')); return; }
        const code = url.searchParams.get('code');
        if (!code || code.length > 8192) { response.writeHead(400).end('Login-koden mangler.'); return; }
        response.writeHead(200).end('Login modtaget. Du kan lukke denne fane og vende tilbage til Veyro Mail.');
        accept(code);
      });
      server.requestTimeout = 10000;
      server.headersTimeout = 10000;
      controller.signal.addEventListener('abort', () => fail(new Error('Login blev annulleret.')), {once: true});
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const redirect = `http://${p.redirectHost}:${server.address().port}/oauth/callback`;
      const authorization = new URL(p.authorize);
      const params = {client_id: registration.clientId, redirect_uri: redirect, response_type: 'code', scope: p.scope,
        state, code_challenge: challenge, code_challenge_method: 'S256', login_hint: email};
      if (provider === 'google') { params.access_type = 'offline'; params.prompt = 'consent'; }
      else { params.response_mode = 'query'; params.prompt = 'select_account'; }
      authorization.search = new URLSearchParams(params).toString();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      await openBrowser(authorization.href);
      const code = await callback;
      const tokens = await tokenRequest(provider, {grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier}, controller.signal);
      if (!tokens.refreshToken) throw new Error('Udbyderen gav ikke vedvarende adgang. Tillad offlineadgang, og forbind kontoen igen.');
      return tokens;
    } finally {
      clearTimeout(timer);
      server?.closeAllConnections(); server?.close();
      pending.delete(id);
    }
  }
  async function fresh(tokens) {
    if (!tokens || !settings[tokens.provider] || tokens.clientId !== settings[tokens.provider].clientId) throw new Error('OAuth-registreringen er ændret eller mangler. Forbind kontoen igen.');
    if (tokens.expiresAt > Date.now() + 90000) return tokens;
    if (!tokens.refreshToken) throw new Error('Forbind kontoen igen for at forny loginadgangen.');
    const updated = await tokenRequest(tokens.provider, {grant_type: 'refresh_token', refresh_token: tokens.refreshToken, scope: PROVIDERS[tokens.provider].scope});
    return {...updated, refreshToken: updated.refreshToken || tokens.refreshToken};
  }
  return {availability, connect, fresh, cancel, cancelAll: () => { for (const id of pending.keys()) cancel(id); }};
}
module.exports = {createOAuth, providerAccount, pkce, sameState, normalizeConfig};
