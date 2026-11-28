'use strict';
// Browser-only shell regression. The bridge is synthetic: no provider, account or mail server is contacted.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('../../../node_modules/playwright');
const root = path.resolve(__dirname, '..');
const assets = {
  '/': ['shell.html', 'text/html'], '/shell.js': ['shell.js', 'text/javascript'],
  '/shell.css': ['shell.css', 'text/css'], '/logo.svg': ['assets/logo.svg', 'image/svg+xml'],
  '/manrope.woff2': ['assets/manrope.woff2', 'font/woff2'],
};

function installBridge() {
  const state = {accounts: [], activeId: null, status: 'empty', section: 'mail', dialogOpen: false,
    oauth: {google: {available: !new URL(location.href).searchParams.has('unavailable')}, microsoft: {available: false}},
    googleConnecting: false, version: 'fixture'};
  const listeners = new Set(), addListeners = new Set(), attempts = new Map();
  let activeAttempt, sequence = 0, manualSequence = 0, holdDialogs = false, dialogGates = [];
  const copy = () => structuredClone(state);
  const publish = () => { for (const callback of listeners) callback(copy()); };
  window.__calls = [];
  window.__fixture = {
    snapshot: copy,
    holdDialogs() { holdDialogs = true; },
    releaseDialogs() { holdDialogs = false; for (const resolve of dialogGates.splice(0)) resolve(); },
    rejectGoogle(id, message = 'Login blev annulleret.') {
      const attempt = attempts.get(id);
      if (!attempt) throw new Error('Unknown fixture attempt');
      if (activeAttempt === id) { activeAttempt = undefined; state.googleConnecting = false; publish(); }
      attempts.delete(id); attempt.reject(new Error(message));
    },
    completeGoogle(id) {
      const attempt = attempts.get(id);
      if (!attempt || activeAttempt !== id || attempt.cancelled) throw new Error('Cannot complete an inactive login');
      const account = {id: `google-${id}`, label: 'Test Google', kind: 'external'};
      state.accounts.push(account); state.activeId = account.id; state.status = 'ready';
      state.googleConnecting = false; activeAttempt = undefined; attempts.delete(id); publish(); attempt.resolve(copy());
    },
    openFromMenu() { for (const callback of addListeners) callback(); },
  };
  window.veyroDesktop = Object.freeze({
    onState(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    onAdd(callback) { addListeners.add(callback); return () => addListeners.delete(callback); },
    async invoke(action, payload) {
      window.__calls.push({action, payload: structuredClone(payload)});
      if (action === 'state') return copy();
      if (action === 'dialog') {
        if (payload.open && holdDialogs) await new Promise(resolve => dialogGates.push(resolve));
        state.dialogOpen = payload.open; publish(); return copy();
      }
      if (action === 'addGoogle') {
        if (!state.oauth.google.available || state.googleConnecting) throw new Error('Google login unavailable or already pending');
        const id = ++sequence; activeAttempt = id; state.googleConnecting = true; publish();
        return new Promise((resolve, reject) => attempts.set(id, {resolve, reject, cancelled: false}));
      }
      if (action === 'cancelGoogle') {
        if (activeAttempt !== undefined) attempts.get(activeAttempt).cancelled = true;
        activeAttempt = undefined; state.googleConnecting = false; publish();
        // Deliberately leave the previous promise unsettled to expose stale-result races.
        return copy();
      }
      if (action === 'add') {
        const account = {id: `manual-${++manualSequence}`, label: payload.label, kind: payload.kind};
        state.accounts.push(account); state.activeId = account.id; state.status = 'ready'; publish(); return copy();
      }
      if (action === 'rename') {
        state.accounts.find(account => account.id === payload.id).label = payload.label; publish(); return copy();
      }
      if (action === 'switch') { state.activeId = payload.id; publish(); return copy(); }
      if (action === 'section') { state.section = payload.section; publish(); return copy(); }
      if (action === 'dismiss') { delete state.toast; publish(); return copy(); }
      throw new Error(`Unexpected fixture action: ${action}`);
    },
  });
}

async function main() {
  const server = http.createServer(async (request, response) => {
    const asset = assets[request.url.split('?')[0]];
    if (!asset) { response.writeHead(404).end(); return; }
    try {
      response.setHeader('Content-Type', asset[1]);
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'");
      response.end(await fs.readFile(path.join(root, asset[0])));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true});
    const origin = `http://127.0.0.1:${server.address().port}`, errors = [], externalRequests = [];
    const output = process.env.VEYRO_SCREENSHOTS || '/tmp/veyro-mail-shell';
    await fs.mkdir(output, {recursive: true});
    async function fresh(query = '') {
      const page = await browser.newPage({viewport: {width: 1280, height: 900}});
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        if (route.request().url().startsWith(`${origin}/`)) return route.continue();
        externalRequests.push(route.request().url()); return route.abort();
      });
      await page.addInitScript(installBridge); await page.goto(`${origin}/${query}`);
      await page.locator('#welcome-google').waitFor(); return page;
    }
    const calls = (page, action) => page.evaluate(name => window.__calls.filter(call => call.action === name), action);
    const count = async (page, action) => (await calls(page, action)).length;
    async function screenshot(page, filename) {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${filename}: page overflow`);
      await page.screenshot({path: path.join(output, filename), animations: 'disabled'});
    }

    const google = await fresh();
    assert.equal(await google.locator('#welcome-google').isEnabled(), true);
    assert.equal(await google.locator('input:visible').count(), 0, 'Welcome must not request identity or a password.');
    assert.equal(await google.locator('input[required]').count(), 0);
    await screenshot(google, 'welcome-desktop.png');
    await google.setViewportSize({width: 740, height: 820}); await screenshot(google, 'welcome-narrow.png');
    await google.setViewportSize({width: 1280, height: 900});
    await google.locator('#add').click(); await google.locator('#account-dialog').waitFor();
    assert.equal(await google.locator('#manual-account').isVisible(), false);
    assert.equal(await google.locator('#account-form input:visible').count(), 0);
    assert.doesNotMatch(await google.locator('#account-form').innerText(), /IMAP|SMTP|OAuth|adgangskode/i);
    await screenshot(google, 'add-dialog-desktop.png');
    await google.setViewportSize({width: 740, height: 820}); await screenshot(google, 'add-dialog-narrow.png');
    await google.locator('#close-dialog').click(); await google.locator('#account-dialog').waitFor({state: 'hidden'});

    // Two welcome clicks run before either asynchronous dialog IPC can finish.
    await google.evaluate(() => {
      window.__fixture.holdDialogs();
      document.getElementById('welcome-google').click(); document.getElementById('welcome-google').click();
    });
    assert.equal(await count(google, 'addGoogle'), 0);
    assert.equal((await calls(google, 'dialog')).filter(call => call.payload.open).length, 3);
    await google.evaluate(() => window.__fixture.releaseDialogs());
    await google.waitForFunction(() => window.__calls.filter(call => call.action === 'addGoogle').length === 1);
    assert.equal(await google.locator('#google-login').isDisabled(), true);
    assert.equal(await google.locator('#other-services').isDisabled(), true);
    assert.equal(await google.evaluate(() => window.__fixture.snapshot().accounts.length), 0, 'Pending login must not create a blank profile.');

    await google.locator('#google-cancel').click();
    await google.waitForFunction(() => !document.getElementById('google-login').disabled);
    assert.equal(await count(google, 'cancelGoogle'), 1);
    assert.equal(await google.evaluate(() => window.__fixture.snapshot().accounts.length), 0);
    await google.locator('#google-login').click();
    await google.waitForFunction(() => window.__calls.filter(call => call.action === 'addGoogle').length === 2);
    await google.evaluate(() => window.__fixture.rejectGoogle(1, 'OLD_CANCELLED_LOGIN'));
    assert.equal(await google.locator('#account-dialog').isVisible(), true);
    assert.equal(await google.locator('#form-error').innerText(), '', 'A late cancelled attempt must not overwrite the new login.');
    assert.equal(await google.locator('#google-login').isDisabled(), true);
    await google.evaluate(() => window.__fixture.completeGoogle(2));
    await google.locator('#account-dialog').waitFor({state: 'hidden'});
    assert.equal(await google.evaluate(() => window.__fixture.snapshot().accounts.length), 1);
    assert.equal(await google.locator('#accounts button').count(), 1);
    assert.equal(await google.locator('#status').isVisible(), false);
    assert.equal(await google.locator('input:visible').count(), 0);
    assert.equal(await count(google, 'add'), 0, 'Google must not enter the Veyro-company/manual account creation path.');
    for (const call of await calls(google, 'addGoogle')) assert.equal(call.payload, undefined, 'Google derives identity from its verified profile.');

    // Closing the dialog cancels another pending login without removing the existing profile.
    await google.locator('#add').click(); await google.locator('#google-login').click();
    await google.waitForFunction(() => window.__calls.filter(call => call.action === 'addGoogle').length === 3);
    await google.locator('#close-dialog').click(); await google.locator('#account-dialog').waitFor({state: 'hidden'});
    await google.evaluate(() => window.__fixture.rejectGoogle(3, 'CLOSED_LOGIN'));
    assert.equal(await google.locator('#toast').isVisible(), false);
    assert.equal(await google.evaluate(() => window.__fixture.snapshot().accounts.length), 1);

    await google.locator('#manage').click();
    assert.equal(await google.locator('#google-setup').isVisible(), false);
    assert.equal(await google.locator('#kind-field').isVisible(), false);
    assert.equal(await google.locator('#label').inputValue(), 'Test Google');
    await google.locator('#label').fill(''); await google.locator('#save').click();
    assert.equal(await count(google, 'rename'), 0, 'An empty edit label must fail native form validation.');
    await google.locator('#label').fill('Min Gmail'); await google.locator('#save').click();
    await google.locator('#account-dialog').waitFor({state: 'hidden'});
    assert.deepEqual((await calls(google, 'rename'))[0].payload, {label: 'Min Gmail', kind: 'veyro', id: 'google-2'});
    assert.equal(await google.evaluate(() => window.__fixture.snapshot().accounts[0].kind), 'external');

    const manual = await fresh(); await manual.locator('#first-account').click();
    await manual.locator('#manual-account').waitFor();
    assert.equal(await manual.locator('#other-services').getAttribute('aria-expanded'), 'true');
    assert.equal(await manual.locator('#label').getAttribute('required'), null);
    await manual.locator('input[name=kind][value=external]').check(); await manual.locator('#save').click();
    await manual.locator('#account-dialog').waitFor({state: 'hidden'});
    assert.deepEqual((await calls(manual, 'add'))[0].payload, {label: 'Min mail', kind: 'external', id: undefined});
    assert.equal(await count(manual, 'addGoogle'), 0);
    await manual.locator('#add').click(); await manual.locator('#other-services').click();
    await manual.locator('input[name=kind][value=veyro]').check(); await manual.locator('#save').click();
    await manual.locator('#account-dialog').waitFor({state: 'hidden'});
    assert.equal((await calls(manual, 'add'))[1].payload.label, 'Min Veyro');
    assert.equal((await calls(manual, 'add'))[1].payload.kind, 'veyro');

    const unavailable = await fresh('?unavailable=1');
    assert.equal(await unavailable.locator('#welcome-google').isDisabled(), true);
    assert.match(await unavailable.locator('#status-copy').innerText(), /ikke tilgængeligt/);
    await unavailable.locator('#add').click();
    assert.equal(await unavailable.locator('#google-login').isDisabled(), true);
    assert.match(await unavailable.locator('#google-copy').innerText(), /ikke tilgængeligt/);
    await unavailable.locator('#google-login').dispatchEvent('click');
    assert.equal(await count(unavailable, 'addGoogle'), 0);
    await unavailable.locator('#other-services').click(); assert.equal(await unavailable.locator('#manual-account').isVisible(), true);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    console.log(JSON.stringify({ok: true, checks: 'no typed Google identity; available/unavailable Google; double welcome click across delayed dialog IPC; pending cancel and immediate retry with late rejection; success without manual/company setup; close cancels without profile loss; label edit validation; optional-label manual alternatives; desktop/narrow layouts; no external requests', screenshots: output}));
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
