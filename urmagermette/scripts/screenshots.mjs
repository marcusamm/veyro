#!/usr/bin/env node
// Gennemtester de vigtigste forløb i en rigtig browser og tager skærmbilleder.
// Brug: BASE=http://127.0.0.1:8787 ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/screenshots.mjs [udmappe]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const UD = process.argv[2] || 'skaermbilleder';
const EMAIL = process.env.ADMIN_EMAIL || 'demo@urmagermette.dk';
const PW = process.env.ADMIN_PASSWORD || '';
mkdirSync(UD, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const problemer = [];
const ok = [];
function tjek(betingelse, tekst) {
  (betingelse ? ok : problemer).push(tekst);
  console.log(`${betingelse ? '✓' : '✗'} ${tekst}`);
}

async function side(viewport, navn) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1, locale: 'da-DK', timezoneId: 'Europe/Copenhagen' });
  const p = await ctx.newPage();
  p.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_TUNNEL|ERR_PROXY|cloudflareinsights|502/.test(m.text()) && !/Failed to load resource.*(401|409)/.test(m.text()) && !(p.url().includes('findes-ikke') && /404/.test(m.text()))) problemer.push(`[${navn}] konsolfejl: ${m.text().slice(0, 300)}`);
  });
  // Forsøg igen ved midlertidige netværksfejl
  const goto = p.goto.bind(p);
  p.goto = async (url, opts) => {
    for (let i = 0; ; i++) {
      try {
        return await goto(url, opts);
      } catch (e) {
        if (i >= 3) throw e;
        await p.waitForTimeout(1500);
      }
    }
  };
  p.on('pageerror', (e) => problemer.push(`[${navn}] sidefejl: ${e.message.slice(0, 300)}`));
  return { ctx, p };
}

async function rulOgFoto(p, fil, fuld = true) {
  // Rul ned gennem siden, så alle animationer udløses, før der fotograferes
  await p.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await p.waitForTimeout(1100);
  await p.screenshot({ path: join(UD, fil), fullPage: fuld });
}

const SIDER = [['/', 'forside'], ['/ydelser', 'ydelser'], ['/saadan-foregaar-det', 'saadan'], ['/om', 'om'], ['/faq', 'faq'], ['/kontakt', 'kontakt'], ['/bestil', 'bestil-trin1'], ['/findes-ikke', '404']];

// 1. Offentlige sider på computer, tablet og mobil
for (const [vp, navn] of [[{ width: 1440, height: 900 }, 'desktop'], [{ width: 820, height: 1180 }, 'tablet'], [{ width: 390, height: 844 }, 'mobil']]) {
  const { ctx, p } = await side(vp, navn);
  for (const [sti, fil] of SIDER) {
    if (navn === 'tablet' && !['forside', 'bestil-trin1'].includes(fil)) continue;
    const res = await p.goto(BASE + sti, { waitUntil: 'networkidle' });
    tjek(res.status() === (fil === '404' ? 404 : 200), `${navn}: ${sti} svarer ${res.status()}`);
    const bredde = await p.evaluate(() => document.documentElement.scrollWidth);
    tjek(bredde <= vp.width, `${navn}: ${sti} har ingen vandret rulning (${bredde}px)`);
    await rulOgFoto(p, `${fil}-${navn}.png`);
  }
  if (navn === 'mobil') {
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Åbn menu' }).click();
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(UD, `menu-mobil.png`) });
    tjek(await p.getByRole('link', { name: 'Bestil tid' }).first().isVisible(), 'mobil: fast "Bestil tid"-knap er synlig');
  }
  await ctx.close();
}

