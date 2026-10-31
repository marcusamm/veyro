// Pakker hjemmesidens tema (site/theme) og standardindhold (site/content.json) ind i
// src/site/theme.generated.ts, så Workeren kan gengive veyro.dk uden byggetrin.
// Kør efter ændringer i site/: `npm run build:site`. Testene fejler, hvis filen er forældet.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const THEME = path.join(ROOT, 'site/theme');
const OUT = path.join(ROOT, 'src/site/theme.generated.ts');
const TYPES = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2', jpg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon' };

export function build() {
  const files = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else files[path.relative(THEME, full)] = full;
    }
  };
  walk(THEME);
  const text = {};
  const assets = {};
  const hash = createHash('sha256');
  for (const [rel, full] of Object.entries(files)) {
    const buf = fs.readFileSync(full);
    hash.update(rel).update(buf);
    if (rel.startsWith('assets/')) {
      const ext = rel.split('.').pop();
      const type = TYPES[ext];
      if (!type) throw new Error('Ukendt filtype: ' + rel);
      const isText = ['css', 'js', 'svg'].includes(ext);
      assets[rel.slice(7)] = { type, b64: !isText, data: isText ? buf.toString('utf8') : buf.toString('base64') };
    } else {
      text[rel] = buf.toString('utf8');
    }
  }
  const content = JSON.parse(fs.readFileSync(path.join(ROOT, 'site/content.json'), 'utf8'));
  hash.update(JSON.stringify(content));
  const translations = Object.fromEntries(['en', 'sv'].map((locale) => [locale, JSON.parse(fs.readFileSync(path.join(ROOT, `site/translations/${locale}.content.json`), 'utf8'))]));
  hash.update(JSON.stringify(translations));
  // Display exchange rates are part of the cached HTML as well as the theme text.
  hash.update(fs.readFileSync(path.join(ROOT, 'src/site/currency.ts')));
  const v = hash.digest('hex').slice(0, 12);
  return `// AUTOGENERERET af scripts/build-site.mjs – redigér site/theme og site/content.json i stedet.
/* eslint-disable */
export const THEME_VERSION = ${JSON.stringify(v)};
export const THEME_FILES: Record<string, string> = ${JSON.stringify(text)};
export const THEME_ASSETS: Record<string, { type: string; b64: boolean; data: string }> = ${JSON.stringify(assets)};
export const SITE_DEFAULTS = ${JSON.stringify(content)};
export const SITE_TRANSLATIONS = ${JSON.stringify(translations)};
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const out = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== out) {
      console.error('src/site/theme.generated.ts er forældet. Kør: npm run build:site');
      process.exit(1);
    }
    console.log('theme.generated.ts er opdateret');
  } else {
    fs.writeFileSync(OUT, out);
    console.log(`Skrev ${path.relative(ROOT, OUT)} (${(out.length / 1024).toFixed(0)} KB)`);
  }
}
