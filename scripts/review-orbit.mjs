// Real browser QA of the rotating project gallery; mocked local services, no POSTs.
// OUT=/private/tmp/veyro-orbit node scripts/review-orbit.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startStack } from '../tests/harness.mjs';

const out = process.env.OUT ?? '/private/tmp/veyro-orbit';
mkdirSync(out, { recursive: true });
const results = [];
const failures = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const angleDistance = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const stack = await startStack({ minMonths: 0 });
let browser;

async function prepare(context, errors = []) {
  await context.route('**/*', route => route.request().method() === 'POST' ? route.abort() : route.continue());
  await context.addInitScript(() => localStorage.setItem('theme-cookie-consent', JSON.stringify({ v: 1, t: Date.now(), consent: { analytics: false, marketing: false } })));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  assert.equal((await page.goto(stack.site + '/#eksempler', { waitUntil: 'networkidle' })).status(), 200);
  await page.evaluate(() => document.fonts.ready);
  const gallery = page.locator('.project-gallery').first();
  const stage = gallery.locator('.project-gallery__stage');
  await stage.evaluate(el => scrollTo(0, el.getBoundingClientRect().top + scrollY - 150));
  await wait(700);
  await gallery.locator('img').evaluateAll(async images => Promise.all(images.filter(img => img.complete && img.naturalWidth).map(img => img.decode().catch(() => {}))));
  return { page, gallery, stage };
}

async function state(gallery) {
  return gallery.evaluate(el => {
    const galleryBounds = el.getBoundingClientRect();
    const planes = [...el.querySelectorAll('.project-gallery__plane')].map(plane => {
      const r = plane.getBoundingClientRect(), s = getComputedStyle(plane);
      const transforms = [];
      for (let node = plane; node && node !== el.parentElement; node = node.parentElement) {
        const transform = getComputedStyle(node).transform;
        if (transform !== 'none') transforms.push(transform);
      }
      return { href: plane.getAttribute('href'), x: r.x, y: r.y, relativeX: r.x - galleryBounds.x, relativeY: r.y - galleryBounds.y, width: r.width, height: r.height, area: r.width * r.height, transform: s.transform, transforms, opacity: Number(s.opacity), zIndex: s.zIndex, depth: plane.dataset.orbitDepth };
    });
    const front = planes.reduce((best, plane, i) => plane.opacity > .1 && plane.area > (planes[best]?.area || 0) ? i : best, 0);
    const rotation = el.dataset.rotation === undefined ? null : Number(el.dataset.rotation);
    return { rotation, ready: el.dataset.galleryOrbitReady, front: el.dataset.frontProject ?? front, inferredFront: front, planes, scrollY, scrollLeft: el.querySelector('.project-gallery__stage').scrollLeft, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
}

function movement(a, b, relative = false) {
  return Math.max(...a.planes.map((p, i) => Math.hypot((relative ? p.relativeX : p.x) - (relative ? b.planes[i].relativeX : b.planes[i].x), (relative ? p.relativeY : p.y) - (relative ? b.planes[i].relativeY : b.planes[i].y)) + Math.abs(p.width - b.planes[i].width)));
}

async function screenshot(gallery, name) {
  return gallery.screenshot({ path: path.join(out, name), style: '.section-header { visibility: hidden !important; }' });
}

async function drag(page, stage, direction = -1, touch = false) {
  const r = await stage.boundingBox();
  const y = Math.max(180, Math.min(800, r.y + r.height * .5));
  const start = direction < 0 ? r.x + r.width * .79 : r.x + r.width * .21;
  const end = direction < 0 ? r.x + r.width * .21 : r.x + r.width * .79;
  if (touch) {
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y }] });
    for (let i = 1; i <= 22; i++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start + (end - start) * i / 22, y }] });
      await wait(20);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await client.detach();
  } else {
    await page.mouse.move(start, y);
    await page.mouse.down();
    await page.mouse.move(end, y, { steps: 35 });
    await page.mouse.up();
  }
  await wait(500);
}

