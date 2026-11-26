import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

let browser;
before(async () => { browser = await chromium.launch({channel: process.env.WEBMAIL_BROWSER || undefined}); });
after(async () => { await browser?.close(); });

async function administration(t, {operator = true, mobile = false, tenant = false} = {}) {
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
    {email:'leder@eksempel.dk', name:'Lene', active:true, protected:tenant, organizationAdmin:true},
    {email:'salg@eksempel.dk', name:'Salg', active:false, protected:false},
    {email:'nyhed@eksempel.dk', name:'Nyhed', active:false, protected:false, organizationAdmin:true},
  ];
  const calls = [];
  const changes = [];
  let authorized = operator;
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
    if (path === '/api/session') return route.fulfill({json:{
      email:tenant ? 'leder@eksempel.dk' : 'marcus@veyro.dk', csrfToken:'test-token', canManageOrganizations:authorized,
      administrationRole:authorized ? tenant ? 'organization' : 'platform' : 'none', administrationDomain:tenant && authorized ? 'eksempel.dk' : null,
    }});
    assert.equal(operator, true);
    if (!authorized) return route.fulfill({status:403, json:{error:'Adgang afvist.'}});
    if (method === 'GET' && path === '/api/admin/organizations') return route.fulfill({json:{organizations}});
    if (method === 'GET' && path === '/api/admin/dns') {
      assert.equal(tenant, false);
      const domain = url.searchParams.get('domain');
      if (dnsUnavailable) return route.fulfill({status:503,json:{error:'DNS er midlertidigt utilgængelig.'}});
      return route.fulfill({json:{dns:{mx:{name:domain, value:'mx.example.org', priority:10},
        dkim:{name:'selector._domainkey.' + domain, value:'v=DKIM1; p=sample-public-key'}}}});
    }
    if (method === 'GET' && path === '/api/admin/mailboxes') {
      if (tenant) assert.equal(url.searchParams.get('domain'), 'eksempel.dk');
      const suffix = '@' + url.searchParams.get('domain');
      return route.fulfill({json:{mailboxes:boxes.filter(box => box.email.endsWith(suffix))}});
    }
    assert.equal(method, 'POST');
    assert.equal(request.headers()['x-csrf-token'], 'test-token');
    const body = request.postDataJSON();
    if (tenant) assert.equal(body.domain, 'eksempel.dk');
    if (body.currentPassword !== 'operator-fixture') return route.fulfill({status:403,json:{error:'Adgangskoden blev afvist.'}});
    if (path === '/api/admin/organizations') {
      assert.equal(tenant, false);
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
      if (tenant) assert.equal(body.active, false);
      mailbox.active = body.active;
    } else if (path === '/api/admin/mailboxes/role' || path === '/api/admin/mailboxes/password') {
      const mailbox = boxes.find(box => box.email === body.email && box.email.endsWith('@'+body.domain));
      assert.ok(mailbox && !mailbox.protected);
      if (path.endsWith('/role')) {
        assert.equal(tenant, false);
        assert.ok(!body.admin || mailbox.active);
        mailbox.organizationAdmin = body.admin;
      } else {
        if (tenant) assert.ok(!mailbox.organizationAdmin);
        assert.equal(body.newPassword, 'new-employee-fixture');
        assert.equal(Object.hasOwn(body,'repeatPassword'), false);
      }
      changes.push({path, email:body.email, admin:body.admin});
    } else throw Error('Unexpected path ' + path);
    return route.fulfill({json:{ok:true}});
  });
  await page.goto(allowedOrigin + '/administration');
  return {page, calls, changes, revokeRole() { authorized = false; }, configureDns() { dnsConfigured = true; }, setDnsUnavailable(value) { dnsUnavailable = value; }};
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
  assert.deepEqual(await page.locator('#mailboxes .mail-id > span').allTextContents(), ['salg@eksempel.dk','nyhed@eksempel.dk','karin@eksempel.dk']);
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

