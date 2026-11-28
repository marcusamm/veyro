'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {createReadStream} = require('node:fs');
const {version} = require('../package.json');

const releasePlatforms = {'darwin-arm64':'mac-arm64.dmg', 'darwin-x64':'mac-x64.dmg', 'win32-x64':'win-x64.exe'};

async function signUpdate(directory, releaseVersion, privateKeyFile, publicKeyFile) {
  const part = '(?:0|[1-9][0-9]{0,5})';
  if (!new RegExp('^' + part + '\\.' + part + '\\.' + part + '(?:-beta\\.' + part + ')?$').test(releaseVersion)) throw Error('Unsupported desktop version.');
  const keyInfo = await fs.lstat(privateKeyFile);
  if (!keyInfo.isFile() || (process.platform !== 'win32' && (keyInfo.mode & 0o077 || keyInfo.uid !== process.getuid()))) {
    throw Error('Use a private Ed25519 signing key file owned by the release user (0600).');
  }
  const privateKey = crypto.createPrivateKey(await fs.readFile(privateKeyFile));
  const publicKey = crypto.createPublicKey(await fs.readFile(publicKeyFile));
  if (privateKey.asymmetricKeyType !== 'ed25519' || !crypto.createPublicKey(privateKey).equals(publicKey)) {
    throw Error('Signing key does not match the update key bundled in Veyro Mail.');
  }
  const files = {};
  for (const [platform, suffix] of Object.entries(releasePlatforms)) {
    const name = 'Veyro-Mail-' + releaseVersion + '-' + suffix;
    const filename = path.join(directory, name);
    const info = await fs.lstat(filename);
    if (!info.isFile() || !info.size || info.size > 512 * 1024 * 1024) throw Error('Unexpected installer: ' + name);
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const block of createReadStream(filename)) { size += block.length; hash.update(block); }
    if (size !== info.size) throw Error('Installer changed during signing: ' + name);
    files[platform] = {name, size, sha256:hash.digest('hex')};
  }
  const payload = Buffer.from(JSON.stringify({schema:1, version:releaseVersion, files}), 'utf8');
  const signature = crypto.sign(null, payload, privateKey).toString('base64');
  const tmp = path.join(directory, '.update-' + crypto.randomUUID());
  try {
    await fs.writeFile(tmp, JSON.stringify({payload:payload.toString('base64'), signature}) + '\n', {flag:'wx', mode:0o644});
    await fs.rename(tmp, path.join(directory, 'update.json'));
  } finally { await fs.rm(tmp, {force:true}); }
}
if (require.main === module) {
  const signingKey = process.env.VEYRO_RELEASE_SIGNING_KEY ||
    path.join(os.homedir(), 'Library/Application Support/Veyro Release/desktop-update-signing.pem');
  signUpdate(path.join(__dirname, '../dist'), version, signingKey, path.join(__dirname, '../assets/update-signing-key.pem'))
    .then(() => console.log('Verified all three artifacts and signed dist/update.json for', version))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = {signUpdate};
