// Exercise the actual consent and statistics scripts in Chromium. Requests stay in a local fixture.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

const asset = (name) => readFileSync(fileURLToPath(new URL(`../site/theme/assets/${name}`, import.meta.url)), 'utf8');
const inline = (source) => source.replace(/<\/script/gi, '<\\/script');
const NOW = Date.UTC(2026, 10, 5, 12);
const YEAR = 365 * 24 * 60 * 60 * 1000;
const choice = (analytics = true, version = 2, timestamp = NOW) => ({ v: version, t: timestamp, consent: { analytics, marketing: true } });
const fixture = (eligible) => `<!doctype html><html><head><style>[hidden]{display:none!important}body{margin:0}main{height:4000px}</style>
<script id="ThemeStrings" type="application/json">{}</script><script>${inline(asset('theme.js'))}</script>
<script>${inline(asset('analytics.js'))}</script></head><body ${eligible ? 'data-analytics-page="true"' : ''}>
<button data-cookie-open>Cookie settings</button><main>Public page</main>
<div data-cookie hidden><form data-cookie-prefs hidden>
<input type="checkbox" data-consent="analytics"><input type="checkbox" data-consent="marketing">
</form><p data-cookie-privacy-signal hidden>Privacy signal</p>
<button data-cookie-action="reject">Reject</button><button data-cookie-action="customize">Customize</button>
<button data-cookie-action="save" hidden>Save</button><button data-cookie-action="accept">Accept</button>
<p data-cookie-error hidden>Storage failed</p><p data-cookie-status></p></div></body></html>`;
let browser;
const sessions = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterEach(async () => {
  for (const { context, errors } of sessions.splice(0)) {
    await context.close();
    expect(errors).toEqual([]);
  }
});
afterAll(async () => { await browser?.close(); });

async function mount({ record, signal, eligible = true, path = '/', holdPageview = false, refuseEngagement = false, showConsent = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const errors = [], events = [];
  sessions.push({ context, errors });
  await context.addInitScript(({ record, signal }) => {
    if (record && !sessionStorage.getItem('seeded')) {
      localStorage.setItem('theme-cookie-consent', JSON.stringify(record));
      sessionStorage.setItem('seeded', '1');
    }
    if (signal === 'gpc') Object.defineProperty(navigator, 'globalPrivacyControl', { value: true });
    if (signal === 'dnt') Object.defineProperty(navigator, 'doNotTrack', { value: '1' });
    window.testVisibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => window.testVisibility });
    Object.defineProperty(document, 'referrer', { get: () => 'https://google.com/search?q=private-query' });
  }, { record, signal });
  let releasePageview;
  const gate = holdPageview ? new Promise((resolve) => { releasePageview = resolve; }) : Promise.resolve();
  await context.route('**/*', async (route) => {
    const req = route.request();
    if (new URL(req.url()).pathname === '/analytics/events') {
      const event = req.postDataJSON();
      events.push(event);
      if (event.type === 'pageview') await gate;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ accepted: !(refuseEngagement && event.type === 'engagement') }) });
    }
    if (req.url().startsWith('https://visitor-stats.test/')) {
      const body = showConsent ? fixture(eligible) : fixture(eligible).replace(/<div data-cookie hidden>[\s\S]*?<\/div>/, '');
      return route.fulfill({ contentType: 'text/html', body });
    }
    errors.push(`Unexpected request: ${req.url()}`);
    await route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await page.goto(`https://visitor-stats.test${path}`);
  await page.clock.pauseAt(NOW + 1000);
  return { context, page, events, releasePageview };
}
const click = (page, action) => page.evaluate((action) => document.querySelector(`[data-cookie-action="${action}"]`).click(), action);
const activity = (page) => page.evaluate(() => document.dispatchEvent(new Event('pointerdown')));
const visibility = (page, state) => page.evaluate((state) => {
  window.testVisibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}, state);
const waitEvents = (events, count) => expect.poll(() => events.length).toBe(count);
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('theme-cookie-consent')));

