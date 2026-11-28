import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import gateway from './worker.ts';

it('serves the public download page and maps its three buttons to the checked release files', async () => {
  const html = readFileSync(new URL('./assets/download.html', import.meta.url), 'utf8');
  const manifest = readFileSync(new URL('./origin/SHA256SUMS-0.1.0-beta.1.txt', import.meta.url), 'utf8');
  const files = new Set(manifest.trim().split('\n').map(line => line.trim().split(/\s+/)[1]));
  const assets = vi.fn(async req => new Response(new URL(req.url).pathname === '/download.html' ? html : '', {status:200}));
  const serve = (path, method = 'GET') => gateway.fetch(new Request('https://mail.veyro.dk' + path, {method}), {WEBMAIL_ENABLED:'1', ASSETS:{fetch:assets}});
  const page = await serve('/download');
  expect(page.status).toBe(200);
  const links = [...(await page.text()).matchAll(/href="(\/download\/[^"]+)"/g)].map(match => match[1]);
  expect(links.sort()).toEqual(['/download/mac-apple', '/download/mac-intel', '/download/windows']);
  const seen = new Set();
  for (const link of links) {
    for (const method of ['GET', 'HEAD']) {
      const result = await serve(link, method);
      expect(result.status).toBe(302);
      const target = new URL(result.headers.get('Location'));
      expect(target.origin).toBe('https://post.veyro.dk');
      expect(target.pathname).toMatch(/^\/webmail-downloads\/Veyro-Mail-[a-z0-9.-]+$/i);
      seen.add(target.pathname.split('/').pop());
    }
    expect((await serve(link, 'POST')).status).toBe(405);
  }
  expect(seen).toEqual(files);
  expect((await serve('/download/unknown')).status).toBe(404);
});
