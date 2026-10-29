// Run the real theme and audio modules in Chromium. No server, audio mocks or network access.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

const asset = (name) => readFileSync(fileURLToPath(new URL(`../site/theme/assets/${name}`, import.meta.url)), 'utf8');
const inline = (source) => source.replace(/<\/script/gi, '<\\/script');
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 16px; font: 16px sans-serif; } button, input, select, summary, a { margin: 8px; }
  button, summary, a { display: inline-block; padding: 10px; } details { margin: 12px 0; }
  .faq__answer { padding: 12px 0 24px; } [hidden] { display: none !important; }
</style><script id="ThemeStrings" type="application/json">{}</script>
<script>${inline(asset('theme.js'))}</script><script>${inline(asset('interaction-audio.js'))}</script>
</head><body class="has-motion">
<header data-header><button data-sound-toggle hidden aria-pressed="false">Sound</button></header>
<main>
  <button id="ordinary">Ordinary action</button><a id="link" href="#destination">Anchor action</a>
  <button id="disabled" disabled>Unavailable action</button><button id="aria-disabled" aria-disabled="true">Unavailable semantic action</button>
  <label for="choice">Choice label</label><input id="choice" type="checkbox">
  <label for="first">First plan</label><input id="first" type="radio" name="plan" checked>
  <label for="second">Second plan</label><input id="second" type="radio" name="plan">
  <select id="service" aria-label="Service"><option value="website">Website</option><option value="booking">Booking</option></select>
  <button id="self-disabling">Submit-like action</button>
  <div id="cancelled"><button id="dragged">Cancelled gallery activation</button></div>
  <details id="native"><summary>Native section</summary><p>Native contents</p></details>
  <details id="package" class="pc__scope"><summary>Package contents</summary><p>Included features</p></details>
  <details id="toc" class="doc__toc-box"><summary>Contents list</summary><p>Document links</p></details>
  <details id="animated" class="faq__item"><summary>Animated FAQ</summary><div class="faq__answer"><p>A real answer with enough height for the theme animation.</p></div></details>
  <div id="destination">Anchor destination</div>
</main>
<script>
  document.getElementById('self-disabling').addEventListener('click', event => { event.currentTarget.disabled = true; });
  document.getElementById('cancelled').addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); }, true);
