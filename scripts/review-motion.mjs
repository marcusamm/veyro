// Motion QA against a temporary local D1 and mocked Stripe/Resend.
// OUT=/private/tmp/veyro-motion node scripts/review-motion.mjs
// Captures both actual animation and reduced-motion / no-JavaScript fallbacks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startStack } from '../tests/harness.mjs';

const out = process.env.OUT ?? '/private/tmp/veyro-motion';
mkdirSync(out, { recursive: true });
const results = [];
const failures = [];
const stack = await startStack({ minMonths: 0 });
let browser;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');

async function canvasState(page) {
  return page.locator('canvas[data-particle-scene]').first().evaluate(canvas => {
    const context = canvas.getContext('2d');
    const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    let light = 0;
    // Sample the image rather than sending megabytes of canvas data to Node.
    let digest = 2166136261;
    if (pixels) for (let i = 0; i < pixels.length; i += 16) {
      digest = Math.imul(digest ^ pixels[i], 16777619);
      digest = Math.imul(digest ^ pixels[i + 1], 16777619);
      digest = Math.imul(digest ^ pixels[i + 2], 16777619);
      digest = Math.imul(digest ^ pixels[i + 3], 16777619);
      if (pixels[i + 3] > 0) opaque++;
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 180 && pixels[i + 3] > 0) light++;
    }
    return { frames: Number(canvas.dataset.frames || 0), paused: canvas.dataset.paused, width: canvas.width, height: canvas.height, digest: digest >>> 0, opaque, light };
  });
}

async function layoutState(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const elements = [...main.querySelectorAll('h1,h2,h3,.rte,.pc__name,.steps__text')];
    const invisible = elements.filter(el => {
      if (el.closest('details:not([open])') && !el.closest('summary')) return false;
      const style = getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || el.getBoundingClientRect().height === 0;
    }).map(el => el.textContent.trim().slice(0, 80));
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      h1: main.querySelectorAll('h1').length,
      mainTextLength: main.innerText.length,
      invisible,
      title: main.querySelector('h1')?.innerText,
      bodyReady: document.body.classList.contains('studio-motion-ready'),
    };
  });
}

async function scrollPage(page) {
  const dimensions = await page.evaluate(() => ({ height: document.body.scrollHeight, step: innerHeight * .7 }));
  // Timers inside page.evaluate are disabled along with authored JS in the no-JS case.
  // Node drives the same native scroll sequence in all three modes.
  for (let y = 0; y < dimensions.height; y += dimensions.step) {
    await page.evaluate(y => scrollTo(0, y), y);
    await wait(80);
  }
  await wait(900); // Let the final observed reveal settle before checking accessibility.
}

async function meterState(page) {
  return page.locator('[data-scroll-progress]').first().evaluate(el => ({
    transform: getComputedStyle(el).transform,
    width: el.getBoundingClientRect().width,
    value: el.getAttribute('aria-valuenow'),
    progress: el.dataset.progress,
  }));
}

async function checkMenu(page, width, prefix) {
  const toggle = page.locator('[data-nav-toggle]');
  if (!(await toggle.isVisible())) return;
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'Menu opens');
  assert.equal(await page.locator('#MobileNav').isVisible(), true, 'Menu content is visible');
  const panelBounds = await page.locator('#MobileNav').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(panelBounds.y >= 0 && panelBounds.y < viewport.height / 2, 'Menu starts within the viewport after scrolling');
  assert.ok(Math.abs(panelBounds.y + panelBounds.height - viewport.height) <= 2, 'Menu reaches the viewport bottom without clipping');
  const focusedInMenu = await page.evaluate(() => !!document.activeElement.closest('#MobileNav'));
  assert.equal(focusedInMenu, true, 'Opening the menu moves keyboard focus into it');
  await wait(700); // Capture the fully opened overlay, after its reveal animation.
  await page.screenshot({ path: path.join(out, `${prefix}-menu.png`) });
  await page.keyboard.press('Escape');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Escape closes menu');
  await wait(700);
  assert.equal(await page.locator('#MobileNav').isVisible(), false, 'Closed menu is hidden');
  assert.equal(await toggle.evaluate(el => document.activeElement === el), true, 'Escape restores focus to menu toggle');
}

