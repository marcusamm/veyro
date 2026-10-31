// Local browser QA for the interactive plan chooser; no real messages or payments.
// OUT=/private/tmp/veyro-plan-review node scripts/review-plan-picker.mjs
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startStack } from '../tests/harness.mjs';

const out = process.env.OUT ?? '/private/tmp/veyro-plan-review';
const widths = process.env.WIDTHS ? process.env.WIDTHS.split(',').map(Number) : [390, 768, 1440];
const modes = process.env.MODES ? process.env.MODES.split(',') : ['interactive', 'no-js'];
const paths = process.env.PATHS ? process.env.PATHS.split(',') : ['/', '/pages/priser'];
const expected = [
  { title: 'Hjemmeside', price: '199', key: 'hjemmeside' },
  { title: 'Booking', price: '299', key: 'booking' },
  { title: 'Webshop', price: '299', key: 'webshop' },
];
const results = [];
const failures = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
mkdirSync(out, { recursive: true });
const stack = await startStack({ minMonths: 0 });
let browser;

async function scrollAll(page) {
  const { height, step } = await page.evaluate(() => ({ height: document.body.scrollHeight, step: innerHeight * .7 }));
  for (let y = 0; y < height; y += step) {
    await page.evaluate(y => scrollTo(0, y), y);
    await wait(35);
  }
}

async function layout(page) {
  return page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    h1: document.querySelectorAll('main h1').length,
    brokenImages: [...document.images].filter(img => img.currentSrc && img.complete && !img.naturalWidth).map(img => img.currentSrc),
  }));
}

