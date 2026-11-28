const releaseOrigin = 'https://post.veyro.dk/webmail-downloads/';
const manifestLimit = 16 * 1024;
// SPKI for the same release key embedded in Veyro Mail. The gateway test checks both copies.
export const releaseKey = 'MCowBQYDK2VwAyEABmoqlwND8bMfPlrg1I8UDD+0aHLadJsx1BYgAt8TzBA=';
const platforms = new Map<string, readonly [string,string]>([
  ['/download/windows', ['win32-x64', 'win-x64.exe']],
  ['/download/mac-apple', ['darwin-arm64', 'mac-arm64.dmg']],
  ['/download/mac-intel', ['darwin-x64', 'mac-x64.dmg']],
]);

function decode(value: unknown, limit: number) {
  if (typeof value !== 'string' || !value || value.length > limit) throw new Error('Invalid release field');
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

async function readManifest(response: Response) {
  if (response.status !== 200 || !response.body || Number(response.headers.get('Content-Length')) > manifestLimit) {
    throw new Error('Release unavailable');
  }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(manifestLimit);
  let offset = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (value.length > manifestLimit - offset) {
        await reader.cancel();
        throw new Error('Invalid release size');
      }
      buffer.set(value, offset);
      offset += value.length;
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder().decode(buffer.subarray(0, offset)));
}

export async function desktopDownload(path: string, publicKey = releaseKey): Promise<string | null> {
  const platform = platforms.get(path);
  if (!platform) return null;
  const response = await fetch(releaseOrigin + 'update.json', {
    redirect: 'manual', signal: AbortSignal.timeout(8000), cache: 'no-store',
  });
  const envelope = await readManifest(response);
  const key = await crypto.subtle.importKey('spki', decode(publicKey, 256), {name:'Ed25519'}, false, ['verify']);
  const payload = decode(envelope.payload, manifestLimit);
  const signature = decode(envelope.signature, 128);
  if (!await crypto.subtle.verify('Ed25519', key, signature, payload)) throw new Error('Invalid release signature');
  const manifest = JSON.parse(new TextDecoder().decode(payload));
  if (manifest.schema !== 1 || typeof manifest.version !== 'string' ||
      !/^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?:-beta\.(?:0|[1-9]\d{0,5}))?$/.test(manifest.version)) throw new Error('Invalid release version');
  const file = manifest.files?.[platform[0]];
  const name = 'Veyro-Mail-' + manifest.version + '-' + platform[1];
  if (file?.name !== name || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 512 * 1024 * 1024 ||
      !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('Invalid installer');
  return releaseOrigin + name;
}
