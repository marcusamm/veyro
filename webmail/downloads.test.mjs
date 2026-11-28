import {readFileSync} from 'node:fs';
import {generateKeyPairSync, sign} from 'node:crypto';
import {afterEach, expect, it, vi} from 'vitest';
import gateway from './worker.ts';
import {desktopDownload, releaseKey} from './desktop_downloads.ts';

const html = readFileSync(new URL('./assets/download.html', import.meta.url), 'utf8');
const version = '0.1.0-beta.7';
const suffixes = {'darwin-arm64':'mac-arm64.dmg','darwin-x64':'mac-x64.dmg','win32-x64':'win-x64.exe'};
const files = Object.fromEntries(Object.entries(suffixes).map(([platform, suffix]) => [
  platform, {name:'Veyro-Mail-' + version + '-' + suffix, size:421, sha256:'b'.repeat(64)}
]));
const origin = 'https://post.veyro.dk/webmail-downloads/';
const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const fixtureKey = publicKey.export({type:'spki', format:'der'}).toString('base64');
function envelope(manifest, override) {
  const bytes = Buffer.from(JSON.stringify(manifest));
  return {payload:bytes.toString('base64'),signature:sign(null,bytes,privateKey).toString('base64'),...override};
}
function feed(data) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
}
const serve = (path, method = 'GET') => gateway.fetch(new Request('https://mail.veyro.dk' + path, {method}), {
  WEBMAIL_ENABLED:'1', ASSETS:{fetch:async () => new Response(html)}
});
afterEach(() => vi.unstubAllGlobals());

it('uses the same signing key as the app and presents all three installer links', async () => {
  const pem = readFileSync(new URL('./desktop/assets/update-signing-key.pem', import.meta.url),'utf8');
  expect(pem.split('\n')[1]).toBe(releaseKey);
  const page = await serve('/download');
  const links = [...(await page.text()).matchAll(/href="(\/download\/[^"]+)"/g)].map(m => m[1]);
  expect(links.sort()).toEqual(['/download/mac-apple','/download/mac-intel','/download/windows']);
  feed(envelope({schema:1,version,files}));
  for (const [index,path] of links.entries()) {
    expect(await desktopDownload(path, fixtureKey)).toBe(origin + Object.values(files)[index].name);
    expect(fetch).toHaveBeenLastCalledWith(origin + 'update.json', expect.objectContaining({redirect:'manual'}));
    expect((await serve(path,'POST')).status).toBe(405);
    expect((await serve(path,'HEAD')).status).toBe(503); // Fixture key is not trusted in production.
  }
  expect((await serve('/download/unknown')).status).toBe(404);
});

it('rejects invalid signatures, oversized responses and signed external file paths', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.redirect('https://example.invalid/update.json', 302)));
  await expect(desktopDownload('/download/windows',fixtureKey)).rejects.toThrow();
  feed(envelope({schema:1,version,files}, {signature:Buffer.alloc(64).toString('base64')}));
  await expect(desktopDownload('/download/windows',fixtureKey)).rejects.toThrow();
  feed(envelope({schema:1,version,files:{'win32-x64':{...files['win32-x64'],name:'https://example.invalid/app.exe'}}}));
  await expect(desktopDownload('/download/windows',fixtureKey)).rejects.toThrow();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(' '.repeat(20*1024))));
  expect((await serve('/download/windows')).status).toBe(503);
});
