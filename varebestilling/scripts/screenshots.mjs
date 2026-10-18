// Tager skærmbilleder af de vigtigste sider (desktop 1280 og mobil 390) mod en lokal
// `wrangler dev --local` med eksempeldata. Kræver Chromium til Playwright.
//   PLAYWRIGHT_BROWSERS_PATH=/sti/til/browsere npm run screenshots
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { Client, ROOT, csrfFrom, importCsv, login, placeOrder, startStack } from '../tests/harness.mjs';

const OUT = path.join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });

const stack = await startStack();
try {
  const admin = await login(stack);
  await admin.submit('/admin/indstillinger', '/admin/indstillinger', {
    shop_name: 'Ristet & Co.',
    tagline: 'Bestil kaffe, te og tilbehør',
    intro: 'Bestil inden kl. 12, så er din ordre klar til afhentning samme dag.\nVi leverer i hele Aarhus.',
    accent_color: '#0E7C66',
    website_url: 'https://example.dk',
    contact_email: 'hej@example.dk',
    contact_phone: '86 12 34 56',
    address: 'Mejlgade 10, 8000 Aarhus C',
    pickup_enabled: '1',
    pickup_info: 'Du får en e-mail, når din bestilling er klar.',
    delivery_enabled: '1',
    delivery_info: 'Levering inden for 1-2 hverdage.',
    delivery_fee: '49',
    free_delivery_from: '500',
    min_order: '0',
    low_stock_default: '5',
    terms_url: 'https://example.dk/handelsbetingelser',
    privacy_url: 'https://example.dk/privatliv',
    notify_email: '',
  });
  const csv = readFileSync(path.join(ROOT, 'eksempel', 'vareliste-eksempel.csv'), 'utf8');
  await importCsv(admin, csv);
  const id = (sku) => stack.sql(`SELECT id FROM products WHERE sku = '${sku}'`)[0].id;

  const orders = [
    [[[id('KAF-100'), 2], [id('TIL-300'), 1]], { customer_name: 'Mette Larsen', company: 'Café Solsikke' }],
    [[[id('TE-200'), 1], [id('TIL-301'), 1]], { customer_name: 'Jonas Holm', delivery: 'levering', address: 'Nørregade 4', postcode: '8000', city: 'Aarhus C' }],
    [[[id('SRV-900'), 1]], { customer_name: 'Sara Nielsen' }],
    [[[id('KAF-100'), 4]], { customer_name: 'Kontorhuset ApS', company: 'Kontorhuset ApS', delivery: 'levering', address: 'Havnegade 20', postcode: '8000', city: 'Aarhus C', note: 'Leveres til receptionen' }],
  ];
  const ids = [];
  for (const [items, details] of orders) {
    const { res } = await placeOrder(stack, items, { accept: '1', ...details });
    const token = res.headers.get('location').match(/\/ordre\/([A-Za-z0-9_-]+)/)[1];
    ids.push(stack.sql(`SELECT id, token FROM orders WHERE token = '${token}'`)[0]);
  }
  const setStatus = (oid, status) => admin.submit(`/admin/ordrer/${oid}`, `/admin/ordrer/${oid}/status`, { status });
  await setStatus(ids[0].id, 'bekraeftet');
  await setStatus(ids[0].id, 'klar');
  await setStatus(ids[1].id, 'bekraeftet');
  await setStatus(ids[2].id, 'bekraeftet');
  await setStatus(ids[2].id, 'afsluttet');

  // En kunde med varer i kurven
  const shopper = new Client(stack.base);
  await shopper.submit('/', '/kurv', { id: String(id('KAF-100')), qty: '2', back: '/' });
  await shopper.submit('/', '/kurv', { id: String(id('TE-201')), qty: '1', back: '/' });

  const browser = await chromium.launch();
  const host = new URL(stack.base).hostname;
  const toCookies = (c) => [...c.cookies].map(([name, value]) => ({ name, value, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }));
  const shots = [
    { name: 'webshop', url: '/', who: shopper },
    { name: 'kurv', url: '/kurv', who: shopper },
    { name: 'kassen', url: '/kassen', who: shopper },
    { name: 'kvittering', url: `/ordre/${ids[0].token}?ny=1`, who: null },
    { name: 'admin-oversigt', url: '/admin', who: admin },
    { name: 'admin-ordrer', url: '/admin/ordrer', who: admin },
    { name: 'admin-ordre', url: `/admin/ordrer/${ids[3].id}`, who: admin },
    { name: 'admin-varer', url: '/admin/varer', who: admin },
    { name: 'admin-vare', url: `/admin/varer/${id('KAF-100')}`, who: admin },
    { name: 'admin-import', url: '/admin/import', who: admin },
    { name: 'admin-indstillinger', url: '/admin/indstillinger', who: admin },
  ];
  for (const [label, width] of [['desktop', 1280], ['mobil', 390]]) {
    for (const s of shots) {
      const ctx = await browser.newContext({ viewport: { width, height: label === 'mobil' ? 844 : 900 }, deviceScaleFactor: label === 'mobil' ? 2 : 1 });
      if (s.who) await ctx.addCookies(toCookies(s.who));
      const page = await ctx.newPage();
      await page.goto(stack.base + s.url, { waitUntil: 'networkidle' });
      const file = path.join(OUT, `${s.name}-${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log('Gemt:', path.relative(ROOT, file));
      await ctx.close();
    }
    // Forhåndsvisning af import (kræver en POST)
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: label === 'mobil' ? 2 : 1 });
    await ctx.addCookies(toCookies(admin));
    const page = await ctx.newPage();
    await page.goto(stack.base + '/admin/import');
    await page.locator('details summary').click();
    await page.fill('#text', 'Varenummer;Navn;Pris;Lager\nKAF-101;Espresso, mørk;95,00;40\nKAF-103;Koldbrygget kaffe;69,00;30\nTE-202;;45;10');
    await page.click('form[action="/admin/import"] button[type=submit]');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(OUT, `admin-import-preview-${label}.png`), fullPage: true });
    console.log('Gemt:', `screenshots/admin-import-preview-${label}.png`);
    await ctx.close();
  }
  await browser.close();
} finally {
  await stack.stop();
}