// 2. Bookingflowet på mobil
let token = '';
let valgtDato = '';
let valgtTid = '';
{
  const { ctx, p } = await side({ width: 390, height: 844 }, 'booking');
  await p.goto(BASE + '/bestil', { waitUntil: 'networkidle' });
  await p.getByRole('radio', { name: /Bornholmerur/ }).click();
  await p.waitForSelector('[aria-label*="ledige tider"]:not([disabled])');
  await rulOgFoto(p, 'bestil-trin2-mobil.png');
  const dag = p.locator('button[aria-label*="ledige tider"]:not([disabled])').first();
  valgtDato = (await dag.getAttribute('aria-label')) ?? '';
  await dag.click();
  const tid = p.locator('button[aria-pressed]').filter({ hasText: /^\d\d\.\d\d$/ }).first();
  valgtTid = (await tid.textContent()) ?? '';
  await tid.click();
  await p.screenshot({ path: join(UD, 'bestil-trin2-valgt-mobil.png'), fullPage: true });
  await p.getByRole('button', { name: /Fortsæt med/ }).click();
  // Prøv at gå videre uden at udfylde: fejlbeskeder
  await p.getByRole('button', { name: 'Se oversigt' }).click();
  tjek(await p.getByText('Skriv dit fulde navn.').isVisible(), 'booking: tomme felter giver tydelige fejlbeskeder');
  await rulOgFoto(p, 'bestil-trin3-fejl-mobil.png');
  await p.fill('#b-navn', 'Test Testesen');
  await p.fill('#b-telefon', '12 34 56 78');
  await p.fill('#b-email', 'test@example.com');
  await p.fill('#b-maerke', 'Ukendt, ca. 1900');
  await p.getByRole('button', { name: '+ Uret er stoppet' }).click();
  // Valgfrit billede: et lille genereret PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQ0lEQVR42u3PMQ0AAAgDsM2/aFCAB5KmNdC+Xr4dCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAh8NQLV1AWBHzqRaQAAAABJRU5ErkJggg==', 'base64');
  await p.setInputFiles('input[type=file]', { name: 'ur.png', mimeType: 'image/png', buffer: png });
  await p.waitForSelector('img[alt="Dit valgte billede"]');
  await rulOgFoto(p, 'bestil-trin3-mobil.png');
  await p.getByRole('button', { name: 'Se oversigt' }).click();
  await p.getByRole('button', { name: /Send anmodning/ }).click();
  tjek(await p.getByText('Du skal acceptere').isVisible(), 'booking: samtykke kræves');
  await p.getByRole('checkbox').check();
  await rulOgFoto(p, 'bestil-trin4-mobil.png');
  await p.waitForTimeout(3000);
  await p.getByRole('button', { name: /Send anmodning/ }).click();
  await p.waitForSelector('text=Din anmodning er modtaget');
  tjek(await p.getByText('Afventer godkendelse').first().isVisible(), 'booking: kvittering viser "Afventer godkendelse"');
  token = (await p.inputValue('input[aria-label="Link til din booking"]')).split('/booking/')[1] ?? '';
  tjek(token.length > 20, 'booking: kvitteringen har et personligt link');
  await rulOgFoto(p, 'bestil-kvittering-mobil.png');
  await ctx.close();
}

// 3. Serveren afviser dobbeltbooking af samme tid
{
  const r = await fetch(`${BASE}/api/booking/${token}`);
  const b = await r.json();
  const fd = new FormData();
  Object.entries({ navn: 'Anden Kunde', telefon: '87654321', email: 'anden@example.com', urtype: 'Armbåndsur', maerke: '', beskrivelse: 'Test af dobbeltbooking', ydelse: 'bornholmerur', dato: b.dato, start: String(b.start), samtykke: 'ja', firma: '', startet: String(Date.now() - 10000) }).forEach(([k, v]) => fd.set(k, v));
  const res = await fetch(`${BASE}/api/bookinger`, { method: 'POST', body: fd });
  tjek(res.status === 409, `server: dobbeltbooking afvises (status ${res.status})`);
  const spam = new FormData();
  fd.forEach((v, k) => spam.set(k, v));
  spam.set('firma', 'Spam ApS');
  tjek((await fetch(`${BASE}/api/bookinger`, { method: 'POST', body: spam })).status === 400, 'server: spamrobot (honeypot) afvises');
  tjek((await fetch(`${BASE}/api/admin/bookinger`)).status === 401, 'server: admin-API kræver login');
}

// 4. Kontaktformular
{
  const { ctx, p } = await side({ width: 1440, height: 900 }, 'kontakt');
  await p.goto(BASE + '/kontakt', { waitUntil: 'networkidle' });
  await p.fill('#k-navn', 'Test Testesen');
  await p.fill('#k-email', 'test@example.com');
  await p.fill('#k-besked', 'Reparerer I også gøgeure?');
  await p.getByRole('checkbox').check();
  await p.waitForTimeout(3000);
  await p.getByRole('button', { name: 'Send besked' }).click();
  await p.waitForSelector('text=Tak for din besked');
  tjek(true, 'kontakt: beskeden gemmes');
  await p.getByRole('button', { name: 'Vis interaktivt kort' }).isVisible();
  await ctx.close();
}