async function swipeAll(page, stage, gallery) {
  const client = await page.context().newCDPSession(page);
  const seen = new Set();
  const observe = () => stage.evaluate(el => {
    const r = el.getBoundingClientRect(), midpoint = r.x + r.width / 2;
    return [...el.querySelectorAll('.project-gallery__plane')].map((p, i) => ({ i, r: p.getBoundingClientRect() })).sort((a, b) => Math.abs(a.r.x + a.r.width / 2 - midpoint) - Math.abs(b.r.x + b.r.width / 2 - midpoint))[0].i;
  });
  await stage.evaluate(el => el.scrollTo({ left: 0, behavior: 'instant' }));
  await wait(500);
  seen.add(await observe());
  for (let swipe = 0; swipe < 3 && seen.size < 3; swipe++) {
    const r = await stage.boundingBox();
    const y = Math.max(180, Math.min(800, r.y + r.height * .5));
    const start = Math.min(365, r.x + r.width * .86), end = Math.max(25, r.x + r.width * .14);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y }] });
    for (let i = 1; i <= 14; i++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start + (end - start) * i / 14, y }] });
      await wait(20);
    }
    await wait(200); // A deliberate release avoids a fast fling skipping the middle card.
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(700);
    seen.add(await observe());
    await screenshot(gallery, `mobile-swipe-${swipe + 1}.png`);
  }
  await client.detach();
  assert.equal(seen.size, 3, 'Native horizontal swipes expose all three project cards');
  return [...seen];
}

