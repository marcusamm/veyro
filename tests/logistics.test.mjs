import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, ROOT, csrfFrom, login, setMockState, startStack } from './harness.mjs';
import { SAMPLES, tco } from '../src/lib/logistics-calculations.mjs';
import { TRANSPORT_SAMPLES, transportCalculators } from '../src/lib/logistics-transport-calculations.mjs';
import { canonicalizeInput } from '../src/lib/logistics-input.mjs';

let stack, anna, bo, transportOwner;
const hash = text => createHash('sha256').update(text).digest('hex');
const json = response => JSON.parse(response.html);
const emails = async () => (await fetch(stack.mock.url + '/__mock/emails')).json();
function sql(query) {
  const out = execFileSync(path.join(ROOT, 'node_modules/.bin/wrangler'), ['d1', 'execute', 'veyro-kundepanel', '--local',
    '--persist-to', stack.persist, '--config', path.join(ROOT, '.wrangler-test.toml'), '--json', '--command', query],
  { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'pipe' }).toString();
  return JSON.parse(out)[0].results;
}
async function session(client) { return json(await client.get('/logistik/api/session')); }
async function post(client, route, fields = {}, headers = {}) {
  return client.post('/logistik' + route, { _csrf: (await session(client)).csrf, ...fields }, headers);
}
async function requestLink(email, name = 'TEST Person') {
  const client = new Client(stack.base), page = await client.get('/logistik/login');
  const response = await client.post('/logistik/login', { _csrf: csrfFrom(page.html), name, email });
  expect(response.status).toBe(200);
  const mail = (await emails()).filter(m => m.to[0] === email).at(-1);
  const link = new URL(mail.text.match(/https?:\/\/\S+\/logistik\/verify\?token=\S+/)[0]);
  return { client, response, mail, link, token: link.searchParams.get('token') };
}
async function verify(flow) {
  const page = await flow.client.get(flow.link.pathname + flow.link.search);
  expect(page.status).toBe(200);
  return flow.client.post('/logistik/verify', { _csrf: csrfFrom(page.html), token: flow.token });
}
async function signup(email, name) {
  const flow = await requestLink(email, name), response = await verify(flow);
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/logistik/mine/');
  return flow.client;
}
async function create(client, toolId = 'eoq', name = 'TEST Calculation', input = SAMPLES[toolId === 'genbestilling' ? 'rop' : toolId]) {
  const response = await post(client, '/api/calculations', { toolId, name, input: JSON.stringify(canonicalizeInput(toolId, input)) });
  expect(response.status, response.html).toBe(201);
  return json(response).calculation;
}
const route = (id, suffix = '') => `/api/calculations/${id}${suffix}`;
const read = async (client, id) => client.get('/logistik' + route(id));
const list = async (client, archived = false) => json(await client.get('/logistik/api/calculations' + (archived ? '?archived=1' : ''))).calculations;
const capitalInput = () => ({
  periodYears: 2, annualQuantity: 365, capital: { annualRatePercent: 10 },
  alternatives: ['order', 'receipt'].map((paymentStart, index) => ({
    id: `supplier-${index}`, name: `TEST Supplier ${index + 1}`, ordersPerYear: 12, residualValue: 0,
    costs: [
      { id: `purchase-${index}`, label: 'Materialer', amount: 1000, frequency: 'unit' },
      { id: `storage-${index}`, label: 'Lager', amount: 1000, frequency: 'year' },
    ],
    capital: { purchaseCostId: `purchase-${index}`, leadDays: 30, paymentStart,
      supplierCreditDays: 10, inventoryDays: 20, customerCreditDays: 0, interestMode: 'add' },
  })),
});

beforeAll(async () => {
  stack = await startStack({ minMonths: 0 });
  anna = await signup('logistics-anna@example.com', 'TEST Anna');
  bo = await signup('logistics-bo@example.com', 'TEST Bo');
  transportOwner = await signup('logistics-transport@example.com', 'TEST Transport');
});
afterAll(async () => { await stack?.stop(); });