try {
  browser = await chromium.launch();
  for (const width of (process.env.WIDTHS ? process.env.WIDTHS.split(',').map(Number) : [1440, 390])) {
    for (const mode of (process.env.MODES ? process.env.MODES.split(',') : ['normal', 'reduced', 'no-js'])) {
      const prefix = `${mode}-${width}`;
      const record = { width, mode, status: 'running', checks: {} };
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference',
        javaScriptEnabled: mode !== 'no-js',
        ...(mode === 'normal' ? { recordVideo: { dir: path.join(out, 'videos'), size: { width, height: 1000 } } } : {}),
      });
      let page;
      const errors = [];
      try {
        await context.route('**/*', route => route.request().method() === 'POST' ? route.abort() : route.continue());
        await context.addInitScript(() => {
          localStorage.setItem('theme-cookie-consent', JSON.stringify({ v: 1, t: Date.now(), consent: { analytics: false, marketing: false } }));
        });
        page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        const response = await page.goto(stack.site, { waitUntil: 'networkidle' });
        assert.equal(response.status(), 200, 'Homepage loads');
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator('main h1').isVisible(), true, 'Main heading is visible');
        assert.equal((await layoutState(page)).overflow, false, 'No horizontal overflow on arrival');

        if (mode === 'normal') {
          await page.waitForFunction(() => document.body.classList.contains('studio-motion-ready'));
          await page.waitForFunction(() => Number(document.querySelector('canvas[data-particle-scene]')?.dataset.frames) >= 3);
          // Allow introductory text movement to settle so the canvas itself proves ongoing motion.
          await wait(1000);
          const first = await canvasState(page);
          const firstImage = await page.screenshot({ path: path.join(out, `${prefix}-frame-a.png`) });
          await wait(500);
          const second = await canvasState(page);
          const secondImage = await page.screenshot({ path: path.join(out, `${prefix}-frame-b.png`) });
          assert.ok(first.width > 0 && first.height > 0, 'Canvas has a rendered size');
          assert.ok(first.opaque > 0 && first.light > 0, 'Canvas contains visible artwork');
          assert.ok(second.frames > first.frames, 'The artwork continues rendering');
          assert.notEqual(second.digest, first.digest, 'Actual canvas pixels change between frames');
          assert.notEqual(hash(firstImage), hash(secondImage), 'Time-separated visible page frames differ');
          record.checks.animation = { first, second, screenshotsDiffer: true };
          const pauseToggle = page.locator('[data-motion-toggle]');
          await pauseToggle.click();
          await wait(150);
          const pausedFrame = await canvasState(page);
          await wait(500);
          const pausedLater = await canvasState(page);
          assert.equal(pausedLater.frames, pausedFrame.frames, 'Pause control stops the artwork loop');
          assert.equal(pausedLater.paused, 'true', 'Pause state is reflected on the canvas');
          assert.equal(await pauseToggle.getAttribute('aria-pressed'), 'true', 'Pause button announces pressed state');
          await pauseToggle.click();
          await page.waitForFunction(frames => Number(document.querySelector('canvas[data-particle-scene]')?.dataset.frames) > frames, pausedLater.frames);
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await wait(150);
          const dynamicReduced = await canvasState(page);
          await wait(500);
          const dynamicReducedLater = await canvasState(page);
          assert.equal(dynamicReducedLater.frames, dynamicReduced.frames, 'Changing system preference stops animation');
          assert.equal(dynamicReducedLater.digest, dynamicReduced.digest, 'Dynamic reduced-motion frame remains still');
          record.checks.dynamicMediaDiagnostic = await page.evaluate(() => ({ matches: matchMedia('(prefers-reduced-motion: reduce)').matches, bodyReady: document.body.classList.contains('studio-motion-ready'), paused: document.querySelector('[data-particle-scene]').dataset.paused }));
          await page.waitForFunction(() => !document.body.classList.contains('studio-motion-ready'), null, { timeout: 2000 });
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await page.waitForFunction(frames => Number(document.querySelector('canvas[data-particle-scene]')?.dataset.frames) > frames, dynamicReducedLater.frames);
          record.checks.controls = { pausedFrame, pausedLater, dynamicReduced, dynamicReducedLater, resumed: true };

          const stage = await page.locator('.studio-stage').boundingBox();
          await page.mouse.move(stage.x + stage.width * .2, stage.y + Math.min(stage.height * .3, 500));
          await wait(250);
          const pointerA = await canvasState(page);
          await page.mouse.move(stage.x + stage.width * .8, stage.y + Math.min(stage.height * .6, 750));
          await wait(400);
          const pointerB = await canvasState(page);
          assert.notEqual(pointerA.digest, pointerB.digest, 'Canvas stays visually active during pointer interaction');
          await page.screenshot({ path: path.join(out, `${prefix}-pointer.png`) });
          record.checks.pointer = { before: pointerA.digest, after: pointerB.digest };
          const meterStart = await meterState(page);
          await scrollPage(page);
          const meterEnd = await meterState(page);
          assert.notDeepEqual(meterEnd, meterStart, 'Scroll progress visibly updates');
          const process = page.locator('#proces');
          const steps = process.locator('.steps__item');
          const processStates = [];
          for (const index of [0, await steps.count() - 1]) {
            await steps.nth(index).scrollIntoViewIfNeeded();
            // Position each item near the viewport centre, where reading emphasis should respond.
            await steps.nth(index).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
            await wait(500);
            processStates.push(await process.evaluate(el => ({
              progress: el.dataset.processProgress,
              current: [...el.querySelectorAll('.steps__item')].findIndex(item => item.classList.contains('is-current')),
            })));
          }
          assert.ok(processStates.every(state => state.current >= 0), 'Process identifies a readable current step');
          assert.notDeepEqual(processStates[0], processStates[1], 'Process emphasis progresses as the reader scrolls');
          record.checks.scroll = { meterStart, meterEnd, processStates };
          await page.screenshot({ path: path.join(out, `${prefix}-process.png`) });
          await scrollPage(page);
          assert.deepEqual((await layoutState(page)).invisible, [], 'Scrolled main content is visible');
          const offscreen = await canvasState(page);
          await wait(500);
          const offscreenLater = await canvasState(page);
          assert.equal(offscreenLater.frames, offscreen.frames, 'Off-screen canvas stops rendering');
          assert.equal(offscreenLater.paused, 'true', 'Off-screen canvas reports paused state');
          record.checks.offscreen = { first: offscreen, second: offscreenLater };
          await page.evaluate(() => scrollTo(0, 600));
          await wait(500);
          await checkMenu(page, width, prefix);
        } else if (mode === 'reduced') {
          const initial = await canvasState(page);
          await wait(600);
          const later = await canvasState(page);
          assert.equal(initial.frames, 0, 'Reduced-motion mode starts no animation frames');
          assert.equal(later.frames, 0, 'Reduced-motion mode runs no animation loop');
          assert.equal(later.digest, initial.digest, 'Reduced-motion canvas remains static');
          await scrollPage(page);
          assert.deepEqual((await layoutState(page)).invisible, [], 'Reduced-motion content is visible');
          await page.evaluate(() => scrollTo(0, 0));
          await checkMenu(page, width, prefix);
          record.checks.staticArtwork = { initial, later };
          await page.screenshot({ path: path.join(out, `${prefix}-top.png`) });
        } else {
          // Browser automation can read DOM even when page-authored JavaScript is disabled.
          await scrollPage(page);
          const content = await layoutState(page);
          assert.ok(content.mainTextLength > 1500, 'Core page text is accessible without JavaScript');
          assert.deepEqual(content.invisible, [], 'No reveal styles hide main content without JavaScript');
          assert.equal(content.bodyReady, false, 'No JavaScript motion initialization runs');
          assert.equal(await page.locator('main a[href*="kontakt"]').first().isVisible(), true, 'Contact route remains available without JavaScript');
          await page.evaluate(() => scrollTo(0, 0));
          await page.screenshot({ path: path.join(out, `${prefix}-top.png`) });
          record.checks.fallback = content;
        }
        const finalLayout = await layoutState(page);
        assert.equal(finalLayout.overflow, false, 'No horizontal overflow after interaction');
        assert.equal(finalLayout.h1, 1, 'Exactly one main heading');
        assert.deepEqual(errors, [], 'No page JavaScript errors');
        record.layout = finalLayout;
        record.status = 'passed';
        console.log(`PASS ${prefix}`);
      } catch (error) {
        record.status = 'failed';
        record.error = error.stack || String(error);
        record.pageErrors = errors;
        failures.push(`${prefix}: ${error.message}`);
        if (page) await page.screenshot({ path: path.join(out, `${prefix}-failure.png`) }).catch(() => {});
        console.error(`FAIL ${prefix}: ${error.message}`);
      } finally {
        const video = page?.video();
        await context.close();
        if (video) {
          await video.saveAs(path.join(out, `${prefix}.webm`));
          record.video = `${prefix}.webm`;
        }
        results.push(record);
        writeFileSync(path.join(out, 'review.json'), JSON.stringify({ results, failures }, null, 2));
      }
    }
  }
  // A short, calm hero clip is separate from the full diagnostic recordings.
  const previewContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference', recordVideo: { dir: path.join(out, 'videos'), size: { width: 1440, height: 900 } } });
  await previewContext.route('**/*', route => route.request().method() === 'POST' ? route.abort() : route.continue());
  await previewContext.addInitScript(() => localStorage.setItem('theme-cookie-consent', JSON.stringify({ v: 1, t: Date.now(), consent: { analytics: false, marketing: false } })));
  const preview = await previewContext.newPage();
  await preview.goto(stack.site, { waitUntil: 'networkidle' });
  await preview.waitForFunction(() => Number(document.querySelector('canvas[data-particle-scene]')?.dataset.frames) >= 3);
  await wait(1200);
  await preview.mouse.move(440, 350, { steps: 25 });
  await wait(1000);
  await preview.mouse.move(750, 450, { steps: 30 });
  await wait(1000);
  for (let y = 0; y <= 300; y += 12) { await preview.evaluate(y => scrollTo(0, y), y); await wait(35); }
  await wait(700);
  for (let y = 300; y >= 0; y -= 12) { await preview.evaluate(y => scrollTo(0, y), y); await wait(35); }
  await wait(800);
  const previewVideo = preview.video();
  await previewContext.close();
  await previewVideo.saveAs(path.join(out, 'motion-preview.webm'));
} finally {
  await browser?.close();
  await stack.stop();
}
if (failures.length) process.exitCode = 1;
