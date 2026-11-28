const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const {createOAuth, providerAccount, pkce, sameState, normalizeConfig} = require('../oauth.cjs');

test('PKCE uses independent high-entropy S256 values and malformed state cannot crash callback', () => {
  const first = pkce(), second = pkce();
  assert.notEqual(first.verifier, second.verifier);
  assert.match(first.verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(first.challenge, createHash('sha256').update(first.verifier).digest('base64url'));
  assert.equal(sameState('é'.repeat(43), 'a'.repeat(43)), false);
  assert.equal(sameState(null, 'abc'), false);
  assert.equal(sameState('abc', 'abc'), true);
});
test('unconfigured providers cannot open a browser and provider endpoints cannot be overridden', async () => {
  const oauth = createOAuth({openBrowser: () => assert.fail('Must not open browser')});
  assert.deepEqual(oauth.availability(), {google: {available: false}, microsoft: {available: false}});
  await assert.rejects(oauth.connect('account', 'google', 'a@example.com'), /ikke aktiveret/);
  assert.deepEqual(normalizeConfig({google: {clientId: 'valid-client-id', token: 'https://evil.test', redirect: '/tmp'}}), {google: {clientId: 'valid-client-id'}});
  assert.throws(() => providerAccount('google', 'a@example.com\nBcc:evil@example.com'));
  assert.equal(providerAccount('microsoft', 'a@example.com').imap.host, 'outlook.office365.com');
});
test('loopback validates path, host and state, uses PKCE, then exchanges only at fixed TLS endpoint', async () => {
  let authorization, request;
  const oauth = createOAuth({config: {google: {clientId: 'google-client-id'}},
    openBrowser: async (value) => {
      authorization = new URL(value);
      assert.equal(authorization.origin, 'https://accounts.google.com');
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorization.searchParams.get('access_type'), 'offline');
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      callback.search = new URLSearchParams({code: 'good-code', state: 'é'.repeat(43)});
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      const wrongHost = await new Promise((resolve, reject) => {
        const request = http.get(callback, {headers: {Host: 'evil.example'}}, (response) => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
      });
      assert.equal(wrongHost, 400);
      const malformed = await new Promise((resolve, reject) => {
        const socket = net.connect(Number(callback.port), '127.0.0.1', () => socket.write(`GET http://[ HTTP/1.1\r\nHost: ${callback.host}\r\nConnection: close\r\n\r\n`));
        let output = ''; socket.on('data', (data) => { output += data; }); socket.on('end', () => resolve(output)); socket.on('error', reject);
      });
      assert.match(malformed, /^HTTP\/1\.1 400/);
      const wrong = new URL(callback); wrong.pathname = '/wrong';
      assert.equal((await fetch(wrong)).status, 400);
      assert.equal((await fetch(callback)).status, 200);
    },
    fetchImpl: async (url, options) => {
      request = {url, options};
      return new Response(JSON.stringify({access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer'}));
    },
  });
  const tokens = await oauth.connect('account', 'google', 'a@example.com');
  assert.equal(tokens.refreshToken, 'refresh');
  assert.equal(request.url, 'https://oauth2.googleapis.com/token');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.body.get('code'), 'good-code');
  assert.equal(createHash('sha256').update(request.options.body.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
  await assert.rejects(fetch(authorization.searchParams.get('redirect_uri')));
});
test('Microsoft uses its fixed public-client scopes and localhost redirect', async () => {
  const oauth = createOAuth({config: {microsoft: {clientId: 'microsoft-client-id'}},
    openBrowser: async (value) => {
      const auth = new URL(value), callback = new URL(auth.searchParams.get('redirect_uri'));
      assert.equal(auth.origin, 'https://login.microsoftonline.com');
      assert.equal(callback.hostname, 'localhost');
      assert.match(auth.searchParams.get('scope'), /https:\/\/outlook.office.com\/SMTP.Send/);
      callback.search = new URLSearchParams({state: auth.searchParams.get('state'), code: 'ok'});
      await fetch(callback);
    },
    fetchImpl: async () => new Response(JSON.stringify({access_token: 'access', refresh_token: 'refresh'})),
  });
  assert.equal((await oauth.connect('account', 'microsoft', 'a@example.com')).provider, 'microsoft');
});
test('refresh rotates tokens without returning old token errors or allowing changed client registrations', async () => {
  let calls = 0;
  const oauth = createOAuth({config: {google: {clientId: 'registered-id'}}, openBrowser: () => {},
    fetchImpl: async (_url, options) => {
      calls++; assert.equal(options.body.get('grant_type'), 'refresh_token');
      assert.equal(options.body.get('refresh_token'), 'old-refresh');
      return new Response(JSON.stringify({access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600}));
    },
  });
  const tokens = {provider: 'google', clientId: 'registered-id', accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 3600000};
  assert.equal(await oauth.fresh(tokens), tokens);
  assert.equal(calls, 0);
  const fresh = await oauth.fresh({...tokens, expiresAt: 1});
  assert.equal(fresh.refreshToken, 'new-refresh'); assert.equal(fresh.accessToken, 'new-access');
  await assert.rejects(oauth.fresh({...tokens, clientId: 'changed-registration'}), /ændret/);
});
test('cancel stops pending loopback login promptly and provider errors are sanitized', async () => {
  let oauth, callback;
  oauth = createOAuth({config: {google: {clientId: 'registered-id'}},
    openBrowser: async (value) => { callback = new URL(value).searchParams.get('redirect_uri'); oauth.cancel('account'); },
    fetchImpl: () => assert.fail('Cancelled login must not exchange a code'),
  });
  await assert.rejects(oauth.connect('account', 'google', 'a@example.com'), /annulleret/);
  await assert.rejects(fetch(callback));
  const failed = createOAuth({config: {google: {clientId: 'registered-id'}}, openBrowser: () => {},
    fetchImpl: async () => new Response(JSON.stringify({error: 'invalid_grant', error_description: 'SECRET_TOKEN'}), {status: 400}),
  });
  await assert.rejects(failed.fresh({provider: 'google', clientId: 'registered-id', refreshToken: 'secret', expiresAt: 1}), (error) => !error.message.includes('SECRET_TOKEN') && /tilbagekaldt/.test(error.message));
});
