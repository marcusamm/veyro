const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID, randomBytes, createCipheriv, createDecipheriv} = require('node:crypto');
const {createVault} = require('../vault.cjs');

test('vault never writes plaintext credentials and deletion removes encrypted record', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veyro-vault-'));
  const key = randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(16); const c = createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, c.update(value), c.final()]); },
    decryptString(value) { const c = createDecipheriv('aes-256-cbc', key, value.subarray(0, 16)); return Buffer.concat([c.update(value.subarray(16)), c.final()]).toString(); },
  };
  const vault = createVault({safeStorage, directory}), id = randomUUID();
  try {
    await vault.write(id, {account: {password: 'very-secret-password'}, drafts: [{text: 'private message'}]});
    assert.equal((await fs.readFile(path.join(directory, `${id}.enc`))).includes('very-secret-password'), false);
    assert.equal((await vault.read(id)).account.password, 'very-secret-password');
    await vault.remove(id);
    assert.deepEqual(await vault.read(id), {drafts: []});
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});
test('vault refuses unavailable encryption and plaintext Linux fallback', async () => {
  for (const safeStorage of [{isEncryptionAvailable: () => false}, {isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text'}]) {
    const vault = createVault({safeStorage, directory: '/unused'});
    await assert.rejects(vault.write(randomUUID(), {password: 'secret'}), /nøglering/);
    await assert.rejects(vault.read(randomUUID()), /nøglering/);
  }
});
