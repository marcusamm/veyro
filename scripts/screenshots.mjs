// Tager skærmbilleder af de vigtigste sider (desktop 1280 og mobil 390) mod en lokal
// `wrangler dev --local` med mock-Stripe. Kræver Chromium til Playwright.
//   PLAYWRIGHT_BROWSERS_PATH=/sti/til/browsere npm run screenshots
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ADMIN_EMAIL, ROOT, csrfFrom, login, seedCustomer, setMockState, startStack } from '../tests/harness.mjs';

const OUT = path.join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

const stack = await startStack({ minMonths: 12 });
try {
  await seedCustomer(stack, {
    email: 'anna@example.dk', name: 'Anna Jensen', cus: 'cus_A', sub: 'sub_A',
    price: 'price_business_test', start: now - 75 * DAY, periodEnd: now + 14 * DAY,
  });
  await setMockState(stack.mock, {
    invoices: [0, 1, 2].map((i) => ({
      id: 'in_' + i, customer: 'cus_A', number: `VEYRO-000${3 - i}`, status: 'paid',
      created: now - (16 + i * 30) * DAY, total: 59900, amount_due: 59900, amount_paid: 59900, currency: 'dkk',
      hosted_invoice_url: 'https://invoice.stripe.com/i/test', invoice_pdf: 'https://pay.stripe.com/invoice/test/pdf',
    })),
  });

  const { client } = await login(stack, 'anna@example.dk');
  const reqs = [
    ['content', 'Nye åbningstider på forsiden', 'Fra 1. november har vi åbent 9–17 på hverdage og 10–14 lørdag.'],
    ['bug', 'Kontaktformularen sender ikke', 'Når man trykker send på kontaktsiden, sker der ikke noget på mobil.'],
    ['question', 'Kan vi få en side til jobopslag?', 'Vi skal ansætte to nye medarbejdere og vil gerne have en side til det.'],
  ];
  for (const [type, title, description] of reqs) {
    const page = await client.get('/konto/henvendelser');
    await client.post('/konto/henvendelser', { _csrf: csrfFrom(page.html), type, title, description });
  }
  const admin = await login(stack, ADMIN_EMAIL);
  const ap = await admin.client.get('/admin/henvendelser');
  const ids = [...ap.html.matchAll(/action="\/admin\/henvendelser\/(\d+)\/status"/g)].map((m) => m[1]);
  await admin.client.post(`/admin/henvendelser/${ids[1]}/status`, { _csrf: csrfFrom(ap.html), status: 'in_progress' });
  await admin.client.post(`/admin/henvendelser/${ids[2]}/status`, { _csrf: csrfFrom(ap.html), status: 'resolved' });

  const browser = await chromium.launch();
  const host = new URL(stack.base).hostname;
  const toCookies = (c) => [...c.cookies].map(([name, value]) => ({ name, value, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }));

  const shots = [
    { name: 'login', url: '/login', who: null },
    { name: 'bestil', url: '/bestil', who: null },
    { name: 'dashboard', url: '/konto', who: client },
    { name: 'skift-plan', url: '/konto/plan', who: client },
    { name: 'skift-plan-bekraeft', url: '/konto/plan/bekraeft?plan=premium', who: client },
    { name: 'henvendelser', url: '/konto/henvendelser', who: client },
    { name: 'fakturaer', url: '/konto/fakturaer', who: client },
    { name: 'admin-henvendelser', url: '/admin/henvendelser', who: admin.client },
  ];
  for (const [label, width] of [['desktop', 1280], ['mobil', 390]]) {
    for (const s of shots) {
      const ctx = await browser.newContext({ viewport: { width, height: label === 'mobil' ? 844 : 900 }, deviceScaleFactor: label === 'mobil' ? 2 : 1 });
      if (s.who) await ctx.addCookies(toCookies(s.who));
      const page = await ctx.newPage();
      await page.goto(stack.base + s.url, { waitUntil: 'networkidle' });
      if (s.name === 'henvendelser') await page.locator('details').first().evaluate((d) => (d.open = true));
      const file = path.join(OUT, `${s.name}-${label}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log('Gemt:', path.relative(ROOT, file));
      await ctx.close();
    }
  }
  await browser.close();
} finally {
  await stack.stop();
}