async function contrast(picker) {
  return picker.evaluate(root => {
    const rgba = text => {
      const parts = text.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    };
    const composite = (top, bottom) => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (!a) return [0, 0, 0, 0];
      return [0, 1, 2].map(i => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a);
    };
    const background = element => {
      const nodes = [];
      for (let el = element; el; el = el.parentElement) nodes.push(el);
      return nodes.reverse().reduce((color, el) => composite(rgba(getComputedStyle(el).backgroundColor), color), [255, 255, 255, 1]);
    };
    const luminance = color => color.slice(0, 3).map(v => {
      v /= 255;
      return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    return [...root.querySelectorAll('.pc__name,.pc__desc,.pc__vat,.pc__interval,.pc__list li,.pc__select-text,[data-summary-title],[data-summary-price]')].filter(el => {
      if (el.closest('[hidden],details:not([open])')) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
    }).map(el => {
      const style = getComputedStyle(el);
      const bg = background(el);
      const fg = composite(rgba(style.color), bg);
      const a = luminance(fg), b = luminance(bg);
      const size = parseFloat(style.fontSize), weight = parseFloat(style.fontWeight);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      return {
        text: el.textContent.trim().slice(0, 100),
        selected: !!el.closest('.is-selected'),
        ratio: Number(((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toFixed(2)),
        minimum: large ? 3 : 4.5,
        color: style.color,
        background: bg.map(v => Math.round(v)),
      };
    });
  });
}

async function chooseCard(card) {
  const radio = card.locator('[data-plan-radio]');
  const label = await radio.evaluate(input => input.labels?.[0]?.getAttribute('for'));
  if (label) await card.locator(`label[for=${JSON.stringify(label)}]`).click();
  else {
    const wrappingLabel = radio.locator('xpath=ancestor::label[1]');
    assert.equal(await wrappingLabel.count(), 1, 'Each radio has a clickable associated label');
    await wrappingLabel.click();
  }
}

async function assertSelection(picker, item) {
  await picker.locator('[data-summary-title]').waitFor();
  await picker.page().waitForFunction(({ rootId, title }) => {
    const root = rootId ? document.getElementById(rootId) : document.querySelector('[data-plan-picker]');
    return root?.querySelector('[data-summary-title]')?.textContent.trim() === title;
  }, { rootId: await picker.getAttribute('id'), title: item.title });
  assert.equal((await picker.locator('[data-summary-title]').innerText()).trim(), item.title);
  assert.match(await picker.locator('[data-summary-price]').innerText(), new RegExp(`(^|\\D)${item.price}(\\D|$)`));
  assert.equal(await picker.locator('[data-plan-radio]:checked').count(), 1, 'Exactly one plan is selected');
  assert.equal(await picker.locator('.pc.is-selected').count(), 1, 'Exactly one card carries selected styling');
  const selected = picker.locator('.pc.is-selected');
  assert.equal((await selected.locator('.pc__name').innerText()).trim(), item.title);
  assert.match(await selected.locator('.pc__price').innerText(), /ekskl\. moms/);
  const href = await picker.locator('[data-summary-link]').getAttribute('href');
  assert.match(href, new RegExp(`ydelse=pakke-${item.key}(?:&|#|$)`));
  assert.ok(href.endsWith('#formular'), 'Summary leads to the contact form');
  return { title: item.title, price: await picker.locator('[data-summary-price]').innerText(), href };
}

try {
  browser = await chromium.launch();
  for (const width of widths) for (const mode of modes) for (const url of paths) {
    const slug = url === '/' ? 'forside' : 'priser';
    const record = { width, mode, url, status: 'running', selections: [] };
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', javaScriptEnabled: mode !== 'no-js' });
    const page = await context.newPage();
    const errors = [];
    let attemptedPosts = 0;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      if (route.request().method() === 'POST') { attemptedPosts++; return route.abort(); }
      return route.continue();
    });
    await context.addInitScript(() => localStorage.setItem('theme-cookie-consent', JSON.stringify({ v: 1, t: Date.now(), consent: { analytics: false, marketing: false } })));
    try {
      const response = await page.goto(stack.site + url, { waitUntil: 'networkidle' });
      assert.equal(response.status(), 200, 'Page responds successfully');
      await page.evaluate(() => document.fonts.ready);
      await scrollAll(page);
      const picker = page.locator('[data-plan-picker]').first();
      assert.equal(await picker.count(), 1, 'Page contains the plan chooser');
      const cards = picker.locator('.pc[data-plan-card]');
      assert.equal(await cards.count(), 3, 'Three currently available plans are selectable');
      record.cardLayout = await picker.locator('.pc-grid').evaluate(grid => ({
        columns: getComputedStyle(grid).gridTemplateColumns,
        listWidth: grid.getBoundingClientRect().width,
        cardWidth: grid.querySelector('[data-plan-card]').getBoundingClientRect().width,
      }));
      assert.ok(record.cardLayout.cardWidth >= record.cardLayout.listWidth - 2, 'Plan cards form full-width vertical rows, rather than inheriting the old three-column grid');
      await picker.scrollIntoViewIfNeeded();
      if (mode === 'interactive') {
        for (let i = 0; i < expected.length; i++) {
          await chooseCard(cards.nth(i));
          record.selections.push(await assertSelection(picker, expected[i]));
          const ratios = await contrast(picker);
          const failures = ratios.filter(item => item.ratio < item.minimum);
          assert.deepEqual(failures, [], 'Selected and unselected plan text has readable solid-background contrast');
          record.contrast = ratios;
          await page.locator('.packages').first().screenshot({ path: path.join(out, `${slug}-${expected[i].key}-${width}.png`), style: '.section-header { visibility: hidden !important; }' });
        }
        await chooseCard(cards.nth(0));
        await cards.nth(0).locator('[data-plan-radio]').focus();
        await page.keyboard.press('ArrowDown');
        await assertSelection(picker, expected[1]);
        record.keyboard = 'ArrowDown selects Booking and updates summary';
        const contactHref = await picker.locator('[data-summary-link]').getAttribute('href');
        const contact = await context.newPage();
        await contact.goto(stack.site + contactHref, { waitUntil: 'networkidle' });
        assert.equal(await contact.locator('select[name="contact[Ydelse]"]').inputValue(), 'Pakke: Booking', 'Selected plan is passed through to the inquiry');
        await contact.close();
      } else {
        const summary = picker.locator('[data-plan-summary]');
        assert.equal((await summary.locator('[data-summary-title]').innerText()).trim(), 'Hjemmeside', 'No-JS summary shows the initial plan');
        for (let i = 0; i < expected.length; i++) {
          const card = cards.nth(i);
          assert.equal(await card.locator('.pc__actions a[href*="kontakt"]').first().isVisible(), true, 'Each plan remains contactable without JS');
          const labelHidden = await card.locator('[data-plan-radio]').evaluate(input => {
            const label = input.labels?.[0];
            return !!label && (!!label.closest('[hidden]') || getComputedStyle(label).display === 'none' || getComputedStyle(label).visibility === 'hidden');
          });
          assert.equal(labelHidden, true, 'Nonfunctional selection UI is hidden without JS');
        }
        record.fallback = 'Contact links visible; static initial summary; selection controls hidden';
        await page.locator('.packages').first().screenshot({ path: path.join(out, `${slug}-no-js-${width}.png`), style: '.section-header { visibility: hidden !important; }' });
      }
      if (url === '/' && await page.locator('.project-gallery').count()) {
        const gallery = page.locator('.project-gallery').first();
        await gallery.scrollIntoViewIfNeeded();
        // Touch layouts deliberately keep unseen planes lazy until swiped into view.
        // Exercise that native horizontal scrolling before checking every preview.
        const galleryImages = gallery.locator('img');
        for (let i = 0; i < await galleryImages.count(); i++) {
          await galleryImages.nth(i).scrollIntoViewIfNeeded();
          const deadline = Date.now() + 10000;
          for (;;) {
            const image = await galleryImages.nth(i).evaluate(img => ({ complete: img.complete, width: img.naturalWidth, src: img.currentSrc }));
            if (image.complete && image.width > 0) break;
            assert.ok(Date.now() < deadline, `Preview did not load: ${image.src}`);
            await wait(100); // Node drives the wait so it also works with page JS disabled.
          }
        }
        await galleryImages.first().scrollIntoViewIfNeeded();
        const shots = await gallery.locator('img').evaluateAll(images => images.map(img => ({ src: img.currentSrc, loaded: img.complete && img.naturalWidth > 0 })));
        assert.ok(shots.length >= 3, 'Gallery includes three demo previews');
        assert.ok(shots.every(shot => shot.loaded), 'Gallery previews load');
        record.galleryImages = shots;
        await gallery.screenshot({ path: path.join(out, `gallery-${mode}-${width}.png`), style: '.section-header { visibility: hidden !important; }' });
      }
      record.layout = await layout(page);
      assert.equal(record.layout.overflow, false, 'No horizontal overflow');
      assert.equal(record.layout.h1, 1, 'Single main heading');
      assert.deepEqual(record.layout.brokenImages, [], 'No broken images');
      assert.equal(attemptedPosts, 0, 'No form or payment POST is attempted');
      assert.deepEqual(errors, [], 'No JavaScript runtime errors');
      record.status = 'passed';
      console.log(`PASS ${mode} ${width} ${url}`);
    } catch (error) {
      record.status = 'failed';
      record.error = error.stack || String(error);
      record.pageErrors = errors;
      failures.push(`${mode} ${width} ${url}: ${error.message}`);
      await page.screenshot({ path: path.join(out, `${slug}-${mode}-${width}-failure.png`), fullPage: true }).catch(() => {});
      console.error(`FAIL ${mode} ${width} ${url}: ${error.message}`);
    } finally {
      results.push(record);
      writeFileSync(path.join(out, 'review.json'), JSON.stringify({ results, failures }, null, 2));
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await stack.stop();
}
if (failures.length) process.exitCode = 1;
