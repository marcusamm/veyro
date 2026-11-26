import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

let browser;
before(async () => { browser = await chromium.launch({channel: process.env.WEBMAIL_BROWSER || undefined}); });
after(async () => { await browser?.close(); });

async function administration(t, {operator = true, mobile = false} = {}) {
  const allowedOrigin = 'https://admin-fixture.test';
  const context = await browser.newContext({viewport: mobile ? {width: 375, height: 734} : {width: 1280, height: 850}});
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const organizations = [
    {domain:'veyro.dk', name:'Veyro', active:true},
    {domain:'eksempel.dk', name:'Værkstedet', active:true},
    {domain:'review.test', name:'Intern fixture', active:true},
  ];
  const boxes = [
    {email:'marcus@veyro.dk', name:'Marcus', active:true, protected:true},
    {email:'hej@eksempel.dk', name:'Kontakt', active:true, protected:false},
  ];
  const calls = [];
  let dnsConfigured = false;
  let dnsUnavailable = false;
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, allowedOrigin);
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      const file = path === '/administration' ? 'administration.html' : path.slice(1);
      const mime = {html:'text/html', css:'text/css', js:'text/javascript', svg:'image/svg+xml', woff2:'font/woff2'};
      assert.ok(['administration.html','administration.css','administration.js','favicon.svg','manrope.woff2'].includes(file));
      const body = await readFile(new URL('./assets/' + file, import.meta.url));
      return route.fulfill({body, contentType:mime[file.split('.').pop()]});
    }
    const method = request.method();
    calls.push({path, method});
    if (path === '/api/session') return route.fulfill({json:{email:'operator@veyro.dk', csrfToken:'test-token', canManageOrganizations:operator}});
    assert.equal(operator, true);
    if (method === 'GET' && path === '/api/admin/organizations') return route.fulfill({json:{organizations}});
    if (method === 'GET' && path === '/api/admin/dns') {
      const domain = url.searchParams.get('domain');
      if (dnsUnavailable) return route.fulfill({status:503,json:{error:'DNS er midlertidigt utilgængelig.'}});
      return route.fulfill({json:{dns:{mx:{name:domain, value:'mx.example.org', priority:10},
        dkim:{name:'selector._domainkey.' + domain, value:'v=DKIM1; p=sample-public-key'}}}});
    }
    if (method === 'GET' && path === '/api/admin/mailboxes') {
      const suffix = '@' + url.searchParams.get('domain');
      return route.fulfill({json:{mailboxes:boxes.filter(box => box.email.endsWith(suffix))}});
    }
    assert.equal(method, 'POST');
    assert.equal(request.headers()['x-csrf-token'], 'test-token');
    const body = request.postDataJSON();
    if (body.currentPassword !== 'operator-fixture') return route.fulfill({status:403,json:{error:'Adgangskoden blev afvist.'}});
    if (path === '/api/admin/organizations') {
      if (!dnsConfigured) return route.fulfill({status:409, json:{error:'Domænet skal bekræftes.', dnsChallenge:{
        type:'TXT',name:'_veyro.' + body.domain,value:'sample-dns-proof',
      }}});
      organizations.push({domain:body.domain, name:body.name, active:true});
    } else if (path === '/api/admin/mailboxes') {
      assert.equal(body.password, 'mailbox-fixture');
      boxes.push({email:body.localPart+'@'+body.domain, name:body.name, active:true});
    } else if (path === '/api/admin/mailboxes/status') {
      const mailbox = boxes.find(box => box.email === body.email && box.email.endsWith('@'+body.domain));
      assert.ok(mailbox && !mailbox.protected);
      mailbox.active = body.active;
    } else throw Error('Unexpected path ' + path);
    return route.fulfill({json:{ok:true}});
  });
  await page.goto(allowedOrigin + '/administration');
  return {page, calls, configureDns() { dnsConfigured = true; }, setDnsUnavailable(value) { dnsUnavailable = value; }};
}

test('ordinary sessions never request a customer directory', async t => {
  const {page, calls} = await administration(t, {operator:false});
  await page.getByText('Din konto har ikke adgang til mailadministrationen.').waitFor();
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.deepEqual(calls.map(call => call.path), ['/api/session']);
});

