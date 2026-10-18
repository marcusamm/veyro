// Tager skærmbilleder af de vigtigste sider (desktop 1280 og mobil 390) mod en lokal
// `wrangler dev --local` med demodata (se scripts/demo-data.mjs). Kræver Chromium til Playwright.
//   PLAYWRIGHT_BROWSERS_PATH=/sti/til/browsere npm run screenshots
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { Client, ROOT, login, startStack } from '../tests/harness.mjs';
import { demoSql } from './demo-data.mjs';

const OUT = path.join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });

const stack = await startStack();
try {
  const admin = await login(stack);
  const file = path.join(tmpdir(), `vb-demo-${process.pid}.sql`);
  writeFileSync(file, demoSql());
  stack.sqlFile(file);
  rmSync(file);
  const id = (sku) => stack.sql(`SELECT id FROM products WHERE sku = '${sku}'`)[0].id;
  const newest = stack.sql(`SELECT id, token FROM orders ORDER BY number DESC LIMIT 1`)[0];

  // En kunde med varer i kurven
  const shopper = new Client(stack.base);
  await shopper.submit('/', '/kurv', { id: String(id('VN-1001')), qty: '10', back: '/' });
  await shopper.submit('/', '/kurv', { id: String(id('VN-1022')), qty: '4', back: '/' });

  const browser = await chromium.launch();
  const host = new URL(stack.base).hostname;
  const toCookies = (c) => [...c.cookies].map(([name, value]) => ({ name, value, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }));
  const shots = [
    { name: 'webshop', url: '/', who: shopper },
    { name: 'kurv', url: '/kurv', who: shopper },
    { name: 'kassen', url: '/kassen', who: shopper },
    { name: 'kvittering', url: `/ordre/${newest.token}?ny=1`, who: null },
    { name: 'app', url: '/app', who: null },
    { name: 'admin-oversigt', url: '/admin', who: admin },
    { name: 'admin-ordrer', url: '/admin/ordrer', who: admin },
    { name: 'admin-ordre', url: `/admin/ordrer/${newest.id}`, who: admin },
    { name: 'admin-ny-ordre', url: '/admin/ordrer/ny', who: admin },
    { name: 'admin-genbestilling', url: '/admin/genbestilling', who: admin },
    { name: 'admin-varer', url: '/admin/varer', who: admin },
    { name: 'admin-vare', url: `/admin/varer/${id('VN-1014')}`, who: admin },
    { name: 'admin-indstillinger', url: '/admin/indstillinger', who: admin },
  ];
  for (const [label, width] of [['desktop', 1280], ['mobil', 390]]) {
    const opts = { viewport: { width, height: label === 'mobil' ? 844 : 900 }, deviceScaleFactor: label === 'mobil' ? 2 : 1 };
    for (const s of shots) {
      const ctx = await browser.newContext(opts);
      if (s.who) await ctx.addCookies(toCookies(s.who));
      const page = await ctx.newPage();
      await page.goto(stack.base + s.url, { waitUntil: 'networkidle' });
      const file = path.join(OUT, `${s.name}-${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log('Gemt:', path.relative(ROOT, file));
      await ctx.close();
    }
    // Bestillingsarket, mens kunden skriver antal (viser beløb og bundlinjen)
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await page.goto(stack.base + '/', { waitUntil: 'networkidle' });
    await page.focus(`#q-${id('VN-1001')}`);
    await page.keyboard.type('20');
    await page.keyboard.press('Enter');
    await page.keyboard.type('6');
    console.log('I alt efter indtastning:', await page.locator('[data-total]').textContent());
    await page.screenshot({ path: path.join(OUT, `webshop-indtastet-${label}.png`) });
    console.log('Gemt:', `screenshots/webshop-indtastet-${label}.png`);
    await ctx.close();
  }
  await browser.close();
} finally {
  await stack.stop();
}