</script></body></html>`;

let browser;
const sessions = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterEach(async () => {
  const active = sessions.splice(0);
  await Promise.all(active.map(async ({ context, errors, requests }) => {
    await context.close();
    expect(errors, 'No uncaught browser errors').toEqual([]);
    expect(requests, 'All external requests are blocked; the fixture needs none').toEqual([]);
  }));
});
afterAll(async () => { await browser?.close(); });

async function mount({ touch = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: touch ? 390 : 1100, height: 900 },
    hasTouch: touch,
    isMobile: touch,
    reducedMotion: 'no-preference',
  });
  const errors = [], requests = [];
  sessions.push({ context, errors, requests });
  // These wrappers delegate to real native methods and inspect the buffers that
  // actually start. No replacement AudioContext, oscillator or fabricated cues.
  await context.addInitScript(() => {
    window.audioStarts = [];
    window.audioStops = [];
    window.nativeAudioContexts = [];
    const Audio = window.AudioContext || window.webkitAudioContext;
    const create = Audio.prototype.createBufferSource;
    Audio.prototype.createBufferSource = function (...args) {
      if (!window.nativeAudioContexts.includes(this)) window.nativeAudioContexts.push(this);
      const source = create.apply(this, args);
      const start = source.start, stop = source.stop;
      source.start = function (...startArgs) {
        const buffer = this.buffer;
        const pcm = buffer.getChannelData(0);
        let peak = 0, energy = 0;
        for (const sample of pcm) { peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; }
        window.audioStarts.push({ duration: buffer.duration, frames: buffer.length, rate: buffer.sampleRate, peak, energy, state: source.context.state });
        return start.apply(this, startArgs);
      };
      source.stop = function (...stopArgs) {
        window.audioStops.push({ duration: this.buffer?.duration });
        return stop.apply(this, stopArgs);
      };
      return source;
    };
  });
  await context.route('**/*', async (route) => {
    if (route.request().url() === 'https://interaction-audio.test/' && route.request().method() === 'GET') {
      return route.fulfill({ contentType: 'text/html', body: fixture });
    }
    requests.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('https://interaction-audio.test/');
  await page.locator('[data-sound-toggle]:not([hidden])').waitFor();
  return page;
}

const starts = (page) => page.evaluate(() => window.audioStarts);
const clear = (page) => page.evaluate(() => { window.audioStarts.length = 0; window.audioStops.length = 0; });
async function expectCues(page, durations) {
  await expect.poll(async () => (await starts(page)).map(cue => Number(cue.duration.toFixed(3)))).toEqual(durations);
  const cues = await starts(page);
  for (const cue of cues) {
    expect(cue.frames).toBeGreaterThan(0);
    expect(cue.frames / cue.rate).toBeCloseTo(cue.duration, 6);
    expect(cue.peak, 'A real non-silent PCM buffer was started').toBeGreaterThan(.001);
    expect(cue.peak, 'PCM remains finite and unclipped').toBeLessThan(1);
    expect(cue.energy).toBeGreaterThan(0);
    expect(cue.state).toBe('running');
  }
}
async function enable(page, { tap = false } = {}) {
  const button = page.locator('[data-sound-toggle]');
  if (tap) await button.tap(); else await button.click();
  await expectCues(page, [.045]);
  expect(await button.getAttribute('aria-pressed')).toBe('true');
  await clear(page);
}
async function clickUnavailable(page, selector) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

describe('Optional interaction audio through real browser activation', () => {
  it('starts silent, enables once, and produces a real short PCM cue', async () => {
    const page = await mount();
    expect(await page.locator('[data-sound-toggle]').getAttribute('aria-pressed')).toBe('false');
    await page.locator('#ordinary').click();
    await page.locator('#native > summary').click();
    expect(await starts(page)).toEqual([]);
    await enable(page);
    await page.locator('#ordinary').click();
    await expectCues(page, [.045]);
    await page.waitForTimeout(40);
    expect(await starts(page)).toHaveLength(1);
  });

  it('gives native package, TOC and section toggles one distinct open/close cue', async () => {
    const page = await mount();
    await enable(page);
    const expected = [];
    for (const id of ['native', 'package', 'toc']) {
      const summary = page.locator(`#${id} > summary`);
      await summary.click();
      expected.push(.12);
      await expectCues(page, expected);
      expect(await page.locator(`#${id}`).evaluate(element => element.open)).toBe(true);
      await summary.press('Enter');
      expected.push(.10);
      await expectCues(page, expected);
      expect(await page.locator(`#${id}`).evaluate(element => element.open)).toBe(false);
    }
    await page.waitForTimeout(40);
    expect(await starts(page)).toHaveLength(6);
  });

  it('follows the real animated FAQ state, including a close reversed before animation ends', async () => {
    const page = await mount();
    await enable(page);
    const item = page.locator('#animated'), summary = item.locator('summary');
    expect(await item.getAttribute('data-faq-ready')).toBe('true');
    await summary.click();
    await expectCues(page, [.12]);
    await summary.click();
    await expectCues(page, [.12, .10]);
    expect(await item.evaluate(element => element.open && element.classList.contains('is-closing'))).toBe(true);
    await summary.click();
    await expectCues(page, [.12, .10, .12]);
    await expect.poll(() => item.evaluate(element => element.open && !element.classList.contains('is-closing'))).toBe(true);
    await page.waitForTimeout(250);
    expect(await starts(page)).toHaveLength(3);
    expect(await item.evaluate(element => element.open)).toBe(true);
    await summary.press('Space');
    await expectCues(page, [.12, .10, .12, .10]);
    await expect.poll(() => item.evaluate(element => element.open)).toBe(false);
    expect(await starts(page)).toHaveLength(4);
  });

  it('covers keyboard and choice controls once while excluding disabled and cancelled activations', async () => {
    const page = await mount();
    await enable(page);
    const expected = [];
    const clickCue = async (action) => { await action(); expected.push(.045); await expectCues(page, expected); };
    await clickCue(() => page.locator('#ordinary').press('Enter'));
    await clickCue(() => page.locator('#ordinary').press('Space'));
    await clickCue(() => page.locator('#link').press('Enter'));
    await clickUnavailable(page, '#disabled');
    await clickUnavailable(page, '#aria-disabled');
    await page.locator('#dragged').click();
    await page.waitForTimeout(30);
    expect(await starts(page)).toHaveLength(3);
    await clickCue(() => page.locator('label[for="choice"]').click());
    expect(await page.locator('#choice').isChecked()).toBe(true);
    await page.locator('#first').focus();
    await clickCue(() => page.keyboard.press('ArrowRight'));
    expect(await page.locator('#second').isChecked()).toBe(true);
    // The OS-backed select popup is not exposed by headless macOS Chromium.
    // Select through its native browser control; keyboard activation is covered above.
    await clickCue(() => page.locator('#service').selectOption('booking'));
    expect(await page.locator('#service').inputValue()).toBe('booking');
    await clickCue(() => page.locator('#self-disabling').click());
    expect(await page.locator('#self-disabling').isDisabled()).toBe(true);
    await page.waitForTimeout(40);
    expect(await starts(page)).toHaveLength(expected.length);
  });

  it('handles real touch taps and preserves opt-in across reload without an automatic sound', async () => {
    const page = await mount({ touch: true });
    await enable(page, { tap: true });
    await page.locator('#ordinary').tap();
    await expectCues(page, [.045]);
    await page.locator('label[for="choice"]').tap();
    await expectCues(page, [.045, .045]);
    await page.reload();
    await page.locator('[data-sound-toggle]:not([hidden])').waitFor();
    expect(await page.locator('[data-sound-toggle]').getAttribute('aria-pressed')).toBe('true');
    expect(await starts(page)).toEqual([]);
    await page.locator('#native > summary').tap();
    await expectCues(page, [.12]);
    expect(await page.locator('#native').evaluate(element => element.open)).toBe(true);
  });

  it('resumes a genuinely suspended context and muting stops active voices and survives reload', async () => {
    const page = await mount();
    await enable(page);
    await page.evaluate(async () => { await Promise.all(window.nativeAudioContexts.map(context => context.suspend())); });
    expect(await page.evaluate(() => window.nativeAudioContexts[0].state)).toBe('suspended');
    await page.locator('#ordinary').click();
    await expectCues(page, [.045]);
    await clear(page);
    await page.locator('#native > summary').click();
    await expectCues(page, [.12]);
    // Freeze the real 120 ms voice so the mute assertion cannot race its natural end.
    await page.evaluate(async () => { await Promise.all(window.nativeAudioContexts.map(context => context.suspend())); });
    await page.locator('[data-sound-toggle]').click();
    expect(await page.locator('[data-sound-toggle]').getAttribute('aria-pressed')).toBe('false');
    expect(await page.evaluate(() => window.audioStops.length)).toBeGreaterThan(0);
    await page.locator('#ordinary').click();
    await page.waitForTimeout(40);
    expect(await starts(page)).toHaveLength(1);
    await page.reload();
    await page.locator('[data-sound-toggle]:not([hidden])').waitFor();
    expect(await page.locator('[data-sound-toggle]').getAttribute('aria-pressed')).toBe('false');
    await page.locator('#ordinary').click();
    expect(await starts(page)).toEqual([]);
  });
});