try {
  browser = await chromium.launch();
  for (const width of (process.env.WIDTHS ? process.env.WIDTHS.split(',').map(Number) : [1440, 390])) {
    for (const mode of (process.env.MODES ? process.env.MODES.split(',') : ['normal', 'reduced', 'no-js'])) {
      const record = { width, mode, status: 'running', checks: {} };
      const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 990, isMobile: width < 990, javaScriptEnabled: mode !== 'no-js', reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
      let page;
      const errors = [];
      try {
        const prepared = await prepare(context, errors);
        page = prepared.page;
        const { gallery, stage } = prepared;
        assert.equal(await gallery.locator('.project-gallery__plane').count(), 3, 'Three actual demo links remain present');
        const broken = await gallery.locator('img').evaluateAll(images => images.filter(img => img.complete && !img.naturalWidth).map(img => img.src));
        assert.deepEqual(broken, [], 'Project preview images load');
        assert.equal((await state(gallery)).overflow, false, 'No horizontal page overflow');
        if (mode === 'normal') {
          await page.waitForSelector('.project-gallery[data-gallery-orbit-ready="true"]');
          await page.waitForFunction(() => [...document.querySelectorAll('.project-gallery img')].every(img => img.complete && img.naturalWidth));
          const a = await state(gallery);
          const imageA = await page.screenshot({ path: path.join(out, `orbit-${width}-frame-a.png`), style: '.section-header { visibility: hidden !important; }' });
          await wait(1200);
          const b = await state(gallery);
          const imageB = await page.screenshot({ path: path.join(out, `orbit-${width}-frame-b.png`), style: '.section-header { visibility: hidden !important; }' });
          assert.ok(Math.abs(a.scrollY - b.scrollY) <= 1, 'The gallery moves with no scroll input (allowing pixel rounding)');
          assert.ok(movement(a, b) > 2, 'Visible project geometry changes over time');
          assert.notEqual(hash(imageA), hash(imageB), 'Rendered gallery pixels change over time');
          assert.ok(Number.isFinite(a.rotation) && Number.isFinite(b.rotation), 'Gallery exposes a numeric rotation angle');
          assert.ok(angleDistance(a.rotation, b.rotation) > .1, 'Automatic orbit advances its rotation');
          record.checks.auto = { before: a, after: b, movement: movement(a, b), pixelsChanged: true };
          const beforeDrag = await state(gallery);
          await drag(page, stage, -1, width < 990);
          const afterDrag = await state(gallery);
          assert.ok(angleDistance(beforeDrag.rotation, afterDrag.rotation) > 15, 'Dragging rotates the project orbit');
          if (beforeDrag.front === afterDrag.front) await drag(page, stage, -1, width < 990);
          const dragged = await state(gallery);
          assert.notEqual(dragged.front, beforeDrag.front, 'Dragging brings a different project to the front');
          await wait(700);
          const afterDragSettled = await state(gallery);
          assert.ok(angleDistance(afterDragSettled.rotation, dragged.rotation) > .1, 'Automatic motion resumes after dragging');
          record.checks.drag = { before: beforeDrag, after: dragged, resumed: afterDragSettled };
          await screenshot(gallery, `orbit-${width}-dragged.png`);
          const next = gallery.locator('[data-gallery-next]');
          const previous = gallery.locator('[data-gallery-prev]');
          assert.equal(await next.isVisible(), true, 'Next-project control is available');
          assert.equal(await previous.isVisible(), true, 'Previous-project control is available');
          assert.ok((await next.getAttribute('aria-label')) || (await next.innerText()).trim(), 'Next-project control has an accessible label');
          const beforeNext = await state(gallery);
          await next.click(); await wait(800);
          const afterNext = await state(gallery);
          assert.ok(angleDistance(beforeNext.rotation, afterNext.rotation) > 20, 'Next control turns the gallery to another project');
          await previous.click(); await wait(800);
          const afterPrevious = await state(gallery);
          assert.ok(angleDistance(afterNext.rotation, afterPrevious.rotation) > 20, 'Previous control turns the gallery back');
          const localPause = gallery.locator('[data-gallery-pause]');
          await localPause.click(); await wait(150);
          const locallyPaused = await state(gallery);
          await wait(700);
          const locallyPausedLater = await state(gallery);
          assert.ok(angleDistance(locallyPaused.rotation, locallyPausedLater.rotation) < .01, 'Gallery pause keeps its current angle');
          assert.ok(movement(locallyPaused, locallyPausedLater) < .5, 'Gallery pause freezes the visible planes');
          await localPause.click(); await wait(600);
          const locallyResumed = await state(gallery);
          assert.ok(angleDistance(locallyResumed.rotation, locallyPausedLater.rotation) > .1, 'Gallery pause control resumes rotation');
          record.checks.controls = { beforeNext, afterNext, afterPrevious, locallyPaused, locallyPausedLater, locallyResumed };
          const pause = page.locator('[data-motion-toggle]');
          const galleryScroll = await page.evaluate(() => scrollY);
          await pause.click();
          await page.evaluate(y => scrollTo(0, y), galleryScroll);
          await wait(150);
          const paused = await state(gallery);
          await wait(800);
          const pausedLater = await state(gallery);
          record.checks.pause = { paused, pausedLater };
          assert.ok(angleDistance(paused.rotation, pausedLater.rotation) < .01, 'Global pause freezes gallery rotation');
          assert.ok(movement(paused, pausedLater, true) < .5, 'Paused planes remain visually still relative to the gallery');
          assert.deepEqual(paused.planes.map(p => p.transforms), pausedLater.planes.map(p => p.transforms), 'Pause preserves the actual CSS 3D pose');
          await pause.click();
          await page.evaluate(y => scrollTo(0, y), galleryScroll);
          await wait(700);
          const resumed = await state(gallery);
          assert.ok(angleDistance(resumed.rotation, pausedLater.rotation) > .1, 'Global resume restarts rotation');
          record.checks.pause = { paused, pausedLater, resumed };
        } else {
          const a = await state(gallery);
          await wait(1100);
          const b = await state(gallery);
          assert.ok(movement(a, b) < .5, `${mode}/${width}: fallback does not auto-spin`);
          if (a.rotation !== null && b.rotation !== null) assert.ok(angleDistance(a.rotation, b.rotation) < .01, 'Fallback rotation remains static');
          record.checks.static = { before: a, after: b };
          if (width < 990) {
            record.checks.swipe = await swipeAll(page, stage, gallery);
            await page.waitForFunction(() => [...document.querySelectorAll('.project-gallery img')].every(img => img.complete && img.naturalWidth));
          }
          await screenshot(gallery, `gallery-${mode}-${width}.png`);
        }
        assert.equal((await state(gallery)).overflow, false, 'No overflow after interactions');
        assert.deepEqual(errors, [], 'No JavaScript errors');
        assert.ok((await gallery.innerText()).includes('Fiktive designkoncepter'), 'Fictional demos remain labelled');
        record.status = 'passed';
        console.log(`PASS orbit ${width} ${mode}`);
      } catch (error) {
        record.status = 'failed'; record.error = error.stack || String(error); record.pageErrors = errors;
        failures.push(`${width}/${mode}: ${error.message}`);
        console.error(`FAIL orbit ${width} ${mode}: ${error.message}`);
        await page?.screenshot({ path: path.join(out, `failure-${mode}-${width}.png`) }).catch(() => {});
      } finally {
        await context.close(); results.push(record);
        writeFileSync(path.join(out, 'review.json'), JSON.stringify({ results, failures }, null, 2));
      }
    }
  }
  // Short proof clip focuses on the work section, with auto-spin followed by a real drag.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference', recordVideo: { dir: path.join(out, 'videos'), size: { width: 1440, height: 1000 } } });
  const { page, gallery, stage } = await prepare(context);
  await page.waitForSelector('.project-gallery[data-gallery-orbit-ready]');
  await wait(2500);
  await drag(page, stage);
  await wait(3000);
  await screenshot(gallery, 'orbit-delivery.png');
  const video = page.video();
  await context.close();
  await video.saveAs(path.join(out, 'orbit-preview.webm'));
} finally {
  await browser?.close(); await stack.stop();
}
if (failures.length) process.exitCode = 1;
