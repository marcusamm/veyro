import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

// Browser regression for native right-click, touch controls, and the actual compose flow.
// Every API call stays in this fixture. An opt-in check fetches only the public static assets.
let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.WEBMAIL_BROWSER || undefined }); });
after(async () => { await browser?.close(); });

const liveAssets = process.env.WEBMAIL_LIVE_ASSETS === '1';
const origin = liveAssets ? 'https://mail.veyro.dk' : 'https://webmail.test';
const csrf = 'fixture-token';
const mail = {
  id: '1.1', from: 'Anne <anne@example.test>', to: 'you@example.test', subject: 'Projekt',
  senderAddress: 'anne@example.test', replyAddresses: ['anne@example.test'],
  replyAllTo: ['anne@example.test'], replyAllCc: ['cc@example.test'], unread: true,
  labels: [], text: 'Original mailtekst', hasAttachments: true,
  attachments: [{id: '2', name: 'projekt.pdf', size: 100}], date: '2026-11-25T12:00:00Z',
};
const folders = ['inbox', 'archive', 'trash'].map(role => ({ id: role, name: role, role, unread: 0 }));
const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff2: 'font/woff2' };

async function mailbox(t, options = {}, extraMails = [], canManageRecovery, canManageOrganizations = false) {
  const context = await browser.newContext(options);
  t.after(() => context.close());
  const writes = [], lists = [], errors = [];
  const fixtures = structuredClone([mail, ...extraMails]);
  context.on('page', page => page.on('pageerror', error => errors.push(String(error))));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin);
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      const name = path === '/' ? 'inbox.html' : path === '/message-frame' ? 'message-frame.html' : path.slice(1);
      assert.equal(request.method(), 'GET');
      assert.ok(['inbox.html', 'inbox.css', 'inbox.js', 'favicon.svg', 'manrope.woff2', 'message-frame.html', 'message-frame.js'].includes(name));
      if (liveAssets) {
        const response = await route.fetch({maxRedirects: 0});
        assert.equal(response.status(), 200);
        return route.fulfill({response});
      }
      const data = await readFile(new URL('./assets/' + name, import.meta.url));
      return route.fulfill({body: data, contentType: mime[name.split('.').pop()], headers: {
        'Content-Security-Policy': path === '/message-frame'
          ? `default-src 'none'; script-src ${origin}/message-frame.js; style-src 'unsafe-inline'; img-src data:${url.searchParams.get('images') === '1' ? ' https:' : ''}; font-src 'none'; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`
          : "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
      }});
    }
    let json;
    if (request.method() === 'POST') {
      assert.equal(request.headers()['x-csrf-token'], csrf);
      const body = request.postDataJSON();
      writes.push({path, folder: url.searchParams.get('folder'), body});
      const fixture = fixtures.find(item => path.split('/')[3] === item.id);
      if (body.action === 'label') fixture.labels = [body.label];
      if (body.action === 'read' || body.action === 'unread') fixture.unread = body.action === 'unread';
      json = path === '/api/send' ? {sent: true} : {ok: true};
    } else if (path === '/api/session') json = {email: 'you@example.test', csrfToken: csrf, canManageRecovery, canManageOrganizations};
    else if (path === '/api/folders') json = {folders};
    else if (path === '/api/messages') {
      lists.push(url.searchParams);
      json = {messages: fixtures.map(({text, html, security, attachments, ...summary}) => summary),
        nextCursor: null, availableLabels: fixtures.flatMap(item => item.labels)};
    } else if (path.startsWith('/api/messages/') && fixtures.some(item => item.id === path.split('/')[3])) {
      const fixture = fixtures.find(item => item.id === path.split('/')[3]);
      fixture.unread = false; json = fixture;
    }
    else throw Error('Unexpected route ' + path);
    return route.fulfill({json});
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.locator('.message-row').first().waitFor();
  t.after(() => assert.deepEqual(errors, []));
  return {page, writes, lists};
}

