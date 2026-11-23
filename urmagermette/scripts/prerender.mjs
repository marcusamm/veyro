#!/usr/bin/env node
// Skriver de offentlige sider som statisk HTML i dist/ ud fra den byggede app.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROD = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROD, 'dist');
const BASE = (process.env.SITE_URL || 'https://urmagermette.veyro.dk').replace(/\/$/, '');
const skabelon = readFileSync(join(DIST, 'index.html'), 'utf8');
const { render, OFFENTLIGE_SIDER } = await import(pathToFileURL(join(ROD, 'build-ssr', 'entry-server.js')).href);

for (const url of [...OFFENTLIGE_SIDER, '/404']) {
  const { html, head } = render(url, BASE);
  const side = skabelon.replace('<!--head-->', head).replace('<!--app-->', html);
  const fil = url === '/' ? join(DIST, 'index.html') : url === '/404' ? join(DIST, '404.html') : join(DIST, `${url.slice(1)}.html`);
  mkdirSync(dirname(fil), { recursive: true });
  writeFileSync(fil, side);
  console.log(`Forudrenderet ${url}`);
}
// App-skal til admin og kundens bookingside (renderes kun i browseren)
writeFileSync(
  join(DIST, 'app.html'),
  skabelon.replace('<!--head-->', '<title>UrmagerMette</title>\n    <meta name="robots" content="noindex, nofollow" />').replace('<!--app-->', ''),
);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${OFFENTLIGE_SIDER.map((u) => `  <url><loc>${BASE}${u}</loc></url>`).join('\n')}\n</urlset>\n`;
writeFileSync(join(DIST, 'sitemap.xml'), sitemap);
rmSync(join(ROD, 'build-ssr'), { recursive: true, force: true });
