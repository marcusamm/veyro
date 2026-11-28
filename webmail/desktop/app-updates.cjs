'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {createWriteStream} = require('node:fs');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {installPackage} = require('./update-install.cjs');

const BASE = 'https://post.veyro.dk/webmail-downloads/';
const MAX_PACKAGE = 512 * 1024 * 1024;
const MAX_MANIFEST = 32 * 1024;
const platforms = {'win32-x64':'win-x64.exe', 'darwin-x64':'mac-x64.dmg', 'darwin-arm64':'mac-arm64.dmg'};

class UpdateError extends Error {}

function versionParts(value) {
  const integer = '(0|[1-9][0-9]{0,8})';
  const pattern = new RegExp('^' + integer + '\\.' + integer + '\\.' + integer + '(?:-beta\\.' + integer + ')?$');
  const match = typeof value === 'string' && value.match(pattern);
  if (!match) throw new UpdateError('Udgivelsen har et ukendt versionsnummer.');
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])];
}
function newerVersion(next, current) {
  const a = versionParts(next), b = versionParts(current);
  const i = a.findIndex((part, index) => part !== b[index]);
  return i >= 0 && a[i] > b[i];
}
function base64(value) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_MANIFEST) throw Error('Invalid base64');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw Error('Invalid base64');
  return decoded;
}
function verifyManifest(bytes, publicKey, platform) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_MANIFEST || !Object.hasOwn(platforms, platform)) throw Error();
    const envelope = JSON.parse(bytes.toString('utf8'));
    const raw = base64(envelope.payload), signature = base64(envelope.signature);
    const key = crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !crypto.verify(null, raw, key, signature)) throw Error();
    const manifest = JSON.parse(raw.toString('utf8'));
    if (manifest.schema !== 1) throw Error();
    versionParts(manifest.version);
    const name = 'Veyro-Mail-' + manifest.version + '-' + platforms[platform];
    const entry = manifest.files[platform];
    if (!entry || entry.name !== name || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_PACKAGE ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error();
    return {version: manifest.version, name, size: entry.size, sha256: entry.sha256};
  } catch {
    throw new UpdateError('Opdateringens udgiver eller indhold kunne ikke bekræftes.');
  }
}
async function getResponse(fetcher, filename, signal) {
  const response = await fetcher(BASE + filename, {method:'GET', redirect:'error', credentials:'omit', cache:'no-store', signal,
    headers:{'Accept-Encoding':'identity'}});
  if (response.status !== 200 || !response.body || response.redirected) throw new UpdateError('Opdateringsserveren kunne ikke levere filen.');
  return response;
}
async function getManifest(fetcher, publicKey, platform, signal) {
  const response = await getResponse(fetcher, 'update.json', signal);
  const chunks = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    total += chunk.length;
    if (total > MAX_MANIFEST) throw new UpdateError('Opdateringslisten var for stor.');
    chunks.push(chunk);
  }
  return verifyManifest(Buffer.concat(chunks), publicKey, platform);
}
async function download(fetcher, release, target, signal, progress) {
  const response = await getResponse(fetcher, release.name, signal);
  const length = response.headers.get('content-length');
  if (length !== null && length !== String(release.size)) throw new UpdateError('Opdateringen havde en forkert filstørrelse.');
  const hash = crypto.createHash('sha256');
  let received = 0, last = 0;
  const verify = new Transform({
    transform(chunk, encoding, done) {
      received += chunk.length;
      if (received > release.size) return done(new UpdateError('Opdateringen var større end forventet.'));
      hash.update(chunk);
      const percent = Math.floor(received * 100 / release.size);
      if (percent > last && percent < 100) { progress(percent); last = percent; }
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(target,{flags:'wx',mode:0o600}), {signal});
  if (received !== release.size || hash.digest('hex') !== release.sha256) throw new UpdateError('Opdateringen bestod ikke filkontrollen.');
}
function createUpdater({platform=process.platform, arch=process.arch, currentVersion, enabled, userData, execPath,
  publish, readyToRestart, lockEditors=() => {}, quit, fetcher=globalThis.fetch, readKey=() => fs.readFile(path.join(__dirname,'assets','update-signing-key.pem')),
  install=installPackage}) {
  const target = platform + '-' + arch;
  const controller = new AbortController();
  const directory = path.join(userData,'downloaded-updates');
  let state = {status:enabled && Object.hasOwn(platforms,target) ? 'idle' : 'unsupported', currentVersion};
  let release, busy, startupTimer, interval;
  function notify(status, extra) {
    state = {status, currentVersion, ...(release && {version: release.version}), ...extra};
    publish();
    return state;
  }
  function operation(action) {
    if (busy) return busy;
    if (state.status === 'unsupported' || state.status === 'installing' || controller.signal.aborted) return Promise.resolve(state);
    busy = Promise.resolve().then(action).catch(e => {
      if (controller.signal.aborted) return state;
      return notify('error', {error:e instanceof UpdateError ? e.message : 'Opdateringen kunne ikke gennemføres. Prøv igen.'});
    }).finally(() => { busy = undefined; });
    return busy;
  }
  async function latest() {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    return getManifest(fetcher, await readKey(), target, signal);
  }
  function check() {
    return operation(async () => {
      release = undefined;
      notify('checking');
      const item = await latest();
      if (!newerVersion(item.version,currentVersion)) return notify('current');
      release = item;
      return notify('available');
    });
  }
  function apply() {
    if (state.status !== 'available' || !release) return Promise.resolve(state);
    return operation(async () => {
      const announced = release;
      await readyToRestart();
      const item = await latest();
      if (!newerVersion(item.version,currentVersion)) { release = undefined; return notify('current'); }
      release = item;
      if (announced.version !== item.version || announced.sha256 !== item.sha256) return notify('available');
      notify('downloading',{progress:0});
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const working = await fs.mkdtemp(path.join(directory,'version-'));
      let handedOff = false, locked = false;
      try {
        const filename = path.join(working,item.name);
        const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(15*60*1000)]);
        await download(fetcher,item,filename,signal,progress => notify('downloading',{progress}));
        notify('installing',{progress:100});
        const beforeHandoff = async () => {
          controller.signal.throwIfAborted();
          lockEditors(true); locked = true;
          await readyToRestart();
        };
        await install({platform,filename,working,execPath,release:item,beforeHandoff,UpdateError});
        handedOff = true;
        quit();
        return state;
      } finally {
        if (!handedOff && locked) lockEditors(false);
        // Windows runs its installer here. macOS keeps a startup receipt in the folder.
        if (!handedOff) await fs.rm(working,{recursive:true,force:true}).catch(() => {});
      }
    });
  }
  async function cleanup() {
    const entries = await fs.readdir(directory,{withFileTypes:true}).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^version-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      const folder = path.join(directory,entry.name);
      const info = await fs.lstat(folder).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 24*3600*1000) await fs.rm(folder,{recursive:true,force:true}).catch(() => {});
    }
  }
  function start() {
    if (state.status === 'unsupported' || startupTimer) return;
    void cleanup();
    startupTimer = setTimeout(check,12000);
    interval = setInterval(check,6*3600*1000);
    startupTimer.unref(); interval.unref();
  }
  function stop() { clearTimeout(startupTimer); clearInterval(interval); controller.abort(); }
  return {snapshot:() => ({...state}), check, apply, start, stop};
}
module.exports = {UpdateError, createUpdater, verifyManifest, newerVersion, download};
