// Tager skærmbilleder af de vigtigste sider (desktop 1280, tablet 820 og mobil 390) mod en lokal
// `wrangler dev --local` med demodata. Kræver Chromium til Playwright.
//   PLAYWRIGHT_BROWSERS_PATH=/sti/til/browsere npm run screenshots
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, demoLogin, startStack } from '../tests/harness.mjs';

const OUT = path.join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });

const stack = await startStack({ demo: true, email: false });
try {
  const owner = await demoLogin(stack, 'ejer');
  const staff = await demoLogin(stack, 'medarbejder');
  const job = (n) => stack.sql(`SELECT id FROM jobs WHERE number = '${n}'`)[0].id;
  const pid = (sku) => stack.sql(`SELECT id FROM products WHERE sku = '${sku}'`)[0].id;
  const list = stack.sql(`SELECT id FROM purchase_lists WHERE job_id = ${job('2026-015')} ORDER BY id LIMIT 1`)[0].id;
  const inv = (where) => stack.sql(`SELECT id FROM invoices WHERE ${where} ORDER BY id LIMIT 1`)[0].id;
  const quote = stack.sql(`SELECT id FROM job_quotes WHERE job_id = ${job('2026-014')} ORDER BY version DESC LIMIT 1`)[0].id;

  const browser = await chromium.launch();
  const host = new URL(stack.base).hostname;
  const toCookies = (c) => [...c.cookies].map(([name, value]) => ({ name, value, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }));
  const shots = [
    { name: 'login', url: '/login', who: null },
    { name: 'lager-oversigt', url: '/lager', who: owner },
    { name: 'lager-varer', url: '/lager/varer', who: owner },
    { name: 'lager-vare', url: `/lager/varer/${pid('FUG-300')}`, who: owner },
    { name: 'lager-indkob', url: '/lager/indkob', who: owner },
    { name: 'lager-indkobsliste', url: `/lager/indkob/${list}`, who: owner },
    { name: 'lager-prisestimat', url: `/lager/indkob/${list}`, who: owner, selector: '#prisestimat' },
    { name: 'lager-forhandlere', url: '/lager/priser', who: owner },
    { name: 'lager-modtagelse', url: '/lager/modtagelse', who: owner },
    { name: 'lager-indstillinger', url: '/lager/indstillinger', who: owner },
    { name: 'job-liste', url: '/job?vis=alle', who: owner },
    { name: 'job-liste-medarbejder', url: '/job', who: staff },
    { name: 'job-overblik', url: `/job/${job('2026-014')}`, who: owner },
    { name: 'job-afventer', url: `/job/${job('2026-015')}`, who: staff },
    { name: 'job-materialer', url: `/job/${job('2026-016')}/materialer`, who: owner },
    { name: 'job-materialer-medarbejder', url: `/job/${job('2026-014')}/materialer`, who: staff },
    { name: 'job-timer', url: `/job/${job('2026-014')}/timer`, who: owner },
    { name: 'job-overslag', url: `/job/${job('2026-014')}/overslag`, who: owner },
    { name: 'job-faktura', url: `/job/${job('2026-010')}/faktura`, who: owner },
    { name: 'job-historik', url: `/job/${job('2026-014')}/historik`, who: owner },
    { name: 'job-ny', url: '/job/ny', who: owner },
    { name: 'fakturaer', url: '/job/faktura', who: owner },
    { name: 'faktura-udstedt', url: `/job/faktura/${inv("kind = 'faktura' AND status = 'udstedt'")}`, who: owner },
    { name: 'faktura-kladde', url: `/job/faktura/${inv("status = 'kladde'")}`, who: owner },
    { name: 'kreditnota', url: `/job/faktura/${inv("kind = 'kreditnota'")}`, who: owner },
    { name: 'job-registrer', url: `/job/${job('2026-014')}/registrer?type=forbrug`, who: staff },
    { name: 'job-lager', url: '/job/lager', who: staff },
  ];
  // PDF'er: prisoverslag, udstedt faktura og kreditnota
  for (const [name, url] of [
    ['prisoverslag', `/job/${job('2026-014')}/overslag/${quote}.pdf`],
    ['faktura', `/job/faktura/${inv("kind = 'faktura' AND status = 'udstedt'")}.pdf`],
    ['kreditnota', `/job/faktura/${inv("kind = 'kreditnota'")}.pdf`],
    ['faktura-kladde', `/job/faktura/${inv("status = 'kladde'")}.pdf`],
  ]) {
    const res = await fetch(stack.base + url, { headers: { Cookie: owner.cookieHeader(), 'CF-Connecting-IP': owner.ip } });
    writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(await res.arrayBuffer()));
    console.log('Gemt:', `screenshots/${name}.pdf`);
  }
  for (const [label, width] of [['desktop', 1280], ['tablet', 820], ['mobil', 390]]) {
    const opts = { viewport: { width, height: label === 'mobil' ? 844 : label === 'tablet' ? 1180 : 900 }, deviceScaleFactor: label === 'desktop' ? 1 : 2 };
    for (const s of shots) {
      if (label === 'tablet' && !s.name.startsWith('job-') && !s.name.startsWith('faktura')) continue;
      const ctx = await browser.newContext(opts);
      if (s.who) await ctx.addCookies(toCookies(s.who));
      const page = await ctx.newPage();
      await page.goto(stack.base + s.url, { waitUntil: 'networkidle' });
      const file = path.join(OUT, `${s.name}-${label}.png`);
      if (s.selector) {
        await page.addStyleTag({ content: 'header{position:static!important}' });
        await page.locator(s.selector).screenshot({ path: file });
      }
      else await page.screenshot({ path: file, fullPage: true });
      console.log('Gemt:', `screenshots/${s.name}-${label}.png`);
      await ctx.close();
    }
  }
  // Demoforløbet (kører eksemplerne igennem lagermotoren)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(toCookies(owner));
  const page = await ctx.newPage();
  await page.goto(stack.base + '/lager/demo', { waitUntil: 'networkidle' });
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit].btn-primary')]);
  await page.screenshot({ path: path.join(OUT, 'demoforloeb-desktop.png'), fullPage: true });
  console.log('Gemt: screenshots/demoforloeb-desktop.png');
  await ctx.close();
  await browser.close();
} finally {
  await stack.stop();
}