test('switches between organizations, protects the operator, and creates and suspends a mailbox', async t => {
  const {page} = await administration(t);
  await page.getByText('Beskyttet', {exact:true}).waitFor();
  assert.equal(await page.getByRole('button', {name:'Deaktivér marcus@veyro.dk', exact:true}).count(), 0);
  assert.equal(await page.getByText('Intern fixture').count(), 0);
  await page.getByRole('button', {name:/Værkstedet/}).click();
  await page.getByText('hej@eksempel.dk', {exact:true}).waitFor();
  assert.equal(await page.locator('#mailboxes').getByText('Marcus', {exact:true}).count(), 0);
  await page.getByRole('button', {name:'Opret postkasse'}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Navn', {exact:true}).fill('Karin');
  await dialog.getByLabel('Første del af mailadressen').fill('karin');
  await dialog.getByLabel('Postkassens startadgangskode').fill('mailbox-fixture');
  await dialog.getByLabel('Din adgangskode til Veyro Mail').fill('incorrect-fixture');
  await dialog.getByRole('button', {name:'Opret postkasse'}).click();
  await dialog.getByText('Adgangskoden blev afvist.').waitFor();
  assert.equal(await dialog.getByLabel('Navn', {exact:true}).inputValue(), 'Karin');
  assert.equal(await dialog.getByLabel('Din adgangskode til Veyro Mail').inputValue(), '');
  await dialog.getByLabel('Din adgangskode til Veyro Mail').fill('operator-fixture');
  await dialog.getByRole('button', {name:'Opret postkasse'}).click();
  const deactivate = page.getByRole('button', {name:'Deaktivér karin@eksempel.dk', exact:true});
  const activate = page.getByRole('button', {name:'Aktivér karin@eksempel.dk', exact:true});
  await deactivate.click();
  await dialog.getByLabel('Din adgangskode til Veyro Mail').fill('operator-fixture');
  await dialog.getByRole('button', {name:'Deaktivér postkasse'}).click();
  await activate.waitFor();
  await page.getByLabel('Filtrér efter status').selectOption('inactive');
  assert.deepEqual(await page.locator('#mailboxes .mail-id > span').allTextContents(), ['karin@eksempel.dk']);
  await activate.click();
  await dialog.getByLabel('Din adgangskode til Veyro Mail').fill('operator-fixture');
  await dialog.getByRole('button', {name:'Aktivér postkasse'}).click();
  await deactivate.waitFor();
});

test('shows the DNS record before provisioning a customer and fits at mobile width', async t => {
  const {page, configureDns} = await administration(t, {mobile:true});
  await page.getByRole('button', {name:'Tilføj organisation'}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Virksomhedsnavn').fill('Ny kunde');
  await dialog.getByLabel('Maildomæne').fill('ny-kunde.dk');
  await dialog.getByLabel('Din adgangskode til Veyro Mail').fill('operator-fixture');
  await dialog.getByRole('button', {name:'Tilføj organisation'}).click();
  await dialog.getByText('_veyro.ny-kunde.dk', {exact:true}).waitFor();
  assert.equal(await dialog.getByText('sample-dns-proof').count(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  configureDns();
  await dialog.getByLabel('Din adgangskode til Veyro Mail').fill('operator-fixture');
  await dialog.getByRole('button', {name:'Kontrollér DNS'}).click();
  await page.getByRole('heading', {name:'Ny kunde'}).waitFor();
  await page.getByText('Organisationen har ingen postkasser endnu.').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
});

test('fetches delivery records only on demand and preserves the mailbox list on DNS errors', async t => {
  const {page, calls, setDnsUnavailable} = await administration(t);
  await page.getByRole('button', {name:/Værkstedet/}).click();
  await page.getByText('hej@eksempel.dk', {exact:true}).waitFor();
  assert.equal(calls.some(call => call.path === '/api/admin/dns'), false);
  setDnsUnavailable(true);
  await page.locator('#delivery summary').click();
  await page.getByText('DNS er midlertidigt utilgængelig.').waitFor();
  assert.equal(await page.getByRole('button', {name:'Deaktivér hej@eksempel.dk'}).isVisible(), true);
  setDnsUnavailable(false);
  await page.getByRole('button', {name:'Hent DNS igen'}).click();
  await page.getByText('selector._domainkey.eksempel.dk', {exact:true}).waitFor();
  await page.getByText('mx.example.org', {exact:true}).waitFor();
  await page.getByRole('button', {name:/Veyro veyro.dk/}).click();
  await page.getByText('Beskyttet', {exact:true}).waitFor();
  assert.equal(await page.locator('#records').textContent(), '');
});
