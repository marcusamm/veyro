// Skærmbilleder af demoerne (public/demo) til Veyros sider. Billederne lægges i public/demo/_previews og
// vises i galleriet, konceptkortene og forsidesektionerne. Kør scriptet igen, når en demo ændres, så forhåndsvisning og demo passer:
//   node scripts/demo-previews.mjs
// Desktop tages ved 960 × 600 (1x og 2x), mobil ved 390 × 640 (2x), og telefonrammen ved 390 × 844 (2x).
// Enkelte motiver kan vælges med fx SHOTS=lervaerk-kurv,holm-tomrer-phone. Demo-baren skjules, fordi
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

async function populatedCart(page) {
  const origin = new URL(page.url()).origin;
  await page.locator('[data-add]').click();
  await page.goto(origin + '/demo/lervaerk/produkter/morgenmadsskaal', { waitUntil: 'networkidle' });
  await page.locator('[data-add]').click();
  await page.goto(origin + '/demo/lervaerk/kurv', { waitUntil: 'networkidle' });
}

const SHOTS = [
  { name: 'holm-tomrer', path: '/demo/holm-tomrer/' },
  { name: 'salon-nord', path: '/demo/salon-nord/' },
  { name: 'lervaerk', path: '/demo/lervaerk/' },
  { name: 'salon-nord-booking', path: '/demo/salon-nord/book?behandling=dameklip', prepare: bookingStep3 },
  { name: 'lervaerk-produkt', path: '/demo/lervaerk/produkter/krus' },
  { name: 'lervaerk-kurv', path: '/demo/lervaerk/produkter/krus', prepare: populatedCart },
  { name: 'holm-tomrer-phone', path: '/demo/holm-tomrer/', views: [{ suffix: '780', width: 390, height: 844, scale: 2 }] },
];
const VIEWS = [
  { suffix: '960', width: 960, height: 600, scale: 1 },
  { suffix: '1920', width: 960, height: 600, scale: 2 },
  { suffix: 'mobil', width: 390, height: 640, scale: 2 },
];

const stack = await startStack({ minMonths: 0 });
try {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? undefined });
  const selected = process.env.SHOTS?.split(',');
  for (const shot of SHOTS.filter(shot => !selected || selected.includes(shot.name))) {
    for (const v of shot.views ?? VIEWS) {
      const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.scale, reducedMotion: 'reduce' });
      await ctx.route('**/*', route => route.request().method() === 'POST' ? route.abort() : route.continue());
      const page = await ctx.newPage();
      await page.goto(stack.site + shot.path, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: '.demo-bar { display: none !important; }' });
      if (shot.prepare) await shot.prepare(page);
      // A preparation step may navigate to another page, such as the populated cart.
      await page.addStyleTag({ content: '.demo-bar { display: none !important; }' });
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