test('opens mail links safely with formatted text, the real destination and no fetched mail resources', async t => {
  const sample = {
    ...mail, id: '1.2', security: {status: 'clean', reasons: []}, text: 'Tekstversion',
    html: '<div id="from-message" style="color:red"><p><strong>Hjælp</strong> ' +
      '<a href="https://docs.example.test/start" target="_self" id="remote-link" ping="/unexpected">andet.example.test</a></p>' +
      '<a href="mailto:team@example.test">Skriv til os</a> ' +
      '<a href="data:,Eksempel">Datatekst</a> <a href="javascript:">Anden protokol</a> ' +
      '<a href="/intern">Relativ sti</a> <a href="https://person@docs.example.test/">Ugyldig adresse</a>' +
      '<img src="/favicon.svg?message-test" alt="Billede"><iframe src="https://media.example.test/frame"></iframe>' +
      '<script type="application/json">{"fixture":true}</script><p>https://docs.example.test/tekst</p></div>',
  };
  const {page} = await mailbox(t, {}, [sample]);
  const fetched = [];
  page.context().on('request', request => fetched.push(request.url()));
  await page.locator('li[data-mail="1.2"] .message-row').click();
  const body = page.frameLocator('.mail-frame').locator('body');
  await body.getByText('Hjælp', {exact:true}).waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(fetched.some(url => /message-test|media\.example\.test|unexpected/.test(url)), false);
  assert.equal(await body.locator('strong').textContent(), 'Hjælp');
  assert.equal(await body.locator('a[href]').count(), 3);
  assert.equal(await body.locator('iframe,[ping],[onclick]').count(), 0);
  assert.equal(await body.locator('strong').evaluate(el => getComputedStyle(el).color), 'rgb(255, 0, 0)');
  assert.equal(await body.getByText('Datatekst', {exact: false}).first().isVisible(), true);
  const external = body.getByRole('link', {name: 'andet.example.test'});
  assert.equal(await external.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await external.getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(await external.getAttribute('title'), /docs\.example\.test/);
  assert.equal(await body.getByRole('link', {name: 'Skriv til os'}).getAttribute('href'), 'mailto:team@example.test');
  let referer;
  await page.context().route('https://docs.example.test/start', route => {
    referer = route.request().headers().referer;
    return route.fulfill({contentType: 'text/html', body: 'Testside'});
  });
  const opened = page.context().waitForEvent('page');
  await external.click();
  const destination = await opened;
  await destination.waitForLoadState();
  assert.equal(destination.url(), 'https://docs.example.test/start');
  assert.equal(await destination.locator('body').textContent(), 'Testside');
  assert.equal(await destination.evaluate(() => window.opener === null), true);
  assert.equal(referer, undefined);
});

test('shows legacy status, preserves punctuation and keeps suspect HTML links usable on mobile', async t => {
  const legacy = {...mail, id: '1.2', text: 'Se (https://docs.example.test/kursus_(A)).\n' +
    'Svar på mailto:anne@example.test eller åbn http://docs.example.test/a.'};
  const suspect = {...mail, id: '1.3', text: 'Tekst', html: '<p><a href="https://portal.example.test">Åbn demoen</a></p>',
    security: {status:'suspicious', reasons:['Linkteksten kan være vildledende.']}};
  const oldHtml = {...suspect, id:'1.4', security: undefined, text: '',
    html: '<p>Aftale</p><dl><dt>Booking</dt><dd><a href="https://portal.example.test">Åbn demoen</a></dd></dl>'};
  const dangerous = {...legacy, id:'1.5', html: '<p>Skjult HTML</p>', security: {status:'dangerous', reasons:[]}};
  const {page} = await mailbox(t, {viewport:{width:375,height:700}, isMobile:true, hasTouch:true},
    [legacy, suspect, oldHtml, dangerous]);
  async function open(id) {
    if (await page.locator('#back').isVisible()) await page.locator('#back').tap();
    await page.locator('li[data-mail="' + id + '"] .message-row').tap();
    await page.locator('.letter .mail-scan').waitFor();
  }
  await open(legacy.id);
  assert.equal(await page.locator('.mail-scan.unknown').isVisible(), true);
  assert.equal(await page.locator('.letter-body').textContent(), legacy.text);
  assert.deepEqual(await page.locator('.body-link').evaluateAll(links => links.map(link => link.href)),
    ['https://docs.example.test/kursus_(A)', 'mailto:anne@example.test', 'http://docs.example.test/a']);
  await open(suspect.id);
  assert.match(await page.locator('.mail-scan.suspicious').textContent(), /Linkteksten/);
  assert.equal(await page.frameLocator('.mail-frame').getByRole('link', {name:'Åbn demoen'}).getAttribute('href'), 'https://portal.example.test/');
  assert.match(await page.frameLocator('.mail-frame').getByRole('link', {name:'Åbn demoen'}).getAttribute('title'), /portal\.example\.test/);
  assert.equal(await page.locator('.attachments a').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await open(oldHtml.id);
  assert.equal(await page.locator('.mail-scan.unknown').isVisible(), true);
  assert.equal(await page.frameLocator('.mail-frame').locator('dd').getByRole('link', {name:'Åbn demoen'}).getAttribute('href'), 'https://portal.example.test/');
  await open(dangerous.id);
  assert.equal(await page.locator('.mail-scan.dangerous').isVisible(), true);
  assert.equal(await page.locator('.letter-body a').count(), 0);
  assert.doesNotMatch(await page.locator('.letter-body').textContent(), /Skjult HTML/);
});

test('customer account menu only offers the actions available for its mailbox', async t => {
  const {page} = await mailbox(t, {}, [], false);
  await page.locator('#account-toggle').click();
  assert.equal(await page.locator('#open-recovery-settings').isVisible(), false);
  assert.equal(await page.locator('#open-administration').isVisible(), false);
  assert.equal(await page.getByRole('link', {name: 'AI-forbindelser'}).isVisible(), true);
});

test('the operator can open the organization window from the account menu', async t => {
  const {page} = await mailbox(t, {}, [], true, true);
  await page.locator('#account-toggle').click();
  const link = page.getByRole('link', {name:'Mailadministration'});
  assert.equal(await link.isVisible(), true);
  assert.equal(await link.getAttribute('href'), '/administration');
});

test('uses the targeted row with native contextmenu, keyboard navigation, and safe reply-all recipients', async t => {
  const {page, writes} = await mailbox(t);
  const row = page.locator('.message-row');
  await row.click({button: 'right'});
  await page.getByRole('menu').waitFor();
  const box = await page.getByRole('menu').boundingBox();
  assert.ok(box.x > 0 && box.y > 0 && box.x + box.width <= page.viewportSize().width);
  assert.equal(await row.getAttribute('aria-pressed'), 'false');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').isVisible(), false);
  await row.focus();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator(':focus').textContent(), 'Svar alle');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#recipient').inputValue(), 'anne@example.test');
  assert.equal(await page.locator('#cc').inputValue(), 'cc@example.test');
  await page.locator('#body').fill('Tak for mailen.');
  await page.locator('#send').click();
  await page.locator('#composer').waitFor({state: 'hidden'});
  assert.deepEqual(writes[0].body, {to: 'anne@example.test', cc: 'cc@example.test', subject: 'Re: Projekt',
    text: 'Tak for mailen.', replyToFolder: 'inbox', replyToId: '1.1'});
});

test('right-clicking an unopened second row acts on that mail and keeps the first mail open', async t => {
  const other = {...mail, id: '1.2', subject: 'Anden mail', unread: true, from: 'Bob <bob@example.test>'};
  const {page, writes} = await mailbox(t, {}, [other]);
  const first = page.locator('li[data-mail="1.1"] .message-row');
  const second = page.locator('li[data-mail="1.2"] .message-row');
  await first.click();
  await page.locator('.letter h2').waitFor();
  assert.equal(await page.locator('.letter h2').textContent(), 'Projekt');
  assert.equal(await first.getAttribute('aria-pressed'), 'true');
  await second.click({button: 'right'});
  assert.equal(await second.getAttribute('aria-pressed'), 'false');
  assert.ok((await second.getAttribute('class')).includes('unread'));
  await page.getByRole('menuitem', {name: 'Markér som læst', exact: true}).click();
  await page.locator('li[data-mail="1.2"] .message-row:not(.unread)').waitFor();
  assert.equal(await page.locator('.letter h2').textContent(), 'Projekt');
  assert.equal(await first.getAttribute('aria-pressed'), 'true');
  assert.equal(await second.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(writes, [{path: '/api/messages/1.2/action', folder: 'inbox', body: {action: 'read'}}]);
});

test('opens the same message in another window and forwards the original as an EML without a comment', async t => {
  const {page, writes} = await mailbox(t);
  const more = page.locator('.message-list .more-actions');
  await more.click();
  const nextWindow = page.context().waitForEvent('page');
  await page.getByRole('menuitem', {name: 'Åbn i et nyt vindue'}).click();
  const popup = await nextWindow;
  await popup.locator('.letter h2').waitFor();
  assert.equal(await popup.locator('.letter h2').textContent(), 'Projekt');
  await popup.close();
  await more.click();
  await page.getByRole('menuitem', {name: 'Videresend som vedhæftet fil'}).click();
  assert.equal(await page.locator('#forward-files').isVisible(), true);
  await page.locator('#recipient').fill('team@example.test');
  await page.locator('#send').click();
  await page.locator('#composer').waitFor({state: 'hidden'});
  assert.deepEqual(writes[0].body.forwardAttachment, {folder: 'inbox', id: '1.1'});
  assert.equal(writes[0].body.replyToId, undefined);
});

test('normal forwarding copies the message text and includes the original files', async t => {
  const {page, writes} = await mailbox(t);
  await page.locator('.message-row').click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Videresend', exact: true}).click();
  await page.locator('#composer').waitFor();
  assert.ok((await page.locator('#body').inputValue()).includes('Original mailtekst'));
  await page.locator('#recipient').fill('team@example.test');
  await page.locator('#send').click();
  await page.locator('#composer').waitFor({state: 'hidden'});
  assert.deepEqual(writes[0].body.forwardFiles, {folder: 'inbox', id: '1.1'});
  assert.equal(writes[0].body.forwardAttachment, undefined);
  assert.equal(writes[0].body.replyToId, undefined);
});

test('shows the reader and organizer on a touch viewport, persists labels and sets a future snooze', async t => {
  const {page, writes, lists} = await mailbox(t, {viewport: {width: 375, height: 700}, isMobile: true, hasTouch: true});
  await page.locator('.message-row').tap();
  await page.locator('.letter .more-actions').tap();
  await page.getByRole('menuitem', {name: 'Etiketter'}).tap();
  await page.getByRole('menuitem', {name: 'Ny etiket'}).tap();
  await page.locator('#new-label').fill('Kunder');
  await page.locator('#save-label').tap();
  await page.locator('#label-dialog').waitFor({state: 'hidden'});
  await page.locator('#back').tap();
  await page.locator('#label-filter').selectOption('Kunder');
  await page.locator('.mail-label').waitFor();
  assert.equal(lists.at(-1).get('label'), 'Kunder');
  assert.deepEqual(writes[0], {path: '/api/messages/1.1/action', folder: 'inbox', body: {action: 'label', label: 'Kunder'}});
  await page.locator('.message-list .more-actions').tap();
  await page.getByRole('menuitem', {name: 'Udsæt', exact: true}).tap();
  await page.locator('#save-snooze').tap();
  await page.locator('#snooze-dialog').waitFor({state: 'hidden'});
  assert.equal(writes[1].path, '/api/messages/1.1/snooze');
  assert.ok(Date.parse(writes[1].body.until) > Date.now());
  await page.locator('#folder-view').selectOption('snoozed');
  await page.locator('.message-list .more-actions').tap();
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/snooze?')),
    page.getByRole('menuitem', {name: 'Flyt tilbage til indbakken nu'}).tap(),
  ]);
  assert.equal(writes[2].body.until, null);
});
