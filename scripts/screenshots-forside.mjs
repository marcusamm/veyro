// Skærmbilleder og enkle målinger af forsiden (mobil 390, tablet 820, desktop 1440) mod en lokal
// `wrangler dev --local`. Målingerne er lokale og kun til sammenligning før og efter en ændring.
//   OUT=/sti/til/mappe node scripts/screenshots-forside.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { ROOT, startStack } from '../tests/harness.mjs';

const OUT = process.env.OUT ?? path.join(ROOT, 'screenshots', 'forside');
const PATHS = (process.env.PATHS ?? '/').split(',');
mkdirSync(OUT, { recursive: true });

const stack = await startStack({ minMonths: 0 });
const results = {};
try {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? undefined });
  // Overførte bytes (ukomprimeret og gzip) for forsidens HTML, CSS og JS
  const bytes = {};
  for (const p of PATHS) {
    const html = await (await fetch(stack.site + p)).text();
    const assets = [...html.matchAll(/(?:href|src)="(\/\/localhost:\d+\/assets\/[^"]+\.(?:css|js)[^"]*)"/g)].map((m) => 'http:' + m[1]);
    bytes[p] = { html: [html.length, gzipSync(html).length] };
    for (const a of assets) {
      const body = Buffer.from(await (await fetch(a)).arrayBuffer());
      bytes[p][a.split('/assets/')[1].split('?')[0]] = [body.length, gzipSync(body).length];
    }
  }
  results.bytes = bytes;
  results.views = {};
  for (const [label, width, height, scale] of [['mobil', 390, 844, 2], ['tablet', 820, 1180, 2], ['desktop', 1440, 900, 1]]) {
    for (const p of PATHS) {
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        // Cookiebanneret dækker ellers en del af skærmbilledet
        localStorage.setItem('theme-cookie-consent', JSON.stringify({ v: 1, t: Date.now(), consent: { analytics: false, marketing: false } }));
        window.__m = { lcp: 0, cls: 0 };
        new PerformanceObserver((l) => l.getEntries().forEach((e) => (window.__m.lcp = e.startTime))).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((l) => l.getEntries().forEach((e) => !e.hadRecentInput && (window.__m.cls += e.value))).observe({ type: 'layout-shift', buffered: true });
      });
      await page.goto(stack.site + p, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const above = await page.screenshot({ path: path.join(OUT, `${label}-forside-top.png`) });
      // Rul hele siden igennem, så animationer udløses, og mål til sidst
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 400) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(OUT, `${label}-forside.png`), fullPage: true });
      const m = await page.evaluate(() => ({
        lcp: Math.round(window.__m.lcp),
        cls: Number(window.__m.cls.toFixed(4)),
        domNodes: document.getElementsByTagName('*').length,
        height: document.documentElement.scrollHeight,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        sections: document.querySelectorAll('main > *').length,
      }));
      results.views[`${label}${p}`] = m;
      console.log(label, p, JSON.stringify(m), above.length ? '' : '');
      await ctx.close();
    }
  }
  await browser.close();
} finally {
  await stack.stop();
}
writeFileSync(path.join(OUT, 'maalinger.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.bytes, null, 1));
