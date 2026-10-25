// Skærmbilleder af demoerne (public/demo) til Veyros sider. Billederne lægges i public/demo/_previews og
// vises af snippets/concept.liquid. Kør scriptet igen, når en demo ændres, så forhåndsvisning og demo passer:
//   node scripts/demo-previews.mjs
// Desktop tages ved 960 × 600 (1x og 2x) og mobil ved 390 × 640 (2x). Demo-baren skjules, fordi
// mærkningen står under billedet på Veyros side.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStack } from '../tests/harness.mjs';

const OUT = path.join(ROOT, 'public', 'demo', '_previews');
mkdirSync(OUT, { recursive: true });

// Bookingen vises på trin 3 med en valgt tid, så udsnittet viser selve forløbet.
async function bookingStep3(page) {
  await page.click('[data-step="2"] [data-next]');
  const days = page.locator('[data-cal] input:not(:disabled)');
  const n = await days.count();
  for (let i = 0; i < n; i++) {
    await days.nth(i).check({ force: true });
    if (await page.locator('[data-slots] input').count()) break;
  }
  await page.locator('[data-slots] label').nth(1).click();
  await page.evaluate(() => {
    const el = document.querySelector('.booking');
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 24);
  });
}

const SHOTS = [
  { name: 'holm-tomrer', path: '/demo/holm-tomrer/' },
  { name: 'salon-nord-booking', path: '/demo/salon-nord/book?behandling=dameklip', prepare: bookingStep3 },
  { name: 'lervaerk-produkt', path: '/demo/lervaerk/produkter/krus' },
];
const VIEWS = [
  { suffix: '960', width: 960, height: 600, scale: 1 },
  { suffix: '1920', width: 960, height: 600, scale: 2 },
  { suffix: 'mobil', width: 390, height: 640, scale: 2 },
];

const stack = await startStack({ minMonths: 0 });
try {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? undefined });
  for (const shot of SHOTS) {
    for (const v of VIEWS) {
      const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.scale, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(stack.site + shot.path, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: '.demo-bar { display: none !important; }' });
      if (shot.prepare) await shot.prepare(page);
      // Vent på billederne i udsnittet. Billeder med loading="lazy" længere nede indlæses ikke.
      await page.evaluate(() => Promise.all([...document.images]
        .filter((i) => !i.complete && i.getBoundingClientRect().top < window.innerHeight)
        .map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 5000); }))));
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(OUT, `${shot.name}-${v.suffix}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 84 });
      console.log(path.relative(ROOT, file));
      await ctx.close();
    }
  }
  await browser.close();
} finally {
  await stack.stop();
}
