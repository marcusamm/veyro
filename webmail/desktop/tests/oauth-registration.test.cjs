const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {loadOAuthRegistration} = require('../oauth-registration.cjs');

test('ordinary development never discovers an ignored registration implicitly', () => {
  assert.deepEqual(loadOAuthRegistration({isPackaged: false, template: {google: {clientId: ''}, microsoft: {clientId: ''}}}), {});
});
test('explicit development file and packaged runtime resource load only supported registration fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veyro-registration-test-'));
  const filename = path.join(directory, 'oauth-config.runtime.json');
  try {
    await fs.writeFile(filename, JSON.stringify({google: {clientId: 'synthetic-client-id', clientSecret: 'synthetic-public-credential', tokenEndpoint: 'https://evil.test'}, microsoft: {clientId: ''}}));
    const expected = {google: {clientId: 'synthetic-client-id', clientSecret: 'synthetic-public-credential'}};
    assert.deepEqual(loadOAuthRegistration({isPackaged: false, explicitFile: filename}), expected);
    assert.deepEqual(loadOAuthRegistration({isPackaged: true, resourcesPath: directory, explicitFile: '/ignored/environment/path'}), expected);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});
test('unconfigured packaged builds use the empty template without requiring a runtime file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veyro-registration-empty-'));
  try { assert.deepEqual(loadOAuthRegistration({isPackaged: true, resourcesPath: directory, template: {}}), {}); }
  finally { await fs.rm(directory, {recursive: true, force: true}); }
});
test('explicit unreadable or malformed registration fails without echoing its contents', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veyro-registration-invalid-'));
  const filename = path.join(directory, 'bad.json');
  try {
    assert.throws(() => loadOAuthRegistration({isPackaged: false, explicitFile: filename}), /konfigurationen/);
    await fs.writeFile(filename, 'PRIVATE-CONTENT{');
    assert.throws(() => loadOAuthRegistration({isPackaged: false, explicitFile: filename}), (error) => !error.message.includes('PRIVATE-CONTENT') && /konfigurationen/.test(error.message));
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});
