#!/usr/bin/env node
// Kontrollerer en kundes publicerede lagerstyring (fx https://ek.veyro.dk) fra start til slut.
//
//   1. Login-siden: HTTPS, sikkerhedsheadere, firmanavn, logo og fejlbesked ved ugyldig e-mail
//   2. Alle hovedsider som ejer på desktop og mobil: svarer 200, ingen demotekst, ingen
//      JavaScript-fejl og ingen vandret scroll på mobil (skærmbilleder gemmes)
//   3. Et rigtigt forløb: opret job, fejlbesked ved manglende navn, registrér forbrug af én vare,
//      kontrollér at beholdningen falder i databasen og stadig vises efter genindlæsning
//   4. Oprydning: kontroljobbet, dets bevægelser og den midlertidige session fjernes, og
//      beholdningen sættes tilbage. Til sidst sammenlignes databasen med tilstanden før testen.
//
// Forbruget registreres kun på en vare, hvis lagerstatus ikke ændres af det (så der aldrig oprettes
// en lageradvarsel eller sendes en e-mail til kunden). Demoinstallationer afvises: de har demodata.
//
// Testen logger ind med en midlertidig session (1 time) for en eksisterende ejer, så der ikke
// sendes login-mails og ikke oprettes testkonti hos kunden.
//
// Kræver CLOUDFLARE_API_TOKEN og CLOUDFLARE_ACCOUNT_ID samt Chromium til Playwright.
//   node scripts/produktionstest.mjs einar-kornerup
// Valgfrit: KUNDE_DOMAENE (standard veyro.dk), PRODUKTIONSTEST_EMAIL (ejeren, der testes som;
// standard den sidste admin i kundefilen) og SKAERMBILLEDER (mappe, standard produktionstest/).
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { laesKunder } from './deploy-kunder.mjs';

const slug = process.argv[2];
if (!slug) throw new Error('Angiv kunden, fx: node scripts/produktionstest.mjs einar-kornerup');
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env;
if (!TOKEN || !ACCOUNT) throw new Error('CLOUDFLARE_API_TOKEN og CLOUDFLARE_ACCOUNT_ID skal være sat');

const kunde = laesKunder(undefined, process.env.KUNDE_DOMAENE || 'veyro.dk').find((k) => k.slug === slug);
const inst = kunde?.systemer.find((s) => s.system === 'lagerstyring');
if (!inst?.domaene) throw new Error(`${slug} har ingen lagerstyring med domæne`);
if (kunde.demo) throw new Error(`${slug} er en demoinstallation med demodata; produktionstesten er til rigtige kunder`);
const BASE = `https://${inst.domaene}`;
const EMAIL = (process.env.PRODUKTIONSTEST_EMAIL || inst.admins.at(-1)).toLowerCase();
const OUT = process.env.SKAERMBILLEDER || 'produktionstest';
mkdirSync(OUT, { recursive: true });

const K = 1000;
const now = () => Math.floor(Date.now() / 1000);
const fejl = [];
let antal = 0;
function tjek(ok, besked) {
  antal++;
  console.log(`${ok ? 'OK  ' : 'FEJL'} ${besked}`);
  if (!ok) fejl.push(besked);
  return ok;
}

