const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const p = require('../security.cjs');

test('remote account accepts exactly the Veyro HTTPS origin', () => {
  for (const url of ['https://mail.veyro.dk/', 'https://mail.veyro.dk/team#chat', 'https://mail.veyro.dk:443/?a=1']) assert.equal(p.allowedRemote(url), true);
  for (const url of ['http://mail.veyro.dk', 'https://mail.veyro.dk.evil.test/', 'https://mail.veyro.dk@evil.test/', 'https://evil.test@mail.veyro.dk/', 'https://mail.veyro.dk:444', 'file:///etc/passwd', 'javascript:alert(1)', 'veyro://shell/index.html', 'https://mail.veyro.dk\n.evil.test']) assert.equal(p.allowedRemote(url), false, url);
});
test('OS link opening only admits web and mailto after explicit confirmation', () => {
  for (const url of ['https://example.org/path', 'http://example.org/', 'mailto:hello@example.org?subject=Hello']) assert.ok(p.externalURL(url));
  for (const url of ['file:///tmp/test', 'javascript:alert(1)', 'data:text/html,x', 'ms-settings:foo', 'smb://server/x', 'https://user:password@example.org', 'mailto:a@example.org?subject=x%0d%0abcc:evil@example.org', '\nhttps://example.org']) assert.equal(p.externalURL(url), null, url);
});
test('trusted UI requires exact local document, not merely matching hostname', () => {
  assert.ok(p.trustedDocument(p.SHELL_URL, p.SHELL_URL));
  for (const url of ['veyro://shell/other.html', 'veyro://shell/index.html?evil', 'https://shell/index.html', 'veyro://mail/index.html', 'veyro://user@shell/index.html', 'veyro://shell/index.html#x']) assert.equal(p.trustedDocument(url, p.SHELL_URL), false);
});
test('production cannot opt into arbitrary origins or test loopback', () => {
  assert.equal(p.resolveOrigin({}), p.MAIL_ORIGIN);
  assert.equal(p.resolveOrigin({testMode: true, isPackaged: false, testOrigin: 'http://127.0.0.1:18080'}), 'http://127.0.0.1:18080');
  for (const args of [
    {testMode: true, isPackaged: true, testOrigin: 'http://127.0.0.1:18080'},
    {testMode: false, isPackaged: false, testOrigin: 'http://127.0.0.1:18080'},
    {testMode: true, isPackaged: false, testOrigin: 'https://evil.test'},
    {testMode: true, isPackaged: false, testOrigin: 'http://127.0.0.1:18080/path'},
  ]) assert.throws(() => p.resolveOrigin(args));
});
test('account ids cannot escape their isolated partition', () => {
  const first = p.partitionFor(randomUUID()), second = p.partitionFor(randomUUID());
  assert.notEqual(first, second);
  assert.match(first, /^persist:veyro-account-/);
  for (const id of ['../other', '', 'persist:default', undefined]) assert.throws(() => p.partitionFor(id));
  assert.equal(p.safeFilename('../../secret\\password.txt'), '_.._secret_password.txt');
  assert.equal(p.normalizeLabel(' Work '), 'Work');
  assert.throws(() => p.normalizeLabel('a\nb'));
});
test('blank passwords can only reuse a credential for the exact previous server and user', () => {
  const saved = {host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com', password: 'secret'};
  const blank = {...saved, password: ''};
  assert.equal(p.accountEndpoint(blank, saved).password, 'secret');
  for (const changed of [{host: 'evil.example.com'}, {port: 1993}, {user: 'b@example.com'}, {secure: false}]) {
    assert.equal(p.accountEndpoint({...blank, ...changed}, saved).password, '', JSON.stringify(changed));
  }
  assert.equal(p.accountEndpoint({...blank, host: 'new.example.com', password: 'new-secret'}, saved).password, 'new-secret');
});
