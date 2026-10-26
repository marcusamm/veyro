// Gennemklik i Chromium: booking fra start til slut, dobbeltbooking, flyt, aflys, admin og galleri.
// Brug: node stylebybrothers/scripts/e2e.mjs [url] [skærmbilledmappe]
// Lokalt (npx wrangler dev med DEV_LOGIN=1) testes admin også. Live springes admin-login over, fordi linket sendes på e-mail.
// Kundens e-mail er Resends testadresse, så der ikke sendes rigtige mails til kunder. Testbookinger aflyses til sidst.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:8788/';
const TEST_EMAIL = 'delivered@resend.dev';
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
  page.on('console', (m) => { if (m.type() === 'error' && !/404|401|409|ERR_TUNNEL/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  const shot = async (file, full = false) => { if (shots) { await page.waitForTimeout(700); await page.screenshot({ path: `${shots}/${file}-${name}.png`, fullPage: full }); } };

  await page.goto(url);
  await page.waitForSelector('.hero h1');
  await page.waitForTimeout(400);
  await shot('forside');
  await shot('forside-hel', true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) errors.push(`${name}: vandret scroll på forsiden (${overflow}px)`);
  ok(`${name}: forside`);

  // galleri
  await page.locator('#klipninger').scrollIntoViewIfNeeded();
  const pics = await page.locator('.g-item.has-img').count();
  if (pics !== 4) errors.push(`${name}: forventede 4 billeder i galleriet, fik ${pics}`);
  await shot('galleri');
  ok(`${name}: galleri`);

  // booking fra behandlingskort (behandling forudvalgt)
  await page.locator('#priser').scrollIntoViewIfNeeded();
  await shot('priser');
  await page.click('a[href="#/booking?behandling=herreklip"]');
  await page.waitForSelector('.cal');
  if (!(await page.locator('.step.current h2').textContent()).includes('Tidspunkt')) errors.push(`${name}: behandling blev ikke forudvalgt`);
  await shot('booking-kalender');
  await page.waitForSelector('.time');
  await page.locator('.time').nth(2).click();
  await shot('booking-tid', true);
  await page.click('#continue button');
  await page.waitForSelector('#customer-form');
  await page.click('#customer-form button[type="submit"]');
  await page.waitForSelector('.field.invalid');
  const phone = `99${String(Date.now()).slice(-6)}`;
  await page.fill('#f-name', 'Test Testesen');
  await page.fill('#f-phone', phone);
  await page.fill('#f-email', TEST_EMAIL);
  await page.fill('#f-note', 'Automatisk test, aflyses straks');
  await shot('booking-oplysninger', true);
  await page.click('#customer-form button[type="submit"]');
  await page.waitForSelector('.receipt');
  const ref = (await page.locator('.receipt .ref').textContent()).trim();
  await shot('booking-bekraeftet', true);
  ok(`${name}: booking ${ref}`);

  // Dobbeltbooking: to samtidige forsøg på samme ledige tid, så længe alle stole er optaget, må kun det ene lykkes pr. stol.
  const race = await page.evaluate(async (email) => {
    const st = await (await fetch('/api/state')).json();
    const { availableSlots, addDays, utcToZoned } = await import('./assets/booking-engine.js');
    let date = addDays(utcToZoned(Date.now()).date, 3), slot;
    for (let i = 0; i < 20 && !slot; i++, date = addDays(date, 1)) slot = availableSlots(st, { serviceId: 'herreklip', date, now: Date.now() }).find((s) => s.barberIds.length >= 1);
    const chairs = slot.barberIds.length;
    const body = (n) => JSON.stringify({ serviceId: 'herreklip', date, start: slot.start, customer: { name: `Test ${n}`, phone: `9800000${n}`, email } });
    const res = await Promise.all(Array.from({ length: chairs + 2 }, (_, n) => fetch('/api/bookings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(n) }).then(async (r) => ({ status: r.status, data: await r.json() }))));
    const made = res.filter((r) => r.status === 200).map((r) => r.data.booking);
    for (const b of made) await fetch('/api/bookings/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: b.ref, phone: b.phone }) });
    return { chairs, ok: made.length, taken: res.filter((r) => r.status === 409).length };
  }, TEST_EMAIL);
  if (race.ok !== race.chairs || race.taken !== 2) errors.push(`${name}: dobbeltbooking: ${JSON.stringify(race)}`);
  ok(`${name}: ingen dobbeltbooking (${race.ok} af ${race.ok + race.taken} samtidige lykkedes, ${race.chairs} stole)`);

  // Flyt + aflys:
  await page.click('main a[href^="#/min-booking"]');
  await page.waitForSelector('#find-form');
  await page.fill('#m-phone', phone);
  await page.click('#find-form button[type="submit"]');
  await page.waitForSelector('[data-act="mb-move"]');
  await page.click('[data-act="mb-move"]');
  await page.locator('.time').first().click();
  await page.click('[data-act="mb-save"]');
  await page.waitForSelector('.notice.ok');
  await shot('min-booking', true);
  await page.click('[data-act="mb-cancel"]');
  await page.click('.ask [data-ok]');
  await page.waitForSelector('text=Din tid er aflyst.');
  ok(`${name}: flyt og aflys`);

  // privatlivspolitik
  await page.goto(`${url}#/privatliv`);
  await page.waitForSelector('.legal h2');
  if (!(await page.locator('.site-footer').textContent()).includes('Veyro.dk')) errors.push(`${name}: Veyro.dk mangler i bunden`);
  ok(`${name}: privatlivspolitik og kreditering`);

  // admin (kun når serveren returnerer login-linket direkte, dvs. lokalt)
  await page.goto(`${url}#/admin`);
  await page.waitForSelector('#login-form');
  await page.fill('#l-email', 'marcus@veyro.dk');
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('.notice');
  const dev = page.locator('.notice a');
  if (await dev.count()) {
    await page.goto(new URL(await dev.getAttribute('href'), url).href);
    await page.waitForSelector('.week');
    await page.click('[data-act="new-start"]');
    await page.waitForSelector('#n-time');
    // Næste dag med ledige tider (i dag kan være slut).
    for (let i = 1; i < 10 && (await page.locator('#n-time option').count()) < 2; i++) {
      const d = new Date(Date.now() + i * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Copenhagen' });
      await page.fill('#n-date', d);
      await page.locator('#n-date').dispatchEvent('change');
      await page.waitForTimeout(200);
    }
    await page.fill('[data-new="name"]', 'Telefonkunde');
    await page.fill('[data-new="phone"]', '98765432');
    await page.selectOption('#n-time', { index: 1 });
    await page.click('[data-act="new-save"]');
    await page.waitForSelector('.bk h3:has-text("Telefonkunde")');
    await shot('admin-kalender', true);
    await page.click('a[href="#/admin/behandlinger"]');
    const price = page.locator('input[data-path="services:herreklip:price"]');
    await price.fill('275');
    await price.dispatchEvent('change');
    await page.waitForTimeout(900);
    await shot('admin-priser');
    await page.click('a[href="#/admin/frisoerer"]');
    await shot('admin-stole');
    await page.click('a[href="#/admin/regler"]');
    await page.waitForSelector('#closed-date');
    await page.click('a[href="#/admin/beskeder"]');
    await page.waitForSelector('.outbox-item');
    await shot('admin-mails');
    await page.goto(`${url}#/`);
    await page.reload();
    await page.waitForSelector('.price-list');
    if (!(await page.locator('#priser').textContent()).includes('275')) errors.push(`${name}: ny pris vises ikke på siden efter genindlæsning`);
    // sæt prisen tilbage
    await page.goto(`${url}#/admin/behandlinger`);
    const p2 = page.locator('input[data-path="services:herreklip:price"]');
    await p2.fill('250'); await p2.dispatchEvent('change'); await page.waitForTimeout(900);
    ok(`${name}: admin`);
  } else ok(`${name}: admin-login sender link på e-mail (springes over live)`);

  if (isMobile) {
    await page.goto(`${url}#/`);
    await page.waitForSelector('.menu-btn');
    await page.click('.menu-btn');
    await page.waitForSelector('#menu:not([hidden])');
    await shot('menu');
    await page.click('.menu-btn');
    ok(`${name}: mobilmenu`);
  }
  await ctx.close();
}

await run('mobil', { width: 390, height: 844 }, true);
await run('desktop', { width: 1440, height: 900 }, false);
await browser.close();
if (errors.length) { console.error('FEJL:\n' + errors.join('\n')); process.exit(1); }
console.log('Alt virker.');
