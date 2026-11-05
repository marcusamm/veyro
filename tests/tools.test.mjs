import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, ROOT, csrfFrom, startStack, setMockState } from './harness.mjs';
import { createPlanningData } from '../src/lib/planning';

let stack;
let anna;
let bo;
const emails = async () => (await fetch(stack.mock.url + '/__mock/emails')).json();
const calls = async () => (await fetch(stack.mock.url + '/__mock/calls')).json();
const hash = s => createHash('sha256').update(s).digest('hex');
function sql(query) {
  const out = execFileSync(path.join(ROOT, 'node_modules', '.bin', 'wrangler'),
    ['d1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist, '--config', path.join(ROOT, '.wrangler-test.toml'), '--json', '--command', query],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'pipe' }).toString();
  return JSON.parse(out)[0].results;
}
async function requestLink(email, lang = 'en', client = new Client(stack.base)) {
  const home = await client.get(`/tools/legacy?lang=${lang}`);
  const result = await client.post('/tools/sign-in', { _csrf: csrfFrom(home.html), name: 'TEST ' + email.split('@')[0], email, lang });
  expect(result.status).toBe(200);
  const mail = (await emails()).filter(m => m.to[0] === email).at(-1);
  expect(mail).toBeTruthy();
  const link = mail.text.match(/https?:\/\/\S+\/tools\/verify\?[^\s]+/)[0];
  return { client, mail, link, result };
}
async function signup(email, lang = 'en') {
  const flow = await requestLink(email, lang);
  const url = new URL(flow.link);
  const confirmation = await flow.client.get(url.pathname + url.search);
  expect(confirmation.status).toBe(200);
  const result = await flow.client.post('/tools/verify', { _csrf: csrfFrom(confirmation.html), token: url.searchParams.get('token'), lang });
  expect(result.status).toBe(303);
  expect(result.headers.get('location')).toBe(`/tools/legacy?lang=${lang}`);
  return { ...flow, result, token: url.searchParams.get('token') };
}
async function create(client, templateId = 'stock', name = 'TEST Stock plan', lang = 'en') {
  const page = await client.get(`/tools/legacy?lang=${lang}`);
  const res = await client.post('/tools/projects', { _csrf: csrfFrom(page.html), templateId, name, lang });
  expect(res.status).toBe(303);
  const location = res.headers.get('location');
  const id = location.match(/\/projects\/([a-f0-9-]+)/)[1];
  return { id, location };
}
async function postProject(client, id, action, fields = {}) {
  const page = await client.get(`/tools/projects/${id}?lang=en`);
  return client.post(`/tools/projects/${id}/${action}`, { _csrf: csrfFrom(page.html), lang: 'en', ...fields });
}
function project(id) { return sql(`SELECT * FROM tool_projects WHERE id = '${id}'`)[0]; }
function draftFrom(html) {
  const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const field = name => decode(html.match(new RegExp(`name="${name}" value="([^"]*)"`))[1]);
  return {
    name: field('name'), version: field('version'), data: JSON.parse(field('data')),
    currency: html.match(/<option value="([A-Z]+)" selected>/)[1],
  };
}

beforeAll(async () => {
  stack = await startStack({ minMonths: 0 });
  anna = (await signup('tools-anna@example.com')).client;
  bo = (await signup('tools-bo@example.com', 'sv')).client;
});
afterAll(async () => { await stack?.stop(); });

describe('Replacement and access to earlier plans', () => {
  it.each(['/tools', '/tools/', '/tools?lang=da', '/tools?lang=en', '/tools/?lang=sv'])('forwards %s to the logistics calculator', async path => {
    const page = await new Client(stack.base).get(path);
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/logistik/');
  });

  it.each([['da', 'Åbn logistikberegneren'], ['en', 'Open the logistics calculator'], ['sv', 'Öppna logistikkalkylatorn']])('keeps earlier plans reachable with a replacement notice in %s', async (lang, label) => {
    const page = await anna.get(`/tools/legacy?lang=${lang}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain(`href="/logistik/">${label}`);
    expect(page.html).toContain(`/tools/legacy?lang=${lang}#plans`);
  });

  it('accepts already-issued old login links and returns to earlier plans', async () => {
    const flow = await requestLink('tools-old-link@example.com', 'sv');
    const url = new URL(flow.link);
    const token = url.searchParams.get('token');
    sql(`UPDATE login_tokens SET next='/tools?lang=sv' WHERE token_hash='${hash(token)}'`);
    const confirmation = await flow.client.get(url.pathname + url.search);
    expect(confirmation.status).toBe(200);
    const response = await flow.client.post('/tools/verify', { _csrf: csrfFrom(confirmation.html), token, lang: 'en' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/tools/legacy?lang=sv');
    expect((await flow.client.get(response.headers.get('location'))).html).toContain('tools-old-link@example.com');
  });
});

describe('Free verified Veyro accounts', () => {
  it.each([['en', 'Your sign-in link'], ['da', 'Dit login-link'], ['sv', 'Din inloggningslänk']])('creates a free account after email verification in %s', async (lang, subject) => {
    const email = `tools-new-${lang}@example.com`;
    const flow = await requestLink(email, lang);
    expect(flow.mail.subject).toContain(subject);
    expect(flow.mail.text).not.toMatch(/Stripe|videre til betaling|proceed to payment/);
    expect(sql(`SELECT id FROM customers WHERE email = '${email}'`)).toHaveLength(0);
    const url = new URL(flow.link);
    const scanner = await flow.client.get(url.pathname + url.search);
    expect(scanner.status).toBe(200);
    expect(sql(`SELECT id FROM customers WHERE email = '${email}'`)).toHaveLength(0);
    const verified = await flow.client.post('/tools/verify', { _csrf: csrfFrom(scanner.html), token: url.searchParams.get('token'), lang });
    expect(verified.status).toBe(303);
    const [customer] = sql(`SELECT * FROM customers WHERE email = '${email}'`);
    expect(customer.stripe_customer_id).toBeNull();
    expect(sql(`SELECT id FROM subscriptions WHERE customer_id = ${customer.id}`)).toHaveLength(0);
    const home = await flow.client.get(verified.headers.get('location'));
    expect(home.html).toContain(`lang="${lang}"`);
    expect(home.html).toContain(email);
    const replay = await flow.client.post('/tools/verify', { _csrf: csrfFrom(home.html), token: url.searchParams.get('token'), lang });
    expect(replay.status).toBe(400);
  });

  it('never creates billing objects or marketing leads while using free tools', async () => {
    expect(await calls()).toEqual([]);
    expect(sql('SELECT id FROM subscriptions')).toEqual([]);
    expect(sql('SELECT id FROM leads')).toEqual([]);
  });

  it('preserves existing customer profile and subscription fields when opening free tools', async () => {
    sql("INSERT INTO customers (email,name,stripe_customer_id,created_at,updated_at) VALUES ('tools-existing@example.com','Original customer name','cus_tools_existing',100,200)");
    const before = sql("SELECT * FROM customers WHERE email='tools-existing@example.com'")[0];
    sql(`INSERT INTO subscriptions(id,customer_id,status,amount,currency,updated_at) VALUES ('sub_tools_existing',${before.id},'active',19900,'dkk',200)`);
    const subscription = sql("SELECT * FROM subscriptions WHERE id='sub_tools_existing'")[0];
    const flow = await signup('tools-existing@example.com');
    await create(flow.client, 'budget', 'TEST Existing customer free plan');
    expect(sql("SELECT * FROM customers WHERE email='tools-existing@example.com'")[0]).toEqual(before);
    expect(sql("SELECT * FROM subscriptions WHERE id='sub_tools_existing'")[0]).toEqual(subscription);
    expect(await calls()).toEqual([]);
  });

  it('rejects expired links without creating an account', async () => {
    const flow = await requestLink('tools-expired@example.com');
    const token = new URL(flow.link).searchParams.get('token');
    sql(`UPDATE login_tokens SET expires_at=1 WHERE token_hash='${hash(token)}'`);
    const home = await flow.client.get('/tools/legacy?lang=en');
    const result = await flow.client.post('/tools/verify', { _csrf: csrfFrom(home.html), token, lang: 'en' });
    expect(result.status).toBe(400);
    expect(sql("SELECT id FROM customers WHERE email='tools-expired@example.com'")).toEqual([]);
  });

  it('does not consume tokens issued for another login flow', async () => {
    const client = new Client(stack.base);
    const page = await client.get('/login');
    const response = await client.post('/login', { _csrf: csrfFrom(page.html), email: 'tools-anna@example.com' });
    expect(response.status).toBe(200);
    const { waitFor } = await import('./harness.mjs');
    const mail = await waitFor(async () => (await emails()).find(m => m.to[0] === 'tools-anna@example.com' && m.text.includes('/login/bekraeft')));
    const token = mail.text.match(/\/login\/bekraeft\?token=([A-Za-z0-9_-]+)/)[1];
    const toolsPage = await client.get('/tools/legacy?lang=en');
    const wrong = await client.post('/tools/verify', { _csrf: csrfFrom(toolsPage.html), token, lang: 'en' });
    expect(wrong.status).toBe(400);
    expect(sql(`SELECT used_at FROM login_tokens WHERE token_hash = '${hash(token)}'`)[0].used_at).toBeNull();
    const right = await client.post('/login/bekraeft', { _csrf: csrfFrom(toolsPage.html), token });
    expect(right.status).toBe(303);
  });

  it('reports email delivery failure and invalidates the unsent token', async () => {
    const email = 'tools-mail-failure@example.com';
    await setMockState(stack.mock, { failEmailTo: [email] });
    const client = new Client(stack.base);
    const page = await client.get('/tools/legacy?lang=en');
    const res = await client.post('/tools/sign-in', { _csrf: csrfFrom(page.html), name: 'TEST Failure', email, lang: 'en' });
    expect(res.status).toBe(503);
    expect(res.html).toContain('could not send');
    expect(sql(`SELECT token_hash FROM login_tokens WHERE email = '${email}'`)).toHaveLength(0);
    expect(sql(`SELECT id FROM customers WHERE email = '${email}'`)).toHaveLength(0);
    await setMockState(stack.mock, { failEmailTo: [] });
  });

  it('rate limits link requests and rejects invalid names and email addresses', async () => {
    const client = new Client(stack.base);
    const page = await client.get('/tools/legacy?lang=en');
    const base = { _csrf: csrfFrom(page.html), name: 'TEST Rate', email: 'tools-rate@example.com', lang: 'en' };
    expect((await client.post('/tools/sign-in', { ...base, email: 'bad' })).status).toBe(400);
    expect((await client.post('/tools/sign-in', { ...base, name: '' })).status).toBe(400);
    for (let n = 0; n < 3; n++) expect((await client.post('/tools/sign-in', base)).status).toBe(200);
    expect((await client.post('/tools/sign-in', base)).status).toBe(429);
  });

  it('requires CSRF and rejects cross-origin writes before sending email', async () => {
    const client = new Client(stack.base);
    const page = await client.get('/tools/legacy?lang=en');
    const form = { name: 'TEST CSRF', email: 'tools-csrf@example.com', lang: 'en' };
    expect((await client.post('/tools/sign-in', form)).status).toBe(403);
    expect((await client.post('/tools/sign-in', { ...form, _csrf: csrfFrom(page.html) }, { Origin: 'https://attacker.example' })).status).toBe(403);
    expect((await emails()).some(m => m.to[0] === form.email)).toBe(false);
  });
});

describe('Private planning workspaces', () => {
  it('requires sign-in for reading, creating and previewing private work', async () => {
    const client = new Client(stack.base);
    const home = await client.get('/tools/legacy?lang=en');
    const csrf = csrfFrom(home.html);
    expect((await client.get('/tools/projects/00000000-0000-0000-0000-000000000000?lang=en')).status).toBe(303);
    expect((await client.post('/tools/projects', { _csrf: csrf, templateId: 'stock', name: 'TEST', lang: 'en' })).status).toBe(303);
    expect((await client.post('/tools/preview', { _csrf: csrf, templateId: 'stock', currency: 'EUR', data: JSON.stringify(createPlanningData('stock')), lang: 'en' })).status).toBe(401);
  });

  it.each(['stock', 'suppliers', 'eoq', 'budget'])('creates and reopens the %s template with stored sample inputs', async templateId => {
    const { id, location } = await create(anna, templateId, `TEST ${templateId}`);
    const row = project(id);
    expect(row.template_id).toBe(templateId);
    expect(row.currency).toBe('EUR');
    expect(JSON.parse(row.data_json)).toEqual(createPlanningData(templateId));
    const page = await anna.get(location);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toContain('no-store');
    expect(page.html).toContain(`TEST ${templateId}`);
  });

  it('saves edited figures with optimistic versions and retains a conflicting draft', async () => {
    const { id } = await create(anna, 'stock');
    const data = createPlanningData('stock');
    data.rows[0].onHand = 15;
    const first = await postProject(anna, id, 'save', { name: 'TEST Updated stock', currency: 'SEK', data: JSON.stringify(data), version: '1' });
    expect(first.status).toBe(303);
    expect(project(id).version).toBe(2);
    expect(JSON.parse(project(id).data_json).rows[0].onHand).toBe(15);
    const stale = { ...data, rows: data.rows.map((r, i) => i ? r : { ...r, onHand: 22 }) };
    const conflict = await postProject(anna, id, 'save', { name: 'TEST Unsaved draft', currency: 'DKK', data: JSON.stringify(stale), version: '1' });
    expect(conflict.status).toBe(409);
    expect(conflict.html).toContain('TEST Unsaved draft');
    expect(project(id).name).toBe('TEST Updated stock');
    expect(project(id).version).toBe(2);
    const copied = await postProject(anna, id, 'duplicate', { name: 'TEST Rescued draft', currency: 'DKK', data: JSON.stringify(stale) });
    expect(copied.status).toBe(303);
    const copyId = copied.headers.get('location').match(/\/projects\/([a-f0-9-]+)/)[1];
    expect(JSON.parse(project(copyId).data_json).rows[0].onHand).toBe(22);
    expect(project(copyId).currency).toBe('DKK');
    expect(JSON.parse(project(id).data_json).rows[0].onHand).toBe(15);
  });

  it('denies another account read, save, duplicate, archive and restore access', async () => {
    const { id } = await create(anna, 'budget', 'TEST Anna private budget');
    const before = project(id);
    const page = await bo.get('/tools/legacy?lang=sv');
    const csrf = csrfFrom(page.html);
    expect(page.html).not.toContain('TEST Anna private budget');
    expect((await bo.get(`/tools/projects/${id}?lang=sv`)).status).toBe(404);
    for (const action of ['save', 'duplicate', 'archive', 'restore']) {
      const res = await bo.post(`/tools/projects/${id}/${action}`, { _csrf: csrf, name: 'TEST Hijack', currency: 'EUR', data: JSON.stringify(createPlanningData('budget')), version: '1', lang: 'en' });
      expect(res.status).toBe(404);
      expect(res.html).not.toContain('TEST Anna private budget');
    }
    expect(project(id)).toEqual(before);
  });

  it('preserves drafts and their stale version when save or copy is rate limited', async () => {
    const email = 'tools-draft-rate@example.com';
    const { client } = await signup(email);
    const { id } = await create(client, 'budget', 'TEST Saved budget');
    sql(`UPDATE tool_projects SET version=2 WHERE id='${id}'`);
    const before = project(id);
    const data = createPlanningData('budget');
    data.settings.budget = 123;
    data.rows[0].quantity = 77;
    const draft = { name: 'TEST Unsaved limited draft', currency: 'SEK', version: '1', data };
    const key = `tools:write:${hash(email)}`;
    sql(`INSERT INTO rate_limits(key,count,reset_at) VALUES ('${key}',60,${Math.floor(Date.now() / 1000) + 300})
      ON CONFLICT(key) DO UPDATE SET count=60,reset_at=excluded.reset_at`);
    for (const action of ['save', 'duplicate']) {
      const res = await postProject(client, id, action, { ...draft, data: JSON.stringify(data) });
      expect(res.status).toBe(429);
      expect(draftFrom(res.html)).toEqual(draft);
    }
    expect(project(id)).toEqual(before);
    expect(sql(`SELECT id FROM tool_projects WHERE customer_id=${before.customer_id}`)).toHaveLength(1);
  });

  it('preserves drafts and their stale version when save as copy exceeds the quota', async () => {
    const { client } = await signup('tools-draft-quota@example.com');
    const { id } = await create(client, 'budget', 'TEST Saved quota budget');
    sql(`UPDATE tool_projects SET version=2 WHERE id='${id}'`);
    const before = project(id);
    sql(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<49)
      INSERT INTO tool_projects(id,customer_id,template_id,name,currency,data_json,version,created_at,updated_at)
      SELECT printf('22222222-2222-2222-2222-%012d',n),${before.customer_id},template_id,'TEST Draft quota '||n,currency,data_json,1,created_at,updated_at FROM seq,tool_projects WHERE id='${id}'`);
    const data = createPlanningData('budget');
    data.settings.budget = 234;
    data.rows[0].quantity = 88;
    const draft = { name: 'TEST Unsaved quota draft', currency: 'DKK', version: '1', data };
    const res = await postProject(client, id, 'duplicate', { ...draft, data: JSON.stringify(data) });
    expect(res.status).toBe(409);
    expect(draftFrom(res.html)).toEqual(draft);
    expect(project(id)).toEqual(before);
    expect(sql(`SELECT count(*) AS n FROM tool_projects WHERE customer_id=${before.customer_id}`)[0].n).toBe(50);
  });

  it('archives recoverably and rejects writes until restored', async () => {
    const { id } = await create(bo, 'budget', 'TEST Archived plan', 'sv');
    expect(project(id).currency).toBe('SEK');
    expect((await postProject(bo, id, 'archive', { version: '1' })).status).toBe(303);
    expect(project(id).archived_at).not.toBeNull();
    expect(project(id).version).toBe(2);
    const page = await bo.get(`/tools/projects/${id}?lang=sv`);
    expect(page.status).toBe(200);
    expect((await postProject(bo, id, 'save', { name: 'TEST Changed', currency: 'SEK', data: JSON.stringify(createPlanningData('budget')), version: '2' })).status).toBe(409);
    expect((await postProject(bo, id, 'restore', { version: '2' })).status).toBe(303);
    expect(project(id).archived_at).toBeNull();
    expect(project(id).version).toBe(3);
  });

  it('validates JSON, numerical ranges, currencies, names and unknown templates without mutating saved work', async () => {
    const { id } = await create(anna, 'suppliers');
    const before = project(id);
    const invalid = createPlanningData('suppliers');
    invalid.rows[0].packSize = 0;
    const good = { name: 'TEST Suppliers', currency: 'EUR', version: '1', data: JSON.stringify(createPlanningData('suppliers')) };
    for (const overrides of [{ data: '{' }, { data: JSON.stringify(invalid) }, { currency: 'XYZ' }, { name: '' }, { version: 'banana' }, { data: JSON.stringify({ settings: {}, rows: [] }) }]) {
      const res = await postProject(anna, id, 'save', { ...good, ...overrides });
      expect(res.status).toBe(400);
      if (overrides.data === JSON.stringify(invalid)) {
        expect(res.html).toContain('Row 1: Base units per pack');
        expect(res.html).not.toContain('rows.0.packSize');
      }
    }
    expect(project(id)).toEqual(before);
    const home = await anna.get('/tools/legacy?lang=en');
    expect((await anna.post('/tools/projects', { _csrf: csrfFrom(home.html), templateId: 'javascript', name: 'TEST Bad template', lang: 'en' })).status).toBe(400);
  });

  it('recalculates a preview without saving it and rejects invalid calculation inputs', async () => {
    const { id } = await create(anna, 'budget', 'TEST Preview budget');
    const page = await anna.get(`/tools/projects/${id}?lang=en`);
    const data = createPlanningData('budget');
    data.settings.budget = 100;
    const payload = { _csrf: csrfFrom(page.html), templateId: 'budget', currency: 'EUR', data: JSON.stringify(data), lang: 'en' };
    const preview = await anna.post('/tools/preview', payload);
    expect(preview.status).toBe(200);
    expect(JSON.parse(preview.html).html).toBeTruthy();
    expect(JSON.parse(project(id).data_json).settings.budget).toBe(5000);
    data.rows[0].quantity = -1;
    const invalid = await anna.post('/tools/preview', { ...payload, data: JSON.stringify(data) });
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.html).error).toBeTruthy();
  });

  it('rejects oversized requests before form processing', async () => {
    const page = await anna.get('/tools/legacy?lang=en');
    const res = await anna.post('/tools/projects', { _csrf: csrfFrom(page.html), templateId: 'stock', name: 'x'.repeat(100_000), lang: 'en' });
    expect(res.status).toBe(413);
  });

  it('enforces active project quota atomically and allows a slot after archive', async () => {
    const flow = await signup('tools-quota@example.com');
    const { id } = await create(flow.client, 'budget', 'TEST Quota seed');
    const row = project(id);
    sql(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<49)
      INSERT INTO tool_projects(id, customer_id, template_id, name, currency, data_json, version, created_at, updated_at)
      SELECT printf('00000000-0000-0000-0000-%012d',n), ${row.customer_id}, template_id, 'TEST Quota '||n, currency, data_json, 1, created_at, updated_at FROM seq, tool_projects WHERE id='${id}'`);
    const home = await flow.client.get('/tools/legacy?lang=en');
    const full = await flow.client.post('/tools/projects', { _csrf: csrfFrom(home.html), templateId: 'stock', name: 'TEST Over quota', lang: 'en' });
    expect(full.status).toBe(409);
    expect(sql(`SELECT count(*) AS n FROM tool_projects WHERE customer_id=${row.customer_id} AND archived_at IS NULL`)[0].n).toBe(50);
    expect((await postProject(flow.client, id, 'archive', { version: '1' })).status).toBe(303);
    const available = await flow.client.get('/tools/legacy?lang=en');
    const racing = await Promise.all(['A', 'B'].map(suffix => flow.client.post('/tools/projects', {
      _csrf: csrfFrom(available.html), templateId: 'stock', name: 'TEST Released slot ' + suffix, lang: 'en',
    })));
    expect(racing.map(r => r.status).sort()).toEqual([303, 409]);
    expect(sql(`SELECT count(*) AS n FROM tool_projects WHERE customer_id=${row.customer_id} AND archived_at IS NULL`)[0].n).toBe(50);
    expect((await postProject(flow.client, id, 'restore', { version: '2' })).status).toBe(409);
  });

  it('bounds total saved plans including the archive and explains that limit', async () => {
    const flow = await signup('tools-storage-quota@example.com');
    const { id } = await create(flow.client, 'budget', 'TEST Storage seed');
    const row = project(id);
    sql(`UPDATE tool_projects SET archived_at=1 WHERE id='${id}';
      WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<199)
      INSERT INTO tool_projects(id, customer_id, template_id, name, currency, data_json, version, created_at, updated_at, archived_at)
      SELECT printf('11111111-1111-1111-1111-%012d',n), ${row.customer_id}, template_id, 'TEST Archived '||n, currency, data_json, 1, created_at, updated_at, 1 FROM seq, tool_projects WHERE id='${id}'`);
    const home = await flow.client.get('/tools/legacy?lang=en');
    const full = await flow.client.post('/tools/projects', { _csrf: csrfFrom(home.html), templateId: 'stock', name: 'TEST Over storage', lang: 'en' });
    expect(full.status).toBe(409);
    expect(full.html).toContain('200 saved plans');
    expect(sql(`SELECT count(*) AS n FROM tool_projects WHERE customer_id=${row.customer_id}`)[0].n).toBe(200);
  });

  it('signs out without leaving the private workspace readable', async () => {
    const flow = await signup('tools-logout@example.com', 'da');
    const { id } = await create(flow.client, 'eoq', 'TEST Logout plan', 'da');
    const page = await flow.client.get(`/tools/projects/${id}?lang=da`);
    const res = await flow.client.post('/tools/logout', { _csrf: csrfFrom(page.html), lang: 'da' });
    expect(res.headers.get('location')).toBe('/tools/legacy?lang=da');
    expect((await flow.client.get(`/tools/projects/${id}?lang=da`)).status).toBe(303);
  });
});