describe('visitor statistics consent', () => {
  it('does not send statistics before consent; rejecting saves an explicit v2 choice', async () => {
    const { page, events } = await mount();
    await page.clock.runFor(90000);
    expect(events).toEqual([]);
    expect(await page.locator('[data-cookie]').isVisible()).toBe(true);
    await click(page, 'reject');
    expect((await saved(page))).toMatchObject({ v: 2, consent: { analytics: false, marketing: false } });
    await activity(page);
    expect(events).toEqual([]);
  });

  it('asks legacy Accept-all visitors again with statistics off and marketing preserved', async () => {
    const { page, events } = await mount({ record: choice(true, 1) });
    await click(page, 'customize');
    expect(await page.locator('[data-consent="analytics"]').isChecked()).toBe(false);
    expect(await page.locator('[data-consent="marketing"]').isChecked()).toBe(true);
    await page.clock.runFor(90000);
    expect(events).toEqual([]);
    await page.locator('[data-consent="analytics"]').check();
    await click(page, 'save');
    await waitEvents(events, 1);
    expect(events[0]).toMatchObject({ type: 'pageview', path: '/', consentVersion: 2, consent: true });
    expect((await saved(page)).v).toBe(2);
  });

  it('starts one pageview on accept and only sends permitted paths, referrer hosts and campaign channels', async () => {
    const { page, events } = await mount({ path: '/pages/kontakt?utm_source=instagram&email=private%40example.com#private' });
    await click(page, 'accept');
    await waitEvents(events, 1);
    await page.addScriptTag({ content: asset('analytics.js') });
    await page.clock.runFor(30000);
    await waitEvents(events, 2);
    expect(events[0]).toMatchObject({ type: 'pageview', path: '/pages/kontakt', referrer: 'google.com', campaignSource: 'instagram' });
    expect(events[1].eventId).toBe(events[0].eventId);
    expect(events[1].activeSeconds).toBeGreaterThanOrEqual(29);
    expect(JSON.stringify(events)).not.toMatch(/private|example\.com|search\?q|utm_source/);
  });

  it.each(['gpc', 'dnt'])('keeps statistics off for the %s privacy signal, including Accept all', async (signal) => {
    const { page, events } = await mount({ signal });
    await click(page, 'customize');
    expect(await page.locator('[data-consent="analytics"]').isDisabled()).toBe(true);
    expect(await page.locator('[data-cookie-privacy-signal]').isVisible()).toBe(true);
    await click(page, 'accept');
    await page.clock.runFor(90000);
    expect((await saved(page)).consent.analytics).toBe(false);
    expect(events).toEqual([]);
  });

  it('expires a previous v2 choice, clears cookies once, and does not collect a view', async () => {
    const { page, events } = await mount({ record: choice(true, 2, NOW - YEAR - 1000) });
    await waitEvents(events, 1);
    expect(events[0]).toEqual({ type: 'revoke', consent: false, consentVersion: 2 });
    expect(await page.locator('[data-cookie]').isVisible()).toBe(true);
    await page.clock.runFor(120000);
    expect(events).toHaveLength(1);
  });

  it('withdraws on an ineligible cart page and clears existing analytics cookies', async () => {
    const { page, events } = await mount({ record: choice(), eligible: false, path: '/cart' });
    expect(events).toEqual([]);
    await page.locator('[data-cookie-open]').click();
    await click(page, 'reject');
    await waitEvents(events, 1);
    expect(events[0].type).toBe('revoke');
    await page.clock.runFor(90000);
    expect(events).toHaveLength(1);
  });

  it('clears the old opt-in when cookie settings have been disabled by the site administrator', async () => {
    const { page, events } = await mount({ record: choice(), showConsent: false });
    await waitEvents(events, 1);
    expect(events[0].type).toBe('revoke');
    await page.clock.runFor(90000);
    expect(events).toHaveLength(1);
  });

  it('stops and revokes when consent changes in another tab', async () => {
    const { context, page, events } = await mount({ record: choice() });
    await waitEvents(events, 1);
    const other = await context.newPage();
    await other.goto('https://visitor-stats.test/cart');
    await other.evaluate(() => localStorage.setItem('theme-cookie-consent', JSON.stringify({ v: 2, t: Date.now(), consent: { analytics: false } })));
    await expect.poll(() => events.filter((event) => event.type === 'revoke').length).toBeGreaterThan(0);
    const count = events.length;
    await page.clock.runFor(90000);
    expect(events).toHaveLength(count);
    expect(await page.locator('[data-cookie]').isVisible()).toBe(false);
  });

  it('queues withdrawal after the initial cookie-setting response', async () => {
    const { page, events, releasePageview } = await mount({ holdPageview: true });
    await click(page, 'accept');
    await waitEvents(events, 1);
    await page.locator('[data-cookie-open]').click();
    await click(page, 'reject');
    await page.clock.runFor(90000);
    expect(events.map((event) => event.type)).toEqual(['pageview']);
    releasePageview();
    await waitEvents(events, 2);
    expect(events.map((event) => event.type)).toEqual(['pageview', 'revoke']);
  });

  it('fails closed when storage rejects a withdrawal, even if an old acceptance cannot be removed', async () => {
    const { page, events } = await mount({ record: choice() });
    await waitEvents(events, 1);
    await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new Error('Storage blocked'); };
      Storage.prototype.removeItem = () => { throw new Error('Storage blocked'); };
    });
    await page.locator('[data-cookie-open]').click();
    await click(page, 'reject');
    await waitEvents(events, 2);
    expect(events[1].type).toBe('revoke');
    expect(await page.locator('[data-cookie-error]').isVisible()).toBe(true);
    await page.clock.runFor(90000);
    await activity(page);
    expect(events).toHaveLength(2);
  });
});

