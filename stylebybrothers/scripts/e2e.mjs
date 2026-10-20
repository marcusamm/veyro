// Gennemklik af demoen i Chromium: booking fra start til slut, flyt, aflys, admin og galleri.
// Brug: node stylebybrothers/scripts/e2e.mjs [url] [skærmbilledmappe]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:8787/';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const errors = [];
let step = 0;
const ok = (msg) => console.log(`✓ ${++step}. ${msg}`);

async function run(name, viewport, isMobile) {
  const ctx = await browser.newContext({ viewport, isMobile, hasTouch: isMobile, deviceScaleFactor: isMobile ? 2 : 1, locale: 'da-DK', timezoneId: 'Europe/Copenhagen' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(`${name} console: ${m.text()}`); });
  const shot = async (file, full = false) => { if (shots) { await page.waitForTimeout(700); await page.screenshot({ path: `${shots}/${file}-${name}.png`, fullPage: full }); } };

  await page.goto(url);
  await page.waitForSelector('.hero h1');
  await page.waitForTimeout(1200);
  await shot('forside');
  // rul igennem, så alle reveal-animationer er synlige på helsidebilledet
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); });
  await shot('forside-hel', true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) errors.push(`${name}: vandret scroll på forsiden (${overflow}px)`);
  ok(`${name}: forside`);

  // galleri + lightbox
  await page.locator('#galleri').scrollIntoViewIfNeeded();
  await page.click('.chip[data-cat="fades"]');
  const visible = await page.locator('.g-item:not(.hide)').count();
  if (visible !== 2) errors.push(`${name}: forventede 2 fades, fik ${visible}`);
  await page.click('.chip[data-cat="alle"]');
  await shot('galleri');
  await page.locator('.g-item').first().click();
  await page.waitForSelector('.lightbox.open');
  await page.click('[data-lb="next"]');
  await shot('lightbox');
  await page.click('[data-lb="close"]');
  ok(`${name}: galleri og lightbox`);

  // booking fra behandlingskort (behandling forudvalgt)
  await page.locator('#behandlinger').scrollIntoViewIfNeeded();
  await shot('behandlinger');
  await page.click('a[href="#/booking?behandling=skin-fade"]');
  await page.waitForSelector('[data-act="pick-barber"]');
  if (!(await page.locator('.steps li.current b').textContent()).includes('02')) errors.push(`${name}: behandling blev ikke forudvalgt`);
  await shot('booking-barber');
  await page.click('[data-act="pick-barber"][data-id="any"]');
  await page.waitForSelector('.cal');
  await page.waitForSelector('.time');
  await page.locator('.time').nth(2).click();
  await shot('booking-tid', true);
  await page.click('main [data-act="step"][data-step="4"]');
  await page.waitForSelector('#customer-form');
  await page.click('#customer-form button[type="submit"]');
  await page.waitForSelector('.field.invalid');
  await page.fill('#f-name', 'Demo Kunde');
  await page.fill('#f-phone', '12 34 56 78');
  await page.fill('#f-email', 'demo@example.com');
  await page.fill('#f-note', 'Kort i siderne');
  await shot('booking-oplysninger', true);
  await page.click('#customer-form button[type="submit"]');
  await page.waitForSelector('.receipt');
  const ref = (await page.locator('.ref b').textContent()).trim();
  await shot('booking-bekraeftet', true);
  ok(`${name}: booking ${ref}`);

  // samme tid må ikke kunne bookes igen af samme barber: tjek i admin senere. Flyt + aflys:
  await page.click('a[href^="#/min-booking"]');
  await page.waitForSelector('#find-form');
  await page.fill('#m-phone', '12345678');
  await page.click('#find-form button[type="submit"]');
  await page.waitForSelector('[data-act="mb-move"]');
  await page.click('[data-act="mb-move"]');
  await page.locator('.time').first().click();
  await page.click('[data-act="mb-save"]');
  await page.waitForSelector('.notice.ok');
  await shot('min-booking', true);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-act="mb-cancel"]');
  await page.waitForSelector('.tag.off');
  ok(`${name}: flyt og aflys`);

  // admin
  await page.goto(`${url}#/admin`);
  await page.click('[data-act="admin-login"]');
  await page.waitForSelector('.admin-tabs');
  await page.click('[data-act="seed"]');
  await page.click('[data-act="admin-day"][data-dir="1"]');
  await shot('admin-bookinger', true);
  await page.click('a[href="#/admin/behandlinger"]');
  const price = page.locator('input[data-path="services:herreklip:price"]');
  await price.fill('275');
  await price.dispatchEvent('change');
  await shot('admin-behandlinger');
  await page.click('a[href="#/admin/barberer"]');
  await shot('admin-barberer');
  await page.click('a[href="#/admin/regler"]');
  await page.waitForSelector('#closed-date');
  await page.click('a[href="#/admin/galleri"]');
  await shot('admin-galleri');
  await page.click('a[href="#/admin/beskeder"]');
  await page.waitForSelector('.outbox-item');
  const msgs = await page.locator('.outbox-item').count();
  if (msgs < 4) errors.push(`${name}: forventede mindst 4 simulerede udsendelser, fik ${msgs}`);
  await page.goto(`${url}#/`);
  await page.waitForSelector('.service');
  if (!(await page.locator('#behandlinger').textContent()).includes('275')) errors.push(`${name}: ny pris vises ikke på siden`);
  ok(`${name}: admin`);

  if (isMobile) {
    await page.click('.menu-btn');
    await page.waitForSelector('.mobile-menu.open');
    await page.waitForTimeout(600);
    await shot('menu');
    await page.click('.mobile-menu [data-act="close-menu"].close-btn');
    ok(`${name}: mobilmenu`);
  }
  await ctx.close();
}

await run('mobil', { width: 390, height: 844 }, true);
await run('desktop', { width: 1440, height: 900 }, false);
await browser.close();
if (errors.length) { console.error('FEJL:\n' + errors.join('\n')); process.exit(1); }
console.log('Alt virker.');
