// Browser-level contrast checks for the public dark contact form. No live POSTs.
// OUT=/private/tmp/veyro-form-contrast node scripts/review-form-contrast.mjs
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startStack } from '../tests/harness.mjs';

const out = process.env.OUT ?? '/private/tmp/veyro-form-contrast';
mkdirSync(out, { recursive: true });
const results = [];
const stack = await startStack({ minMonths: 0 });
const browser = await chromium.launch();

async function colors(locator, pseudo = null) {
  return locator.evaluate((el, pseudo) => {
    const style = getComputedStyle(el, pseudo);
    const input = getComputedStyle(el);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const rgba = color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const foreground = rgba(style.webkitTextFillColor || style.color);
    const background = rgba(pseudo ? input.backgroundColor : style.backgroundColor);
    const luminance = rgb => rgb.slice(0, 3).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
    const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
    return { foreground, background, contrast: ratio(foreground, background), borderContrast: ratio(rgba(input.borderColor), background), colorScheme: input.colorScheme, outline: input.outlineStyle, outlineContrast: ratio(rgba(input.outlineColor), background) };
  }, pseudo);
}

try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    await context.route('**/*', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    await context.addInitScript(() => localStorage.setItem('theme-cookie-consent', JSON.stringify({ v: 1, t: Date.now(), consent: { analytics: false, marketing: false } })));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    try {
      const response = await page.goto(stack.site + '/pages/kontakt?ydelse=pakke-booking#formular', { waitUntil: 'networkidle' });
      assert.equal(response.status(), 200);
      await page.evaluate(() => document.fonts.ready);
      const form = page.locator('.contact form').first();
      const name = form.locator('input[name="contact[name]"]');
      const select = form.locator('select[name="contact[Ydelse]"]');
      const textarea = form.locator('textarea');
      assert.equal(await select.inputValue(), 'Pakke: Booking', 'The chosen service is preserved');
      await name.fill('Marcus — kontrastkontrol');
      await textarea.fill('En lokal visuel kontrol af formularens tekst og felter.');
      const readings = {};
      for (const [kind, field] of [['input', name], ['select', select], ['textarea', textarea]]) {
        readings[kind] = await colors(field);
        assert.ok(readings[kind].contrast >= 4.5, `${kind}: entered/selected text must be readable`);
        assert.ok(readings[kind].borderContrast >= 3, `${kind}: control boundary must be readable`);
        assert.equal(readings[kind].colorScheme, 'dark', `${kind}: native control uses dark color scheme`);
      }
      readings.option = await colors(select.locator('option').nth(1));
      assert.ok(readings.option.contrast >= 4.5, 'Native option colors are readable');
      await name.fill('');
      readings.placeholder = await colors(name, '::placeholder');
      assert.ok(readings.placeholder.contrast >= 4.5, 'Placeholder text is readable');
      await select.focus();
      readings.focus = await colors(select);
      assert.notEqual(readings.focus.outline, 'none', 'Select keyboard focus has a visible outline');
      assert.ok(readings.focus.outlineContrast >= 3, 'Focus outline has enough contrast');
      await select.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `selected-service-${width}.png`) });
      await name.evaluate(el => { el.disabled = true; });
      readings.disabled = await colors(name);
      assert.ok(readings.disabled.contrast >= 4.5, 'Disabled field text stays readable');
      await name.evaluate(el => { el.disabled = false; });
      const consent = form.locator('input[type="checkbox"]');
      await consent.check();
      assert.equal(await consent.isChecked(), true, 'Consent checkbox remains operable');
      await consent.uncheck();
      await textarea.fill('');
      await form.locator('button[type="submit"]').click();
      const summary = form.locator('[data-error-summary]');
      assert.equal(await summary.isVisible(), true, 'Required-field error summary is visible');
      readings.error = await colors(summary.locator('.form__error-title'));
      const errorContrast = await summary.evaluate(el => {
        const title = el.querySelector('.form__error-title');
        const context = document.createElement('canvas').getContext('2d');
        const rgb = color => { context.clearRect(0,0,1,1); context.fillStyle = color; context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data].slice(0,3); };
        const l = color => rgb(color).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n+.055)/1.055)**2.4).reduce((a,n,i)=>a+n*[.2126,.7152,.0722][i],0);
        const a = l(getComputedStyle(title).color), b = l(getComputedStyle(el).backgroundColor);
        return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      });
      assert.ok(errorContrast >= 4.5, 'Error heading is readable against the summary background');
      readings.error.contrastAgainstSummary = errorContrast;
      await page.screenshot({ path: path.join(out, `form-errors-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No horizontal overflow');
      assert.deepEqual(errors, [], 'No JavaScript errors');
      results.push({ width, status: 'passed', readings });
      console.log(`PASS form contrast ${width}px`);
    } catch (error) {
      results.push({ width, status: 'failed', error: error.stack || String(error), pageErrors: errors });
      await page.screenshot({ path: path.join(out, `failure-${width}.png`) }).catch(() => {});
      process.exitCode = 1;
      console.error(`FAIL form contrast ${width}px: ${error.message}`);
    } finally {
      await context.close();
      writeFileSync(path.join(out, 'review.json'), JSON.stringify(results, null, 2));
    }
  }
} finally {
  await browser.close();
  await stack.stop();
}