// 5. Administration på computer og mobil
for (const [vp, navn] of [[{ width: 1440, height: 900 }, 'desktop'], [{ width: 390, height: 844 }, 'mobil']]) {
  const { ctx, p } = await side(vp, `admin-${navn}`);
  await p.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  await p.screenshot({ path: join(UD, `admin-login-${navn}.png`) });
  await p.fill('#l-email', EMAIL);
  await p.fill('#l-pw', 'forkert-kode');
  await p.getByRole('button', { name: 'Log ind' }).click();
  tjek(await p.getByText('Forkert e-mail eller adgangskode.').waitFor({ timeout: 5000 }).then(() => true, () => false), `admin ${navn}: forkert adgangskode afvises`);
  await p.fill('#l-pw', PW);
  await p.getByRole('button', { name: 'Log ind' }).click();
  await p.waitForSelector('text=Goddag, Mette');
  await p.waitForTimeout(600);
  await p.screenshot({ path: join(UD, `admin-oversigt-${navn}.png`), fullPage: true });
  for (const [sti, fil] of [['/admin/kalender', 'kalender'], ['/admin/bookinger', 'bookinger'], ['/admin/beskeder', 'beskeder'], ['/admin/indstillinger', 'indstillinger'], ['/admin/data', 'data']]) {
    await p.goto(BASE + sti, { waitUntil: 'networkidle' });
    await p.waitForTimeout(500);
    const bredde = await p.evaluate(() => document.documentElement.scrollWidth);
    tjek(bredde <= vp.width, `admin ${navn}: ${sti} har ingen vandret rulning (${bredde}px)`);
    await p.screenshot({ path: join(UD, `admin-${fil}-${navn}.png`), fullPage: true });
  }
  if (navn === 'desktop') {
    await p.goto(BASE + '/admin/kalender', { waitUntil: 'networkidle' });
    for (const t of ['Dag', 'Måned']) {
      await p.getByRole('tab', { name: t }).click();
      await p.waitForTimeout(500);
      await p.screenshot({ path: join(UD, `admin-kalender-${t.toLowerCase()}-desktop.png`), fullPage: true });
    }
    // Godkend testbookingen
    await p.goto(BASE + '/admin/bookinger', { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: /Test Testesen/ }).first().click();
    await p.waitForSelector('text=Interne noter');
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(UD, 'admin-booking-desktop.png') });
    await p.fill('input[aria-label="Ny note"]', 'Kunden kommer med lodder og pendul.');
    await p.getByRole('button', { name: 'Gem', exact: true }).click();
    await p.waitForSelector('text=Kunden kommer med lodder og pendul.');
    await p.getByRole('button', { name: /Godkend/ }).click();
    await p.waitForSelector('text=Tiden er godkendt');
    tjek(true, 'admin: anmodning godkendt og note gemt');
    await p.screenshot({ path: join(UD, 'admin-booking-godkendt-desktop.png') });
    const status = await (await fetch(`${BASE}/api/booking/${token}`)).json();
    tjek(status.status === 'bekraeftet', 'kunde: status er nu "Bekræftet"');
    // E-mailen ligger i udbakken som "ikke sendt"
    await p.goto(BASE + '/admin/data', { waitUntil: 'networkidle' });
    tjek(await p.getByText('Din tid er bekræftet').first().isVisible(), 'admin: bekræftelsesmail ligger i udbakken (ikke sendt i demo)');
  } else {
    await p.goto(BASE + '/admin/bookinger', { waitUntil: 'networkidle' });
    await p.getByRole('tab', { name: 'Kommende' }).click();
    await p.waitForTimeout(400);
    await p.locator('ul button').first().click();
    await p.waitForSelector('text=Interne noter');
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(UD, 'admin-booking-mobil.png') });
  }
  await ctx.close();
}

// 6. Kunden ser bekræftelsen og afbestiller
{
  const { ctx, p } = await side({ width: 390, height: 844 }, 'status');
  await p.goto(`${BASE}/booking/${token}`, { waitUntil: 'networkidle' });
  tjek(await p.getByText('Din tid er bekræftet').isVisible(), 'kunde: statussiden viser bekræftet tid');
  await rulOgFoto(p, 'booking-status-mobil.png');
  await p.getByRole('button', { name: 'Afbestil tiden' }).click();
  await p.getByRole('button', { name: 'Ja, afbestil' }).click();
  await p.waitForSelector('text=Tiden er aflyst.');
  tjek(true, 'kunde: kan afbestille via linket');
  await ctx.close();
}

await browser.close();
writeFileSync(join(UD, 'resultat.json'), JSON.stringify({ ok, problemer, valgtDato, valgtTid }, null, 2));
console.log(`\n${ok.length} ok, ${problemer.length} problemer`);
for (const p of problemer) console.log('  - ' + p);
process.exit(problemer.length ? 1 : 0);
