'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {UUID} = require('./security.cjs');

// Account metadata is separate. Credentials and local drafts always use the OS-backed vault.
function createVault({safeStorage, directory}) {
  function filename(id) {
    if (!UUID.test(id)) throw new Error('Ugyldigt konto-id.');
    return path.join(directory, `${id}.enc`);
  }
  async function available() {
    const enabled = safeStorage.isAsyncEncryptionAvailable ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
    return enabled && (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  }
  async function read(id) {
    if (!(await available())) throw new Error('Operativsystemets sikre nøglering er ikke tilgængelig.');
    try {
      const encrypted = await fs.readFile(filename(id));
      const decrypted = safeStorage.decryptStringAsync ? await safeStorage.decryptStringAsync(encrypted) : {result: safeStorage.decryptString(encrypted)};
      const data = JSON.parse(decrypted.result);
      if (decrypted.shouldReEncrypt) await write(id, data);
      return data;
    }
    catch (error) { if (error.code === 'ENOENT') return {drafts: []}; throw new Error('Den sikre konto kunne ikke åbnes. Lås din nøglering op, og prøv igen.'); }
  }
  async function write(id, data) {
    if (!(await available())) throw new Error('Operativsystemets sikre nøglering er ikke tilgængelig.');
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const target = filename(id);
    const encrypted = safeStorage.encryptStringAsync ? await safeStorage.encryptStringAsync(JSON.stringify(data)) : safeStorage.encryptString(JSON.stringify(data));
    await fs.writeFile(`${target}.tmp`, encrypted, {mode: 0o600});
    await fs.rename(`${target}.tmp`, target);
  }
  async function remove(id) {
    await fs.rm(filename(id), {force: true});
    await fs.rm(`${filename(id)}.tmp`, {force: true});
  }
  return {read, write, remove, available};
}
module.exports = {createVault};
