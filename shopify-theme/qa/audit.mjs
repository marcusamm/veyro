import { chromium } from 'playwright';
import fs from 'fs';
const BASE = process.argv[2] || 'http://localhost:8811';
const SHOTS = process.argv[3] || 'shots';
fs.mkdirSync(SHOTS, { recursive: true });
const paths = ['/', '/pages/ydelser', '/pages/website-optimering', '/pages/custom-losninger', '/pages/om-os', '/pages/kontakt', '/pages/cookiepolitik', '/findes-ikke'];
const known = new Set(paths.slice(0, 7).concat(['/pages/privatlivspolitik']));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const issues = [];
const anchorsByPath = {};
const links = [];
for (const [vw, vh, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobil']]) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  for (const p of paths) {
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') issues.push(`${tag} ${p} console: ${m.text()}`); });
    page.on('pageerror', (e) => issues.push(`${tag} ${p} pageerror: ${e.message}`));
    await page.goto(BASE + p, { waitUntil: 'networkidle' });
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); } window.scrollTo(0, 0); });
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((e) => e.classList.add('is-visible')));
    await page.waitForTimeout(900);
    const info = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
      const as = [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim().slice(0, 40) }));
      const sw = document.documentElement.scrollWidth, cw = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.right > cw + 1 && getComputedStyle(e).position !== 'fixed'; }).slice(0, 3).map((e) => e.tagName + '.' + e.className);
      const text = document.body.innerText;
      const ph = text.match(/\[[A-ZÆØÅ_ \/-]{3,}\]|TILPAS|Lorem|PLADSHOLDER|MISSING:|Liquid error/g);
      const h1 = document.querySelectorAll('h1').length;
      const imgsNoAlt = [...document.querySelectorAll('img:not([alt])')].length;
      const emptyLinks = as.filter((a) => !a.href || a.href === '#').length;
      return { ids, as, overflow: sw > cw ? `${sw}>${cw} ${wide.join(',')}` : null, ph, h1, imgsNoAlt, emptyLinks, title: document.title };
    });
    anchorsByPath[p] = new Set(info.ids);
    if (tag === 'desktop') links.push(...info.as.map((a) => ({ from: p, ...a })));
    if (info.overflow) issues.push(`${tag} ${p} vandret scroll ${info.overflow}`);
    if (info.ph) issues.push(`${tag} ${p} pladsholdertekst: ${[...new Set(info.ph)].join(', ')}`);
    if (info.h1 !== 1) issues.push(`${tag} ${p} antal h1: ${info.h1}`);
    if (info.emptyLinks) issues.push(`${tag} ${p} tomme links: ${info.emptyLinks}`);
    if (tag === 'desktop') console.log(p, '|', info.title);
    const name = (p === '/' ? 'forside' : p.split('/').pop()) + '-' + tag;
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
    await page.close();
  }
  await ctx.close();
}
for (const l of links) {
  const h = l.href;
  if (/^(mailto:|tel:|https?:)/.test(h)) { if (/^https?:/.test(h) && !h.includes('veyro.dk')) continue; if (/^https?:/.test(h)) { console.log('ekstern', h); } continue; }
  const u = new URL(h, BASE + l.from);
  if (!known.has(u.pathname)) { issues.push(`dødt link ${l.from} -> ${h} (${l.text})`); continue; }
  if (u.hash && anchorsByPath[u.pathname] && !anchorsByPath[u.pathname].has(decodeURIComponent(u.hash.slice(1)))) issues.push(`manglende anker ${l.from} -> ${h} (${l.text})`);
}
console.log([...new Set(issues)].join('\n') || 'Ingen fund');
await browser.close();
