// Lokal visuel QA af den offentlige hjemmeside. Stripe/Resend er mocks.
// Ingen rigtige henvendelser: browseren blokerer alle POST-kald.
// OUT=/private/tmp/veyro-review node scripts/review-public.mjs
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ROOT, startStack } from '../tests/harness.mjs';

const out = process.env.OUT ?? '/private/tmp/veyro-review';
mkdirSync(out, { recursive: true });
const content = JSON.parse(readFileSync(path.join(ROOT, 'site/content.json'), 'utf8'));
const paths = process.env.PATHS ? process.env.PATHS.split(',') : ['/', ...content.pages.filter(p => p.published).map(p => '/pages/' + p.handle), '/cart', '/findes-ikke'];
const results = [];
const stack = await startStack({ minMonths: 0 });
const browser = await chromium.launch();
try {
  for (const width of [390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    await context.addInitScript(() => {
      localStorage.setItem('theme-cookie-consent', JSON.stringify({ v: 1, t: Date.now(), consent: { analytics: false, marketing: false } }));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const url of paths) {
      const response = await page.goto(stack.site + url, { waitUntil: 'networkidle' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        for (let y = 0; y < document.body.scrollHeight; y += 900) {
          window.scrollTo(0, y);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        window.scrollTo(0, 0);
      });
      const metrics = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        overflowElements: [...document.querySelectorAll('main *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => el.className).slice(0, 10),
        h1: document.querySelectorAll('h1').length,
        brokenImages: [...document.images].filter(img => img.currentSrc && img.complete && !img.naturalWidth).map(img => img.currentSrc),
        height: document.documentElement.scrollHeight,
      }));
      const name = url === '/' ? 'forside' : url.split('/').filter(Boolean).join('-');
      await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage: true });
      if (url === '/') {
        await page.screenshot({ path: path.join(out, `forside-top-${width}.png`) });
        await page.locator('.packages').first().screenshot({ path: path.join(out, `prissammenligning-${width}.png`) });
        await page.locator('.booking-flow').screenshot({ path: path.join(out, `bookingforloeb-${width}.png`) });
      }
      results.push({ url, width, status: response.status(), ...metrics });
      assert.equal(response.status(), url === '/findes-ikke' ? 404 : 200, url);
      assert.equal(metrics.overflow, false, `${width} ${url}: overflow`);
      assert.equal(metrics.h1, 1, `${url}: én H1`);
      assert.deepEqual(metrics.brokenImages, [], `${url}: billeder`);
    }
    await page.goto(stack.site, { waitUntil: 'networkidle' });
    if (width < 990) {
      const toggle = page.locator('[data-nav-toggle]');
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#MobileNav').isVisible(), true);
      await page.screenshot({ path: path.join(out, `menu-${width}.png`) });
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    }
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => ({ tag: document.activeElement.tagName, outline: getComputedStyle(document.activeElement).outlineStyle }));
    assert.notEqual(focus.tag, 'BODY');
    assert.notEqual(focus.outline, 'none');
    await page.goto(stack.site + '/pages/kontakt?ydelse=pakke-booking#formular', { waitUntil: 'networkidle' });
    assert.equal(await page.locator('select[name="contact[Ydelse]"]').inputValue(), 'Pakke: Booking');
    const valid = await page.locator('form').first().evaluate(form => form.checkValidity());
    assert.equal(valid, false, 'Tom kontaktformular afvises');
    await page.locator('form button[type="submit"]').first().click();
    assert.equal(await page.locator('[data-error-summary]').first().isVisible(), true, 'Synlig fejloversigt');
    await page.screenshot({ path: path.join(out, `kontakt-fejl-${width}.png`) });
    assert.deepEqual(errors, [], 'Ingen JavaScript-fejl');
    await context.close();
    console.log(`${width}px: ${paths.length} sider, menu, tastaturfokus og formular kontrolleret`);
  }
} finally {
  writeFileSync(path.join(out, 'review.json'), JSON.stringify(results, null, 2));
  await browser.close();
  await stack.stop();
}