// --- D1 via Cloudflares API --------------------------------------------------------------------
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database`;
async function cf(url, init) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
  const body = await res.json();
  if (!body.success) throw new Error(`Cloudflare API: ${JSON.stringify(body.errors)}`);
  return body.result;
}
const db = (await cf(`${API}?name=${encodeURIComponent(inst.navn)}`)).find((d) => d.name === inst.navn);
if (!db) throw new Error(`Databasen ${inst.navn} findes ikke`);
async function sql(query, params = []) {
  const [r] = await cf(`${API}/${db.uuid}/query`, { method: 'POST', body: JSON.stringify({ sql: query, params }) });
  return r.results;
}

const FINGERPRINT = `SELECT
  (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM movements) AS movements,
  (SELECT COUNT(*) FROM notices) AS notices, (SELECT COUNT(*) FROM purchase_lines) AS purchase_lines,
  (SELECT COUNT(*) FROM job_log) AS job_log, (SELECT COUNT(*) FROM users) AS users,
  (SELECT COALESCE(SUM(stock), 0) FROM products) AS stock, (SELECT COALESCE(SUM(reserved), 0) FROM products) AS reserved,
  (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM mails) AS mails,
  (SELECT COALESCE(SUM(alert_level), 0) FROM products) AS alert_levels`;

// Samme regler som lagerstyring/src/lib/stock.ts (stockPlan og LEVEL), så testen kan vælge en vare,
// hvis advarselsniveau ikke ændres af ét forbrug.
function stockLevel(p, available) {
  const round = (m) => (p.whole_units ? Math.ceil(m / K - 1e-9) * K : Math.ceil(m - 1e-9));
  const lead = p.lead_time_days ?? p.supplier_lead_time ?? null;
  let safety = null;
  if (p.safety_method === 'antal' && p.safety_qty !== null) safety = round(p.safety_qty);
  if (p.safety_method === 'dage' && p.buffer_days !== null && p.avg_daily_usage !== null) safety = round(p.avg_daily_usage * p.buffer_days);
  const rop = p.avg_daily_usage !== null && lead !== null && safety !== null ? round(p.avg_daily_usage * lead + safety) : null;
  if (available <= 0) return 3;
  if (rop === null || safety === null) return 0;
  if (available <= safety) return 2;
  if (available <= rop) return 1;
  return 0;
}

const owner = (await sql("SELECT email, name FROM users WHERE email = ? AND active = 1 AND role = 'ejer'", [EMAIL]))[0];
if (!owner) throw new Error(`${EMAIL} er ikke en aktiv ejer i ${inst.navn}`);

const foer = (await sql(FINGERPRINT))[0];
const start = now();
const raw = randomBytes(32).toString('base64url');
const idHash = createHash('sha256').update(raw).digest('hex');
await sql('INSERT INTO sessions (id_hash, email, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [
  idHash,
  EMAIL,
  randomBytes(24).toString('base64url'),
  start + 3600,
  start,
]);

const browser = await chromium.launch();
let jobId = null;
try {
  // --- 1. Login-siden uden login -----------------------------------------------------------------
  const res = await fetch(`${BASE}/`, { redirect: 'manual' });
  tjek(res.status === 302 || res.status === 303, `${BASE}/ sender til login uden session (${res.status})`);
  const login = await fetch(`${BASE}/login`);
  const loginHtml = await login.text();
  tjek(login.status === 200, `/login svarer 200 (${login.status})`);
  tjek(/max-age=\d+/.test(login.headers.get('strict-transport-security') ?? ''), 'HSTS er slået til');
  tjek(!!login.headers.get('content-security-policy'), 'Content-Security-Policy er sat');
  tjek(loginHtml.includes(kunde.navn), `login-siden viser "${kunde.navn}"`);
  tjek(!/Prøv demoen|demodata/i.test(loginHtml), 'login-siden har ingen demoknapper');
  if (kunde.udseende?.logoData) {
    const logo = await fetch(`${BASE}/logo`);
    tjek(logo.status === 200 && (logo.headers.get('content-type') ?? '').startsWith('image/'), `logoet vises (${logo.status})`);
  }
  const http = await fetch(`http://${inst.domaene}/login`, { redirect: 'manual' }).catch(() => null);
  tjek(!http || (http.status >= 300 && http.status < 400 && (http.headers.get('location') ?? '').startsWith('https://')), 'http:// sendes videre til https://');

  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobil', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: label === 'mobil' ? 2 : 1 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.fill('input[name="email"]', 'ikke-en-email');
    await page.evaluate(() => document.querySelectorAll('[required], [type=email]').forEach((el) => { el.removeAttribute('required'); el.setAttribute('type', 'text'); }));
    await page.click('form[action="/login"] button[type="submit"]');
    await page.waitForLoadState('networkidle');
    tjek((await page.locator('.alert-err').count()) > 0, `${label}: ugyldig e-mail giver en fejlbesked`);
    await page.screenshot({ path: join(OUT, `login-fejl-${label}.png`), fullPage: true });
    await ctx.close();
  }

  // --- 2. Hovedsider som ejer ------------------------------------------------------------------
  const pid = (await sql('SELECT id FROM products WHERE active = 1 ORDER BY id LIMIT 1'))[0]?.id;
  const sider = [
    ['lager', '/lager'],
    ['varer', '/lager/varer'],
    ...(pid ? [['vare', `/lager/varer/${pid}`]] : []),
    ['indkob', '/lager/indkob'],
    ['priser', '/lager/priser'],
    ['modtagelse', '/lager/modtagelse'],
    ['indstillinger', '/lager/indstillinger'],
    ['job', '/job?vis=alle'],
    ['job-ny', '/job/ny'],
    ['fakturaer', '/job/faktura'],
    ['job-lager', '/job/lager'],
  ];
  const cookie = { name: '__Host-ls_session', value: raw, domain: inst.domaene, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' };
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobil', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: label === 'mobil' ? 2 : 1 });
    await ctx.addCookies([cookie]);
    const page = await ctx.newPage();
    const jsFejl = [];
    page.on('pageerror', (e) => jsFejl.push(e.message));
    // Cloudflares Web Analytics-script indsættes af domænet og blokeres med vilje af systemets CSP
    page.on('console', (m) => m.type() === 'error' && !m.text().includes('cloudflareinsights.com') && jsFejl.push(m.text()));
    for (const [navn, url] of sider) {
      const r = await page.goto(BASE + url, { waitUntil: 'networkidle' });
      const status = r?.status();
      const tekst = await page.locator('body').innerText();
      const bredde = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      tjek(status === 200 && new URL(page.url()).pathname === url.split('?')[0], `${label} ${url}: ${status}${new URL(page.url()).pathname !== url.split('?')[0] ? ` (sendt til ${page.url()})` : ''}`);
      const demo = tekst.match(/.{0,60}(\bdemo(data|en)?\b|lorem ipsum|nordlysbyg).{0,60}/i) ?? tekst.match(/.{0,60}UDFYLD.{0,60}/);
      tjek(!demo, `${label} ${url}: ingen demo- eller pladsholdertekst${demo ? ` ("${demo[0].replace(/\s+/g, ' ')}")` : ''}`);
      if (label === 'mobil') {
        // Det element, der stikker længst ud til højre, så fejlen kan findes
        const bred = bredde > 1 ? await page.evaluate(() => {
          let v = null;
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.right > window.innerWidth + 1 && (!v || r.right > v.r)) v = { r: r.right, t: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}` };
          }
          return v?.t;
        }) : '';
        tjek(bredde <= 1, `${label} ${url}: ingen vandret scroll (${bredde}px${bred ? `, ${bred}` : ''})`);
      }
      await page.screenshot({ path: join(OUT, `${navn}-${label}.png`), fullPage: true });
    }
    tjek(!jsFejl.length, `${label}: ingen JavaScript-fejl${jsFejl.length ? ` (${jsFejl.slice(0, 3).join(' | ')})` : ''}`);
    await ctx.close();
  }

  // --- 3. Forløb: opret job, fejlbesked, registrér forbrug ---------------------------------------
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addCookies([cookie]);
  const page = await ctx.newPage();
  const nummer = `KONTROL-${start}`;

  await page.goto(`${BASE}/job/ny`);
  await page.fill('input[name="number"]', nummer);
  await page.evaluate(() => document.querySelectorAll('[required]').forEach((el) => el.removeAttribute('required')));
  await page.fill('input[name="name"]', '');
  await page.click('button:has-text("Opret job")');
  await page.waitForLoadState('networkidle');
  tjek(new URL(page.url()).pathname === '/job/ny' && (await page.locator('.alert-err').count()) > 0, 'job uden navn afvises med en fejlbesked');
  tjek(!(await sql('SELECT 1 FROM jobs WHERE number = ?', [nummer])).length, 'det afviste job er ikke gemt');
  await page.screenshot({ path: join(OUT, 'job-fejl-mobil.png'), fullPage: true });

  await page.goto(`${BASE}/job/ny`);
  await page.fill('input[name="number"]', nummer);
  await page.fill('input[name="name"]', 'Kontroltest (slettes automatisk)');
  await page.click('button:has-text("Opret job")');
  await page.waitForURL(/\/job\/\d+\?besked=job_oprettet/);
  jobId = Number(new URL(page.url()).pathname.split('/')[2]);
  tjek((await sql('SELECT id FROM jobs WHERE number = ?', [nummer]))[0]?.id === jobId, `jobbet ${nummer} er gemt i databasen`);
  await page.screenshot({ path: join(OUT, 'job-oprettet-mobil.png'), fullPage: true });

  const kandidater = await sql(
    `SELECT p.*, s.lead_time_days AS supplier_lead_time FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.active = 1 AND p.stock - p.reserved >= ? ORDER BY p.stock DESC`,
    [2 * K],
  );
  const vare = kandidater.find((p) => stockLevel(p, p.stock - p.reserved - K) <= p.alert_level && stockLevel(p, p.stock - p.reserved - K) === stockLevel(p, p.stock - p.reserved));
  if (vare) {
    await page.goto(`${BASE}/job/${jobId}/registrer?type=forbrug`);
    await page.fill(`input[name="q_${vare.id}"]`, '1');
    await page.click('button:has-text("Registrér forbrug")');
    await page.waitForURL(new RegExp(`/job/${jobId}\\?besked=forbrug`));
    const efter = (await sql('SELECT stock FROM products WHERE id = ?', [vare.id]))[0];
    tjek(efter.stock === vare.stock - K, `forbrug af 1 × ${vare.name} trækkes fra lageret (${vare.stock / K} → ${efter.stock / K})`);
    const ny = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ny.addCookies([cookie]);
    const p2 = await ny.newPage();
    await p2.goto(`${BASE}/job/${jobId}/historik`, { waitUntil: 'networkidle' });
    tjek((await p2.locator('body').innerText()).includes(vare.name), 'forbruget står i jobbets historik efter genindlæsning i en ny browser');
    await p2.screenshot({ path: join(OUT, 'job-historik-desktop.png'), fullPage: true });
    await ny.close();
  } else {
    tjek(true, 'ingen vare, hvor ét forbrug lader lagerstatus være uændret; forbrug springes over (kun oprettelse testet)');
  }
  await ctx.close();
} catch (err) {
  tjek(false, `uventet fejl: ${err.message}`);
} finally {
  await browser.close();
  // --- 4. Oprydning ---------------------------------------------------------------------------
  if (jobId) {
    const j = [jobId];
    await sql(
      `UPDATE products SET
         stock = stock - (SELECT COALESCE(SUM(m.stock_delta), 0) FROM movements m WHERE m.job_id = ?1 AND m.product_id = products.id),
         reserved = reserved - (SELECT COALESCE(SUM(m.reserved_delta), 0) FROM movements m WHERE m.job_id = ?1 AND m.product_id = products.id)
       WHERE id IN (SELECT product_id FROM movements WHERE job_id = ?1)`,
      j,
    );
    for (const t of ['invoice_bases', 'invoices', 'job_quotes', 'notices', 'movements', 'purchase_lines', 'purchase_lists', 'job_items', 'job_materials', 'job_staff', 'job_log', 'job_entries']) {
      await sql(`DELETE FROM ${t} WHERE job_id = ?`, j);
    }
    await sql('DELETE FROM jobs WHERE id = ?', j);
  }
  await sql('DELETE FROM ops WHERE actor = ? AND created_at >= ?', [EMAIL, start]);
  await sql('DELETE FROM sessions WHERE id_hash = ?', [idHash]);
  const efter = (await sql(FINGERPRINT))[0];
  tjek(JSON.stringify(efter) === JSON.stringify(foer), `databasen er som før testen${JSON.stringify(efter) === JSON.stringify(foer) ? '' : `: før ${JSON.stringify(foer)}, efter ${JSON.stringify(efter)}`}`);
}

writeFileSync(join(OUT, 'resultat.txt'), `${antal - fejl.length} af ${antal} kontroller bestået\n${fejl.map((f) => `FEJL ${f}`).join('\n')}\n`);
console.log(`\n${antal - fejl.length} af ${antal} kontroller bestået på ${BASE}`);
if (fejl.length) process.exit(1);