test('a customer administrator sees only their own company and can reset an employee password', async t => {
  const {page, changes} = await administration(t, {tenant:true, mobile:true});
  await page.getByRole('heading', {name:'Værkstedet'}).waitFor();
  await page.getByRole('button', {name:'Deaktivér hej@eksempel.dk', exact:true}).waitFor();
  assert.equal(await page.getByText('marcus@veyro.dk').count(), 0);
  assert.equal(await page.getByRole('button', {name:'Tilføj organisation'}).count(), 0);
  assert.equal(await page.locator('#delivery').isVisible(), false);
  assert.equal(await page.getByRole('button', {name:'Aktivér salg@eksempel.dk', exact:true}).count(), 0);
  assert.equal(await page.getByRole('button', {name:'Flere handlinger for salg@eksempel.dk', exact:true}).count(), 0);
  assert.equal(await page.getByRole('button', {name:'Nulstil adgangskode for salg@eksempel.dk', includeHidden:true}).count(), 0);
  assert.equal(await page.getByRole('button', {name:'Flere handlinger for leder@eksempel.dk'}).count(), 0);
  assert.equal(await page.getByRole('button', {name:'Flere handlinger for nyhed@eksempel.dk'}).count(), 0);
  assert.ok(await page.getByRole('button', {name:'Opret postkasse'}).isVisible());
  await page.getByRole('button', {name:'Flere handlinger for hej@eksempel.dk', exact:true}).click();
  assert.equal(await page.getByRole('button', {name:/administratoradgang/i}).count(), 0);
  await page.getByRole('button', {name:'Nulstil adgangskode for hej@eksempel.dk', exact:true}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Ny adgangskode til medarbejderen').fill('new-employee-fixture');
  await dialog.getByLabel('Gentag den nye adgangskode').fill('different-fixture');
  await dialog.getByLabel('Din adgangskode til Veyro Mail').fill('operator-fixture');
  await dialog.getByRole('button', {name:'Nulstil adgangskode', exact:true}).click();
  await dialog.getByText('De to nye adgangskoder skal være ens.').waitFor();
  assert.equal(changes.length, 0);
  await dialog.getByLabel('Gentag den nye adgangskode').fill('new-employee-fixture');
  await dialog.getByRole('button', {name:'Nulstil adgangskode', exact:true}).click();
  await page.getByText('Adgangskoden er ændret for hej@eksempel.dk.').waitFor();
  assert.deepEqual(changes.map(({path,email}) => ({path,email})), [{path:'/api/admin/mailboxes/password', email:'hej@eksempel.dk'}]);
  assert.equal(await page.locator('[name="newPassword"]').inputValue(), '');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
});

test('Marcus can grant and revoke company access, including revoking an inactive administrator', async t => {
  const {page, changes} = await administration(t);
  await page.getByRole('button', {name:/Værkstedet/}).click();
  await page.getByRole('button', {name:'Aktivér salg@eksempel.dk', exact:true}).waitFor();
  assert.equal(await page.getByRole('button', {name:'Flere handlinger for salg@eksempel.dk', exact:true}).count(), 0);
  const dialog = page.getByRole('dialog');
  for (const [email, action, button] of [
    ['hej@eksempel.dk','Giv administratoradgang til','Giv administratoradgang'],
    ['hej@eksempel.dk','Fjern administratoradgang for','Fjern administratoradgang'],
    ['nyhed@eksempel.dk','Fjern administratoradgang for','Fjern administratoradgang'],
  ]) {
    await page.getByRole('button', {name:'Flere handlinger for ' + email, exact:true}).click();
    if (email === 'nyhed@eksempel.dk') {
      assert.equal(await page.getByRole('button', {name:'Nulstil adgangskode for ' + email}).count(), 0);
    }
    await page.getByRole('button', {name:action + ' ' + email, exact:true}).click();
    await dialog.getByLabel('Din adgangskode til Veyro Mail').fill('operator-fixture');
    await dialog.getByRole('button', {name:button, exact:true}).click();
    await page.getByText('Administratoradgangen er ' + (button.startsWith('Giv') ? 'tildelt ' : 'fjernet for ') + email + '.', {exact:true}).waitFor();
  }
  assert.deepEqual(changes.map(change => [change.email,change.admin]), [
    ['hej@eksempel.dk',true],['hej@eksempel.dk',false],['nyhed@eksempel.dk',false],
  ]);
});

test('losing an organization grant closes an open administrator form and clears previous directory data', async t => {
  const {page, changes, revokeRole} = await administration(t, {tenant:true});
  await page.getByRole('button', {name:'Deaktivér hej@eksempel.dk', exact:true}).click();
  revokeRole();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Din adgangskode til Veyro Mail').fill('operator-fixture');
  await dialog.getByRole('button', {name:'Deaktivér postkasse', exact:true}).click();
  await page.getByText(/Din administratoradgang er ændret/).waitFor();
  assert.equal(await dialog.count(), 0);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#mailboxes li').count(), 0);
  assert.equal(await page.locator('[name="currentPassword"]').inputValue(), '');
  assert.equal(changes.length, 0);
});
