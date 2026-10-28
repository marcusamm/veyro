// Focused QA of the original floating demo gallery. Local stack; Stripe/Resend mocked.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startStack } from '../tests/harness.mjs';

const out = process.env.OUT ?? '/private/tmp/veyro-gallery';
mkdirSync(out, { recursive: true });
const results = [];
const failures = [];
const stack = await startStack({ minMonths: 0 });
const browser = await chromium.launch();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function state(page) {
  return page.locator('[data-project-gallery]').evaluate(el => {
    const stage = el.querySelector('[data-gallery-stage]');
    const intro = el.querySelector('.project-gallery__intro').getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      x: getComputedStyle(el).getPropertyValue('--gallery-x').trim(),
      y: getComputedStyle(el).getPropertyValue('--gallery-y').trim(),
      scroll: getComputedStyle(el).getPropertyValue('--gallery-scroll').trim(),
      transforms: [...el.querySelectorAll('.project-gallery__plane')].map(plane => getComputedStyle(plane).transform),
      animations: [...el.querySelectorAll('.project-gallery__float')].map(plane => ({ name: getComputedStyle(plane).animationName, state: getComputedStyle(plane).animationPlayState })),
      images: [...el.querySelectorAll('img')].map(img => ({ src: img.currentSrc, naturalWidth: img.naturalWidth, loaded: img.complete })),
      introBottom: intro.bottom,
      planeTops: [...el.querySelectorAll('.project-gallery__plane')].map(plane => plane.getBoundingClientRect().top),
      stageWidth: stage.clientWidth,
      stageScrollWidth: stage.scrollWidth,
      stageScrollLeft: stage.scrollLeft,
    };
  });
}
try {
  for (const width of [1440, 390]) for (const mode of ['normal', 'reduced', 'no-js']) {
    const prefix = `${mode}-${width}`;
    const record = { width, mode, checks: {} };
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference', javaScriptEnabled: mode !== 'no-js', ...(width === 1440 && mode === 'normal' ? { recordVideo: { dir: path.join(out, 'videos'), size: { width, height: 1000 } } } : {}) });
    await context.route('**/*', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    await context.addInitScript(() => localStorage.setItem('theme-cookie-consent', JSON.stringify({ v: 1, t: Date.now(), consent: { analytics: false, marketing: false } })));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(stack.site + '/#eksempler', { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const gallery = page.locator('[data-project-gallery]');
      await gallery.scrollIntoViewIfNeeded();
      await wait(500);
      const links = gallery.locator('.project-gallery__plane');
      assert.equal(await links.count(), 3);
      assert.deepEqual(await links.evaluateAll(nodes => nodes.map(el => el.getAttribute('href'))), ['/demo/holm-tomrer/', '/demo/salon-nord/book', '/demo/lervaerk/produkter/krus']);
      assert.match(await gallery.innerText(), /Fiktive designkoncepter/);
      const initial = await state(page);
      assert.equal(initial.overflow, false, 'No page overflow');
      await gallery.screenshot({ path: path.join(out, `${prefix}-gallery.png`) });
      record.checks.initial = initial;
      if (width === 1440) {
        initial.planeTops.forEach(top => assert.ok(top >= initial.introBottom - 3, 'Floating planes do not obscure the readable introduction'));
        if (mode === 'normal') {
          const box = await gallery.boundingBox();
          await page.mouse.move(box.x + box.width * .18, Math.max(120, box.y + box.height * .3));
          await wait(300);
          const pointerLeft = await state(page);
          await page.mouse.move(box.x + box.width * .82, Math.max(150, box.y + box.height * .65));
          await wait(300);
          const pointerRight = await state(page);
          assert.notDeepEqual(pointerLeft.transforms, pointerRight.transforms, 'Pointer parallax changes plane transforms');
          assert.ok(pointerRight.animations.every(a => a.name !== 'none' && a.state === 'running'), 'Visible planes float with motion enabled');
          await page.evaluate(() => scrollBy(0, 140));
          await wait(350);
          const scrolled = await state(page);
          assert.notEqual(pointerRight.scroll, scrolled.scroll, 'Scrolling scrubs the spatial composition');
          await gallery.screenshot({ path: path.join(out, `${prefix}-pointer-scroll.png`) });
          record.checks.parallax = { left: pointerLeft.transforms, right: pointerRight.transforms, scrollBefore: pointerRight.scroll, scrollAfter: scrolled.scroll };
          await page.locator('[data-motion-toggle]').click();
          await wait(150);
          const paused = await state(page);
          assert.ok(paused.animations.every(a => a.name === 'none' || a.state === 'paused'), 'Pause freezes the floating animation');
          const outerBefore = paused.transforms;
          await page.mouse.move(1100, 500);
          await wait(300);
          assert.deepEqual((await state(page)).transforms, outerBefore, 'Paused pointer motion stays static');
          record.checks.paused = paused;
          await page.locator('[data-motion-toggle]').click();
          await wait(150);
        } else {
          assert.ok(initial.animations.every(a => a.name === 'none'), 'Static fallback runs no floating animation');
          const original = initial.transforms;
          await page.mouse.move(1000, 600);
          await wait(250);
          assert.deepEqual((await state(page)).transforms, original, 'Fallback pointer remains static');
        }
      } else {
        assert.ok(initial.stageScrollWidth > initial.stageWidth * 2, 'Native horizontal gallery has all three demo planes');
        assert.ok(initial.animations.every(a => a.name === 'none'), 'Touch layout has no continuous float');
        await links.last().focus();
        await wait(250);
        const third = await links.last().boundingBox();
        const after = await state(page);
        assert.ok(after.stageScrollLeft > initial.stageScrollLeft + 100, 'Keyboard focus scrolls the third demo into view');
        assert.ok(third.x >= 0 && third.x + third.width <= width + 1, 'Third demo is reachable inside the mobile viewport');
        assert.equal(await links.last().evaluate(el => el === document.activeElement), true, 'The third link can receive keyboard focus');
        await gallery.screenshot({ path: path.join(out, `${prefix}-third-demo.png`) });
        record.checks.mobileReachability = { stageScrollLeft: after.stageScrollLeft, third };
      }
      const final = await state(page);
      assert.equal(final.overflow, false, 'No page overflow after interaction');
      final.images.forEach(img => assert.ok(img.loaded && img.naturalWidth > 0, `Demo image loaded: ${img.src}`));
      assert.deepEqual(errors, [], 'No runtime errors');
      record.status = 'passed';
      console.log(`PASS ${prefix}`);
    } catch (error) {
      record.status = 'failed'; record.error = error.stack || String(error); record.errors = errors;
      failures.push(`${prefix}: ${error.message}`);
      await page.screenshot({ path: path.join(out, `${prefix}-failure.png`), fullPage: true }).catch(() => {});
      console.error(`FAIL ${prefix}: ${error.message}`);
    }
    const video = page.video();
    await context.close();
    if (video) await video.saveAs(path.join(out, 'gallery-motion.webm'));
    results.push(record);
    writeFileSync(path.join(out, 'review.json'), JSON.stringify({ results, failures }, null, 2));
  }
} finally { await browser.close(); await stack.stop(); }
if (failures.length) process.exitCode = 1;