describe('Same Veyro account, optional login', () => {
  it('replaces the old marketing entrypoints and account navigation without hiding earlier saved plans', async () => {
    const marketing = new Client(stack.site);
    marketing.cookies.set('veyro_language', 'da');
    for (const url of ['/tools', '/tools/', '/en/tools', '/en/tools/', '/sv/tools', '/sv/tools/']) {
      const response = await marketing.get(url);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(stack.base + '/logistik/');
    }
    for (const [url, label] of [['/', 'Logistikberegner'], ['/en/', 'Logistics calculator'], ['/sv/', 'Logistikberäknare']]) {
      const response = await marketing.get(url);
      expect(response.status).toBe(200);
      expect(response.html).toContain(`href="https://kunde.veyro.dk/logistik/">${label}</a>`);
      expect(response.html).not.toContain('href="https://kunde.veyro.dk/tools');
    }
    const before = await anna.get('/konto');
    expect(before.status).toBe(200);
    expect(before.html).toContain('href="/logistik/">Logistikberegner</a>');
    expect(before.html).not.toContain('Gratis værktøjer');
    expect(before.html).not.toContain('Mine logistikberegninger');
    expect(before.html).not.toContain('Tidligere gemte planer');
    const owner = sql("SELECT id FROM customers WHERE email = 'logistics-anna@example.com'")[0].id;
    sql(`INSERT INTO tool_projects (id, customer_id, template_id, name, currency, data_json, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', ${owner}, 'stock', 'TEST Earlier plan', 'DKK', '{}', 1, 1)`);
    expect((await anna.get('/konto')).html).toContain('href="/tools/legacy?lang=da">Tidligere gemte planer</a>');
    expect((await bo.get('/konto')).html).not.toContain('Tidligere gemte planer');
  });
  it('serves public calculators and the account shell without setting an identity cookie', async () => {
    const client = new Client(stack.base);
    for (const url of ['/logistik/', '/logistik/vaerktoejer/eoq/', '/logistik/mine/', '/logistik/assets/account.mjs']) {
      const response = await client.get(url);
      expect(response.status, `${url}: ${response.html.slice(0, 160)}`).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect((await client.get('/logistik')).headers.get('location')).toBe('/logistik/');
    const response = await client.get('/logistik/downloads/eoq.xlsx');
    expect(response.status).toBe(200); expect(response.html.slice(0, 2)).toBe('PK');
  });
  it('returns an anonymous session without creating a customer or calculation', async () => {
    const client = new Client(stack.base), before = sql('SELECT COUNT(*) AS n FROM customers')[0].n;
    const response = await client.get('/logistik/api/session');
    expect(json(response)).toMatchObject({ authenticated: false, email: null });
    expect(json(response).csrf).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(sql('SELECT COUNT(*) AS n FROM customers')[0].n).toBe(before);
    expect((await client.get('/logistik/api/calculations')).status).toBe(401);
    expect((await post(client, '/api/calculations', { toolId: 'eoq', name: 'TEST', input: JSON.stringify(SAMPLES.eoq) })).status).toBe(401);
  });
  it('creates an account only after confirmation POST, and consumes the link once', async () => {
    const email = 'logistics-new@example.com', flow = await requestLink(email);
    expect(flow.mail.subject).toContain('Logistikværktøjer');
    expect(flow.mail.text).not.toMatch(/Stripe|abonnement|betaling/);
    expect(sql(`SELECT id FROM customers WHERE email = '${email}'`)).toHaveLength(0);
    const scanner = await flow.client.get(flow.link.pathname + flow.link.search);
    expect(scanner.status).toBe(200);
    expect(flow.response.html).toContain('/logistik/assets/login.mjs');
    expect(scanner.html).not.toContain('/logistik/assets/login.mjs');
    expect(sql(`SELECT used_at FROM login_tokens WHERE token_hash = '${hash(flow.token)}'`)[0].used_at).toBeNull();
    expect(sql(`SELECT id FROM customers WHERE email = '${email}'`)).toHaveLength(0);
    expect((await verify(flow)).status).toBe(303);
    const customer = sql(`SELECT * FROM customers WHERE email = '${email}'`)[0];
    expect(customer.stripe_customer_id).toBeNull();
    expect(sql(`SELECT id FROM subscriptions WHERE customer_id = ${customer.id}`)).toHaveLength(0);
    expect((await session(flow.client)).email).toBe(email);
    expect((await post(flow.client, '/verify', { token: flow.token })).status).toBe(400);
  });
  it('reuses ordinary Veyro login and preserves an existing customer profile', async () => {
    const before = sql("SELECT * FROM customers WHERE email = 'logistics-anna@example.com'")[0];
    const regular = await login(stack, before.email);
    expect(await session(regular.client)).toMatchObject({ authenticated: true, email: before.email });
    expect((await regular.client.get('/logistik/login')).headers.get('location')).toBe('/logistik/mine/');
    const flow = await requestLink(before.email, 'A different submitted name');
    expect((await verify(flow)).status).toBe(303);
    const after = sql(`SELECT * FROM customers WHERE id = ${before.id}`)[0];
    expect(after.name).toBe(before.name);
    expect(after.stripe_customer_id).toBe(before.stripe_customer_id);
    expect(sql(`SELECT id FROM customers WHERE email = '${before.email}'`)).toHaveLength(1);
  });
  it('rejects expired tokens and leaves another auth flow token unconsumed', async () => {
    const flow = await requestLink('logistics-expired@example.com');
    sql(`UPDATE login_tokens SET expires_at = 0 WHERE token_hash = '${hash(flow.token)}'`);
    expect((await flow.client.get(flow.link.pathname + flow.link.search)).status).toBe(400);
    expect((await post(flow.client, '/verify', { token: flow.token })).status).toBe(400);
    const another = await requestLink('logistics-other-flow@example.com');
    sql(`UPDATE login_tokens SET next = '/tools?lang=da' WHERE token_hash = '${hash(another.token)}'`);
    expect((await post(another.client, '/verify', { token: another.token })).status).toBe(400);
    expect(sql(`SELECT used_at FROM login_tokens WHERE token_hash = '${hash(another.token)}'`)[0].used_at).toBeNull();
  });
  it('keeps redirects fixed and escapes auth input', async () => {
    const client = new Client(stack.base), page = await client.get('/logistik/login');
    const response = await client.post('/logistik/login', { _csrf: csrfFrom(page.html), name: '<script>alert(1)</script>', email: 'invalid', next: 'https://example.com/' });
    expect(response.status).toBe(400);
    expect(response.html).not.toContain('<script>alert');
    expect(response.html).toContain('&lt;script&gt;');
  });
  it('shows delivery failure with no usable token or account', async () => {
    const email = 'logistics-mail-fail@example.com', client = new Client(stack.base);
    await setMockState(stack.mock, { failEmailTo: [email] });
    const response = await post(client, '/login', { name: 'TEST', email });
    expect(response.status).toBe(503); expect(response.html).toContain('kunne ikke sendes');
    expect(sql(`SELECT token_hash FROM login_tokens WHERE email = '${email}'`)).toHaveLength(0);
    expect(sql(`SELECT id FROM customers WHERE email = '${email}'`)).toHaveLength(0);
    await setMockState(stack.mock, { failEmailTo: [] });
  });
  it('rate limits login by hashed email without disclosing whether an account exists', async () => {
    const email = 'logistics-limited@example.com', client = new Client(stack.base);
    sql(`INSERT INTO rate_limits (key, count, reset_at) VALUES ('logistics:login-email:${hash(email)}', 3, ${Math.floor(Date.now() / 1000) + 900})`);
    const response = await post(client, '/login', { name: 'TEST', email });
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('900');
    expect(sql(`SELECT id FROM customers WHERE email = '${email}'`)).toHaveLength(0);
  });
});

describe('Private saved calculations', () => {
  it('preserves explicitly selected purchase IDs and capital terms across save, reopen, update and copy', async () => {
    const input = capitalInput();
    const item = await create(anna, 'tco', 'TEST Capital terms', input);
    const reopened = json(await read(anna, item.id)).calculation;
    expect(reopened.input).toEqual(input);
    expect(tco(reopened.input).alternatives.map(a => a.comparisonTotalCost)).toEqual([740000, 734000]);

    const updated = structuredClone(input);
    updated.alternatives[0].capital = { ...updated.alternatives[0].capital,
      paymentStart: 'other', paymentStartDays: 5, interestMode: 'replace',
      existingInterestCostId: 'storage-0', existingInterestAnnual: 500 };
    const response = await post(anna, route(item.id), { name: 'TEST Capital revised', version: 1, input: JSON.stringify(updated) });
    expect(response.status, response.html).toBe(200);
    expect(json(response).calculation).toMatchObject({ version: 2, input: updated });
    const copy = await post(anna, route(item.id, '/copy'), { name: 'TEST Capital copy', version: 2 });
    expect(copy.status, copy.html).toBe(201);
    expect(json(copy).calculation.input).toEqual(updated);
    const copied = json(await read(anna, json(copy).calculation.id)).calculation;
    expect(copied.input.alternatives[0].capital.purchaseCostId).toBe('purchase-0');
    expect(copied.input.alternatives[0].capital.existingInterestCostId).toBe('storage-0');
    expect(tco(copied.input).alternatives[0].comparisonTotalCost).toBe(738000);
  });
  it('opens and copies a pre-capital TCO record without adding defaults or rewriting stored input', async () => {
    const owner = sql("SELECT id FROM customers WHERE email = 'logistics-anna@example.com'")[0].id;
    const id = '00000000-0000-4000-8000-000000000002';
    const raw = JSON.stringify(SAMPLES.tco).replaceAll("'", "''");
    sql(`INSERT INTO logistics_calculations (id,customer_id,tool_id,name,input_json,created_at,updated_at)
      VALUES ('${id}',${owner},'tco','TEST Older TCO','${raw}',1,1)`);
    const before = sql(`SELECT input_json,version FROM logistics_calculations WHERE id = '${id}'`)[0];
    const response = await read(anna, id), input = json(response).calculation.input;
    expect(response.status).toBe(200);
    expect(input).toEqual(SAMPLES.tco);
    expect(input).not.toHaveProperty('capital');
    expect(input.alternatives.every(a => !Object.hasOwn(a, 'capital'))).toBe(true);
    expect(tco(input).alternatives.map(a => a.totalCost)).toEqual([733200, 719400]);
    expect(sql(`SELECT input_json,version FROM logistics_calculations WHERE id = '${id}'`)[0]).toEqual(before);
    const copy = await post(anna, route(id, '/copy'), { name: 'TEST Older TCO copy', version: 1 });
    expect(copy.status, copy.html).toBe(201);
    expect(json(copy).calculation.input).toEqual(SAMPLES.tco);
    const save = await post(anna, route(id), { name: 'TEST Older TCO unchanged', version: 1, input: JSON.stringify(input) });
    expect(save.status, save.html).toBe(200);
    expect(json(save).calculation.input).toEqual(SAMPLES.tco);
  });
  it('rejects missing capital terms, invalid purchase references and excessive interest removal without saving', async () => {
    const cases = [];
    let input = capitalInput(); delete input.capital.annualRatePercent; cases.push(input);
    input = capitalInput(); delete input.alternatives[0].capital.supplierCreditDays; cases.push(input);
    input = capitalInput(); input.alternatives[0].capital.purchaseCostId = 'missing-cost'; cases.push(input);
    input = capitalInput(); input.alternatives[0].capital.purchaseCostId = 'storage-0'; cases.push(input);
    input = capitalInput(); input.alternatives[0].capital.paymentStart = 'other'; cases.push(input);
    input = capitalInput(); input.alternatives[0].capital = { ...input.alternatives[0].capital,
      interestMode: 'replace', existingInterestCostId: 'storage-0', existingInterestAnnual: 1001 }; cases.push(input);
    const before = (await list(anna)).length;
    for (const input of cases) {
      const response = await post(anna, '/api/calculations', { name: 'TEST invalid capital', toolId: 'tco', input: JSON.stringify(input) });
      expect(response.status, response.html).toBe(400);
      expect(json(response).error).toBeTruthy();
    }
    expect((await list(anna)).length).toBe(before);
  });
  it.each(['tco', 'eoq', 'genbestilling', 'abc'])('saves and reopens canonical %s input', async toolId => {
    const item = await create(anna, toolId, `TEST ${toolId}`);
    const response = await read(anna, item.id), saved = json(response).calculation;
    expect(response.status).toBe(200); expect(saved.input).toEqual(item.input);
    expect(saved.toolId).toBe(toolId); expect(saved.version).toBe(1);
    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); expect(saved.archivedAt).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const entries = await list(anna);
    expect(entries.some(row => row.id === saved.id)).toBe(true);
    expect(entries[0]).not.toHaveProperty('input');
  });
  it.each(['ladmeter', 'luftfragt', 'palletransport', 'containertransport', 'biltransport'])('saves, edits, copies and isolates transport input for %s', async toolId => {
    const input = canonicalizeInput(toolId, TRANSPORT_SAMPLES[toolId]);
    const item = await create(transportOwner, toolId, `TEST ${toolId}`, input);
    const reopened = json(await read(transportOwner, item.id)).calculation;
    expect(reopened.input).toEqual(input);
    expect(transportCalculators[toolId](reopened.input)).toEqual(transportCalculators[toolId](input));
    expect((await read(bo, item.id)).status).toBe(404);
    expect((await post(bo, route(item.id, '/copy'), { name: 'TEST foreign copy', version: 1 })).status).toBe(404);
    const changed = structuredClone(input);
    const fees = changed.fees || changed.offers[0].fees;
    fees.push({ id: 'manual-fee', name: 'TEST Optional', enabled: true, kind: 'fixed', rate: 100,
      currency: 'EUR', fx: 7.45, basis: null, manualBase: null });
    const response = await post(transportOwner, route(item.id), { name: `TEST ${toolId} edited`, version: 1, input: JSON.stringify(changed) });
    expect(response.status, response.html).toBe(200);
    expect(json(response).calculation).toMatchObject({ version: 2, input: changed });
    const copy = await post(transportOwner, route(item.id, '/copy'), { name: `TEST ${toolId} copy`, version: 2 });
    expect(copy.status, copy.html).toBe(201);
    expect(json(copy).calculation.input).toEqual(changed);
    const disabled = structuredClone(changed);
    (disabled.fees || disabled.offers[0].fees).at(-1).enabled = false;
    const revise = await post(transportOwner, route(item.id), { name: `TEST ${toolId} inactive`, version: 2, input: JSON.stringify(disabled) });
    expect(revise.status, revise.html).toBe(200);
    expect(transportCalculators[toolId](json(revise).calculation.input)).toEqual(transportCalculators[toolId](input));
  });
  it('serves all five transport calculators and workbooks to anonymous visitors', async () => {
    const client = new Client(stack.base);
    for (const toolId of ['ladmeter', 'luftfragt', 'palletransport', 'containertransport', 'biltransport']) {
      const page = await client.get(`/logistik/vaerktoejer/${toolId}/`);
      expect(page.status).toBe(200);
      expect(page.html).toContain(`data-tool="${toolId}"`);
      expect(page.headers.get('set-cookie')).toBeNull();
      const file = await client.get(`/logistik/downloads/${toolId}.xlsx`);
      expect(file.status).toBe(200);
      expect(file.html.slice(0, 2)).toBe('PK');
    }
  });
  it('updates with version control, blocks duplicate saves, and rescues the conflicting draft as a copy', async () => {
    const original = await create(anna), nextInput = { ...SAMPLES.eoq, annualDemand: 24000 };
    const save = await post(anna, route(original.id), { name: 'TEST Updated', input: JSON.stringify(nextInput), version: 1 });
    expect(save.status).toBe(200); expect(json(save).calculation.version).toBe(2);
    const stale = await post(anna, route(original.id), { name: 'TEST Stale', input: JSON.stringify(SAMPLES.eoq), version: 1 });
    expect(stale.status).toBe(409); expect(json(stale).code).toBe('conflict');
    expect(json(await read(anna, original.id)).calculation.input.annualDemand).toBe(24000);
    const copied = await post(anna, route(original.id, '/copy'), { name: 'TEST Rescued draft', input: JSON.stringify(SAMPLES.eoq), version: 1 });
    expect(copied.status).toBe(201); expect(json(copied).calculation.id).not.toBe(original.id);
    expect(json(copied).calculation.input.annualDemand).toBe(12000);
    const staleCopy = await post(anna, route(original.id, '/copy'), { name: 'TEST Dashboard', version: 1 });
    expect(staleCopy.status).toBe(409);
    const currentCopy = await post(anna, route(original.id, '/copy'), { name: 'TEST Dashboard', version: 2 });
    expect(currentCopy.status).toBe(201); expect(json(currentCopy).calculation.input.annualDemand).toBe(24000);
  });
  it('denies every ID-based operation to another account', async () => {
    const item = await create(anna);
    expect((await read(bo, item.id)).status).toBe(404);
    for (const suffix of ['', '/copy', '/archive', '/restore']) {
      const response = await post(bo, route(item.id, suffix), { name: 'TEST Theft', input: JSON.stringify(SAMPLES.eoq), version: 1 });
      expect(response.status).toBe(404);
    }
    expect((await list(bo)).some(row => row.id === item.id)).toBe(false);
    expect(json(await read(anna, item.id)).calculation.version).toBe(1);
  });
  it('archives recoverably and prevents edits until restored', async () => {
    const item = await create(anna);
    const archived = await post(anna, route(item.id, '/archive'), { version: 1 });
    expect(archived.status).toBe(200); expect(json(archived).calculation.archivedAt).toBeTruthy();
    expect((await list(anna)).some(row => row.id === item.id)).toBe(false);
    expect((await list(anna, true)).some(row => row.id === item.id)).toBe(true);
    expect((await post(anna, route(item.id), { version: 2, name: 'TEST', input: JSON.stringify(SAMPLES.eoq) })).status).toBe(409);
    expect((await post(anna, route(item.id, '/restore'), { version: 1 })).status).toBe(409);
    const restored = await post(anna, route(item.id, '/restore'), { version: 2 });
    expect(restored.status).toBe(200); expect(json(restored).calculation).toMatchObject({ version: 3, archivedAt: null });
  });
  it('rejects invalid types, arbitrary schemas, model changes and invalid names', async () => {
    const attempts = [
      { input: '{}' }, { input: 'invalid' }, { input: JSON.stringify({ ...SAMPLES.eoq, annualDemand: '12000' }) },
      { input: JSON.stringify({ ...SAMPLES.eoq, formula: 'fetch(secret)' }) },
      { input: JSON.stringify({ ...SAMPLES.eoq, annualDemand: -1 }) }, { toolId: 'inventory' }, { name: ' ' }, { name: 'x'.repeat(121) },
    ];
    const before = (await list(anna)).length;
    for (const fields of attempts) {
      const response = await post(anna, '/api/calculations', { name: 'TEST invalid', toolId: 'eoq', input: JSON.stringify(SAMPLES.eoq), ...fields });
      expect(response.status, response.html).toBe(400); expect(json(response).error).toBeTruthy();
    }
    expect((await list(anna)).length).toBe(before);
    const item = await create(anna);
    const response = await post(anna, route(item.id), { name: 'TEST', toolId: 'abc', input: JSON.stringify(SAMPLES.abc), version: 1 });
    expect(response.status).toBe(400);
  });
  it('saves all 200 Unicode ABC rows, while rejecting the 201st', async () => {
    const input = { thresholdA: 80, thresholdB: 95, items: Array.from({ length: 200 }, (_, i) => ({ name: `${i} ${'æøå資料'.repeat(20)}`, annualQuantity: i + 1, unitCost: 25 })) };
    const item = await create(anna, 'abc', 'TEST 200 rows', input);
    expect(item.input.items).toHaveLength(200);
    const oversized = await post(anna, '/api/calculations', { name: 'TEST too many', toolId: 'abc', input: JSON.stringify({ ...input, items: [...input.items, input.items[0]] }) });
    expect(oversized.status).toBe(400);
  });
  it('keeps quotas atomic for concurrent creation, archived totals and restoration', async () => {
    const client = await signup('logistics-quota@example.com'), customerId = sql("SELECT id FROM customers WHERE email = 'logistics-quota@example.com'")[0].id;
    const raw = JSON.stringify(SAMPLES.eoq), now = Math.floor(Date.now() / 1000);
    sql(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 49)
      INSERT INTO logistics_calculations (id,customer_id,tool_id,name,input_json,created_at,updated_at)
      SELECT printf('00000000-0000-0000-0000-%012d',x),${customerId},'eoq','TEST quota','${raw}',${now},${now} FROM n`);
    const csrf = (await session(client)).csrf;
    const results = await Promise.all([1, 2, 3].map(i => client.post('/logistik/api/calculations', { _csrf: csrf, name: `TEST race ${i}`, toolId: 'eoq', input: raw })));
    expect(results.map(r => r.status).sort()).toEqual([201, 409, 409]);
    expect(sql(`SELECT COUNT(*) AS n FROM logistics_calculations WHERE customer_id = ${customerId} AND archived_at IS NULL`)[0].n).toBe(50);
    sql(`WITH RECURSIVE n(x) AS (SELECT 50 UNION ALL SELECT x+1 FROM n WHERE x < 199)
      INSERT INTO logistics_calculations (id,customer_id,tool_id,name,input_json,created_at,updated_at,archived_at)
      SELECT printf('00000000-0000-0000-0000-%012d',x),${customerId},'eoq','TEST archive','${raw}',${now},${now},${now} FROM n`);
    const restore = await post(client, route('00000000-0000-0000-0000-000000000050', '/restore'), { version: 1 });
    expect(restore.status).toBe(409); expect(json(restore).code).toBe('quota');
    sql(`UPDATE logistics_calculations SET archived_at = ${now} WHERE customer_id = ${customerId}`);
    expect((await post(client, '/api/calculations', { name: 'TEST total', toolId: 'eoq', input: raw })).status).toBe(409);
    expect(sql(`SELECT COUNT(*) AS n FROM logistics_calculations WHERE customer_id = ${customerId}`)[0].n).toBe(200);
  });
  it('rate limits writes without modifying stored data', async () => {
    const item = await create(bo), email = 'logistics-bo@example.com';
    sql(`INSERT INTO rate_limits (key,count,reset_at) VALUES ('logistics:write:${hash(email)}',60,${Math.floor(Date.now() / 1000) + 60}) ON CONFLICT(key) DO UPDATE SET count=60,reset_at=excluded.reset_at`);
    const response = await post(bo, route(item.id), { version: 1, name: 'TEST blocked', input: JSON.stringify(SAMPLES.eoq) });
    expect(response.status).toBe(429); expect(json(response).code).toBe('rate_limited');
    expect(json(await read(bo, item.id)).calculation.version).toBe(1);
  });
});

describe('Transport and session protections', () => {
  it('blocks missing CSRF, cross-origin requests, JSON posts and oversized bodies', async () => {
    const fields = { name: 'TEST', toolId: 'eoq', input: JSON.stringify(SAMPLES.eoq) };
    expect((await anna.post('/logistik/api/calculations', fields)).status).toBe(403);
    expect((await post(anna, '/api/calculations', fields, { Origin: 'https://example.com' })).status).toBe(403);
    expect((await post(anna, '/api/calculations', fields, { 'Content-Type': 'application/json' })).status).toBe(415);
    expect((await post(anna, '/api/calculations', { ...fields, input: 'x'.repeat(530000) })).status).toBe(413);
  });
  it('logout removes access to the existing same-origin Veyro session', async () => {
    const client = await signup('logistics-logout@example.com');
    expect((await session(client)).authenticated).toBe(true);
    const response = await post(client, '/logout');
    expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/logistik/');
    expect((await session(client)).authenticated).toBe(false);
    expect((await client.get('/logistik/api/calculations')).status).toBe(401);
  });
});