describe('visitor statistics engagement', () => {
  it('stops renewing idle sessions and starts a new pageview after 30 minutes of inactivity', async () => {
    const { page, events } = await mount({ record: choice() });
    await waitEvents(events, 1);
    await page.clock.runFor(90000);
    await expect.poll(() => events.length).toBeGreaterThan(1);
    const count = events.length;
    const maxSeconds = Math.max(...events.map((event) => event.activeSeconds || 0));
    expect(maxSeconds).toBeLessThanOrEqual(60);
    await page.clock.runFor(31 * 60000);
    expect(events).toHaveLength(count);
    await activity(page);
    await waitEvents(events, count + 1);
    expect(events.at(-1).type).toBe('pageview');
    expect(events.at(-1).eventId).not.toBe(events[0].eventId);
  });

  it('excludes hidden-tab time and sends no repeated background heartbeats', async () => {
    const { page, events } = await mount({ record: choice() });
    await waitEvents(events, 1);
    await page.clock.runFor(10000);
    await visibility(page, 'hidden');
    await waitEvents(events, 2);
    const hiddenSeconds = events.at(-1).activeSeconds;
    await page.clock.runFor(5 * 60000);
    expect(events).toHaveLength(2);
    await visibility(page, 'visible');
    await activity(page);
    await page.clock.runFor(30000);
    await expect.poll(() => events.length).toBeGreaterThan(2);
    expect(events.at(-1).activeSeconds).toBeLessThanOrEqual(hiddenSeconds + 31);
    expect(events.at(-1).eventId).toBe(events[0].eventId);
  });

  it('waits for real activity before restarting a server-rejected session', async () => {
    const { page, events } = await mount({ record: choice(), refuseEngagement: true });
    await waitEvents(events, 1);
    await page.clock.runFor(30000);
    await waitEvents(events, 2);
    await page.clock.runFor(90000);
    expect(events).toHaveLength(2);
    await activity(page);
    await waitEvents(events, 3);
    expect(events[2].type).toBe('pageview');
    expect(events[2].eventId).not.toBe(events[0].eventId);
  });
});
