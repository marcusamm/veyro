// Skærmbilleder af Kundeemner, Mailkonti, Tilføj via link, Find nye kundeemner og omkostningssiderne
// (desktop 1280 og mobil 390) mod en lokal `wrangler dev --local` med simuleret Google og testhjemmeside.
//   OUT=/sti/til/mappe node scripts/screenshots-kundeemner.mjs
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startGoogleMock } from '../tests/google-mock.mjs';
import { ADMIN_EMAIL, ROOT, csrfFrom, login, startStack, waitFor } from '../tests/harness.mjs';

const OUT = process.env.OUT ?? path.join(ROOT, 'screenshots', 'kundeemner');
mkdirSync(OUT, { recursive: true });

const g = await startGoogleMock();
const stack = await startStack({
  minMonths: 0,
  devMode: true,
  extraVars: {
    MAIL_ACCOUNTS: `${ADMIN_EMAIL},kontakt@veyro.dk,tobias@veyro.dk`,
    SHARED_MAILBOXES: 'kontakt@veyro.dk',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    MAIL_TOKEN_KEY: randomBytes(32).toString('base64'),
    GOOGLE_OAUTH_BASE: g.url,
    GOOGLE_TOKEN_BASE: g.url,
    GMAIL_API_BASE: g.url,
    TEST_FETCH_ALLOW: g.host,
  },
});
try {
  const admin = (await login(stack, ADMIN_EMAIL)).client;
  const send = async (pageUrl, action, form = {}) => admin.post(action, { _csrf: csrfFrom((await admin.get(pageUrl)).html), ...form });
  const create = async (form) => Number((await send('/admin/kundeemner/ny', '/admin/kundeemner', form)).headers.get('location').match(/(\d+)/)[1]);

  const main = await create({
    company: 'Slagelse Bryghus', industry: 'Fødevarer', city: 'Slagelse', area: 'Sjælland', website: 'slagelsebryghus-test.dk', contact_name: 'Mette Holm',
    emails: 'mette@slagelsebryghus-test.dk', phones: '12 34 56 78', source: 'Slagelse Festival 2026', needs: 'Ingen online bestilling af rundvisninger; åbningstiderne på forsiden er fra 2024.', priority: 'hoej', owner: ADMIN_EMAIL,
  });
  await create({ company: 'Korsør Cykler', industry: 'Detail', city: 'Korsør', area: 'Sjælland', priority: 'mellem' });
  await create({ company: 'Café Torvet', industry: 'Café', city: 'Slagelse', area: 'Sjælland', priority: 'lav', status: 'klar' });
  const now = new Date(Date.now() - 3600_000).toLocaleString('sv-SE', { timeZone: 'Europe/Copenhagen' }).replace(' ', 'T').slice(0, 16);
  const d = await admin.get(`/admin/kundeemner/${main}`);
  const follow = d.html.match(/name="follow_up_on" type="date" value="(\d{4}-\d{2}-\d{2})"/)[1];
  await admin.post(`/admin/kundeemner/${main}/kontakt`, { _csrf: csrfFrom(d.html), channel: 'telefon', at: now, staff: ADMIN_EMAIL, contact_person: 'Mette Holm', body: 'Interesseret i booking af rundvisninger. Vil gerne se et tilbud.', follow_up_on: follow });
  await send(`/admin/kundeemner/${main}`, `/admin/omkostninger/tid?emne=p:${main}`, { back: `/admin/kundeemner/${main}`, work_date: '2026-10-20', staff: ADMIN_EMAIL, hours: '0', minutes: '30', category: 'salg', description: 'Research og opkald' });
  await send(`/admin/kundeemner/${main}`, `/admin/omkostninger/udgift?emne=p:${main}`, { back: `/admin/kundeemner/${main}`, spent_on: '2026-10-20', description: 'Prøvedomæne', amount: '50', type: 'domaene', purpose: 'salg', registered_by: ADMIN_EMAIL });

  // Mail: forbind admin-postkassen og synkronisér en samtale
  await fetch(g.url + '/__g/add', { method: 'POST', body: JSON.stringify({ account: ADMIN_EMAIL, message: { id: 'm1', threadId: 't1', internalDate: Date.now() - 7200_000, headers: { From: ADMIN_EMAIL, To: 'mette@slagelsebryghus-test.dk', Subject: 'Booking af rundvisninger', 'Message-ID': '<m1@veyro>' }, body: 'Hej Mette\n\nTak for snakken. Her er et forslag til online booking.\n\nVenlig hilsen' } }) });
  await fetch(g.url + '/__g/add', { method: 'POST', body: JSON.stringify({ account: ADMIN_EMAIL, message: { id: 'm2', threadId: 't1', internalDate: Date.now() - 3600_000, headers: { From: 'Mette Holm <mette@slagelsebryghus-test.dk>', To: ADMIN_EMAIL, Subject: 'SV: Booking af rundvisninger', 'Message-ID': '<m2@bryghus>', References: '<m1@veyro>' }, body: 'Det lyder godt. Kan I ringe torsdag?' } }) });
  const fr = await send('/admin/kundeemner/mail', `/admin/kundeemner/mail/konto/${encodeURIComponent(ADMIN_EMAIL)}/forbind`, { drafts: '1' });
  const state = new URL(fr.headers.get('location')).searchParams.get('state');
  await admin.get(`/admin/kundeemner/mail/callback?state=${state}&code=${encodeURIComponent(`code|${ADMIN_EMAIL}|https://www.googleapis.com/auth/gmail.readonly+https://www.googleapis.com/auth/gmail.compose`)}`);

  // Tilføj via link
  const lr = await send('/admin/kundeemner/link', '/admin/kundeemner/link', { url: `${g.url}/` });
  const linkUrl = lr.headers.get('location');
  await waitFor(async () => (await admin.get(linkUrl)).html.includes('Opret kundeemne'), 15000);

  // Kilde
  await send('/admin/kundeemner/find', '/admin/kundeemner/find/kilder', { name: 'Slagelse Festival – udstillere', url: `${g.url}/udstillere`, industry: 'Fødevarer', area: 'Sjælland' });
  const fp = await admin.get('/admin/kundeemner/find');
  const sid = fp.html.match(/find\/kilder\/(\d+)\/koer/)[1];
  await admin.post(`/admin/kundeemner/find/kilder/${sid}/koer`, { _csrf: csrfFrom(fp.html) });
  await waitFor(async () => (await admin.get('/admin/kundeemner/find')).html.includes('Slagterhuset'), 15000);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? undefined });
  const host = new URL(stack.base).hostname;
  const cookies = [...admin.cookies].map(([name, value]) => ({ name, value, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }));
  const shots = [
    ['liste', '/admin/kundeemner'],
    ['detalje', `/admin/kundeemner/${main}`],
    ['nyt', '/admin/kundeemner/ny'],
    ['tilfoej-via-link', linkUrl],
    ['find', '/admin/kundeemner/find'],
    ['mailkonti', '/admin/kundeemner/mail'],
    ['mailudkast', `/admin/kundeemner/${main}/udkast`],
    ['omkostningsoverblik', '/admin/statistik/omkostninger?periode=alt'],
  ];
  for (const [label, width] of [['desktop', 1280], ['mobil', 390]]) {
    for (const [name, url] of shots) {
      const ctx = await browser.newContext({ viewport: { width, height: label === 'mobil' ? 844 : 900 }, deviceScaleFactor: label === 'mobil' ? 2 : 1 });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto(stack.base + url, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.querySelectorAll('details.mail-msg').forEach((x) => (x.open = true)));
      const file = path.join(OUT, `${name}-${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      console.log('Gemt:', file, overflow ? '(VANDRET SCROLL)' : '');
      await ctx.close();
    }
  }
  await browser.close();
} finally {
  await stack.stop();
  await g.close();
}
