import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { hashPassword } from '../server/password.ts';

const root = new URL('../', import.meta.url);
async function loadModule(path) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(path, root))], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022' });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const worker = (await loadModule('server/index.ts')).default;
const { createDefaultProductionDraft, validateProductionDraft } = await loadModule('app/factory/production-validation.ts');
const migration = (await Promise.all(['0001_factory_auth.sql', '0002_factory_layout.sql', '0003_world_map.sql', '0004_production_plan.sql'].map(name => readFile(new URL('migrations/' + name, root), 'utf8')))).join('\n');
const password = 'production-test-only', adminId = 'production-marcus', friendId = 'production-friend';
const passwordHash = await hashPassword(password);
let sqlite, env;
class Statement {
  constructor(sql, params = []) { this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.sql, params); }
  execute() { const rows = sqlite.prepare(this.sql).all(...this.params); return { success: true, results: rows, meta: { changes: sqlite.prepare('SELECT changes() n').get().n } }; }
  async run() { return this.execute(); }
  async all() { return this.execute(); }
  async first(column) { const row = this.execute().results[0]; return row ? (column ? row[column] : row) : null; }
}
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(migration);
  const insert = sqlite.prepare('INSERT INTO factory_users(id,username,display_name,password_hash,role,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)');
  insert.run(adminId, 'marcus', 'Marcus', passwordHash, 'admin', 'test', 'test');
  insert.run(friendId, 'friend', 'Friend', passwordHash, 'player', 'test', 'test');
  env = { DB: { prepare: sql => new Statement(sql), batch: async statements => {
    sqlite.exec('BEGIN');
    try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } }, ASSETS: { fetch: async () => new Response('Test') } };
});
afterEach(() => sqlite.close());
function req(path, method = 'GET', body, session, extra = {}) {
  return new Request('https://factory.test' + path, { method, headers: {
    ...(!['GET', 'HEAD'].includes(method) ? { Origin: 'https://factory.test', 'Content-Type': 'application/json' } : {}),
    ...(session ? { Cookie: '__Host-factory_session=' + session } : {}), ...extra,
  }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
const call = (...args) => worker.fetch(req(...args), env);
async function login(username = 'marcus') {
  const response = await call('/api/auth/login', 'POST', { username, password });
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers.get('set-cookie').split(';')[0].split('=')[1];
}

test('production plans require active sessions, same-origin writes and supported methods', async () => {
  assert.equal((await call('/api/production')).status, 401);
  const admin = await login(), friend = await login('friend'), data = createDefaultProductionDraft();
  assert.equal((await call('/api/production', 'PUT', { data, revision: 0 }, friend, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await call('/api/production', 'PUT', { data, revision: 0 }, friend, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call('/api/production', 'POST', {}, admin)).status, 405);
  sqlite.prepare('UPDATE factory_users SET active=0 WHERE id=?').run(friendId);
  assert.equal((await call('/api/production', 'GET', undefined, friend)).status, 401);
  assert.equal((await call('/api/production', 'PUT', { data, revision: 0 }, friend)).status, 401);
});

test('shared production drafts round-trip independently of existing layouts and protect newer revisions', async () => {
  const admin = await login(), friend = await login('friend');
  const first = await call('/api/production', 'GET', undefined, admin), initial = await first.json();
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.equal(first.headers.get('vary'), 'Cookie');
  assert.deepEqual(initial, { data: createDefaultProductionDraft(), revision: 0, updatedAt: null, updatedBy: null });
  const layoutBefore = await (await call('/api/factory', 'GET', undefined, admin)).json();
  const worldBefore = await (await call('/api/world/plan', 'GET', undefined, admin)).json();
  const data = { ...createDefaultProductionDraft(), name: 'Shared starter production', templateId: 'iron-plates', scale: 2 };
  const savedResponse = await call('/api/production', 'PUT', { data, revision: initial.revision }, friend);
  assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
  const saved = await savedResponse.json();
  assert.deepEqual(saved.data, validateProductionDraft(data));
  assert.equal(saved.revision, 1); assert.equal(saved.updatedBy, friendId);
  assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
  assert.deepEqual(await (await call('/api/production', 'GET', undefined, admin)).json(), saved);
  const stale = await call('/api/production', 'PUT', { data: { ...data, name: 'Old draft' }, revision: 0 }, admin);
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'revision_conflict');
  assert.deepEqual(await (await call('/api/production', 'GET', undefined, friend)).json(), saved);
  assert.deepEqual(await (await call('/api/factory', 'GET', undefined, admin)).json(), layoutBefore);
  assert.deepEqual(await (await call('/api/world/plan', 'GET', undefined, admin)).json(), worldBefore);
});

test('malformed updates and excessive request bodies never change the production plan', async () => {
  const session = await login(), data = createDefaultProductionDraft();
  for (const body of [null, [], {}, { data }, { data, revision: -1 }, { data, revision: 0.5 }, { data, revision: Number.MAX_SAFE_INTEGER }, { data, revision: 0, execute: true }]) {
    const response = await call('/api/production', 'PUT', body, session);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await call('/api/production', 'PUT', '{not-json', session)).status, 400);
  assert.equal((await call('/api/production', 'PUT', { data, revision: 0 }, session, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await call('/api/production', 'PUT', '{}', session, { 'Content-Length': '1000001' })).status, 400);
  assert.equal((await call('/api/production', 'PUT', ' '.repeat(1_000_001), session)).status, 400);
  assert.equal((await (await call('/api/production', 'GET', undefined, session)).json()).revision, 0);
});

test('draft validation clones data and rejects unknown fields, invalid metadata and unsafe dictionaries', () => {
  const draft = createDefaultProductionDraft(), validated = validateProductionDraft(draft);
  assert.deepEqual(validated, draft); assert.notEqual(validated, draft); assert.notEqual(validated.request, draft.request);
  for (const mutate of [
    value => { value.name = ''; }, value => { value.name = 'x'.repeat(101); }, value => { value.name = 'Invalid\nname'; },
    value => { value.templateId = '../escape'; }, value => { value.scale = 0; }, value => { value.scale = Infinity; },
    value => { value.secret = 'unsupported'; }, value => { value.request.execute = 'unsupported'; },
    value => { value.request = []; }, value => { value.request = Object.create({ inherited: true }); },
  ]) { const value = createDefaultProductionDraft(); mutate(value); assert.throws(() => validateProductionDraft(value)); }
});

test('calculator choices, available supplies and machine settings persist without running the solver', async () => {
  const session = await login(), data = createDefaultProductionDraft();
  data.templateId = 'test-cast-screws'; data.scale = 1.5; data.extraction = { minerTier: 3, purity: 'pure', clock: 250 };
  Object.assign(data.request, {
    outputs: [{ itemId: 'Desc_IronScrew_C', rate: 75 }, { itemId: 'Desc_IronPlate_C', rate: 20 }],
    inputs: [{ itemId: 'Desc_IronIngot_C', rate: 60 }, { itemId: 'Desc_Water_C', rate: 0 }],
    allowedAlternates: ['Recipe_Alternate_Screw_C'], allowedConverters: ['Recipe_Coal_Iron_C'],
    excludedRecipes: ['Recipe_Alternate_Screw_2_C'], recipeOverrides: { Desc_IronScrew_C: 'Recipe_Alternate_Screw_C' },
    recipeClocks: { Recipe_Alternate_Screw_C: 150 }, sloops: { Recipe_Alternate_Screw_C: 1 }, somersloopBudget: 12, powerShardBudget: 30,
    clock: 200, beltTier: 6, pipeTier: 2, settings: { recipeMultiplier: 0.75, powerMultiplier: 2 },
    mode: 'maximize', optimization: 'power', resourcePolicy: 'closed', capInputs: false,
  });
  const response = await call('/api/production', 'PUT', { data, revision: 0 }, session);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).data, data);
  assert.deepEqual((await (await call('/api/production', 'GET', undefined, session)).json()).data, data);
});

test('strict calculator validation bounds rates, options, catalog IDs and machine-specific settings', async () => {
  const session = await login();
  const mutations = [
    r => { r.outputs = []; }, r => { r.outputs = Array.from({ length: 13 }, () => ({ itemId: 'Desc_IronPlate_C', rate: 1 })); },
    r => { r.outputs[0].itemId = 'invented'; }, r => { r.outputs[0].rate = 0; }, r => { r.outputs[0].rate = 10_000_001; },
    r => { r.outputs[0].rate = '60'; }, r => { r.outputs[0].rate = Infinity; }, r => { r.outputs[0].extra = true; },
    r => { r.outputs.push({ ...r.outputs[0] }); },
    r => { r.inputs = Array.from({ length: 33 }, () => ({ itemId: 'Desc_IronIngot_C', rate: 1 })); },
    r => { r.inputs = [{ itemId: 'Desc_IronIngot_C', rate: -1 }]; },
    r => { r.allowedAlternates = ['invented']; }, r => { r.allowedConverters = ['constructor']; },
    r => { r.excludedRecipes = ['Recipe_Alternate_Screw_C', 'Recipe_Alternate_Screw_C']; },
    r => { r.recipeOverrides = { Desc_IronPlate_C: 'Recipe_Alternate_Screw_C' }; },
    r => { r.recipeOverrides = JSON.parse('{"__proto__":"Recipe_Alternate_Screw_C"}'); },
    r => { r.recipeClocks = { Recipe_Alternate_Screw_C: 251 }; }, r => { r.recipeClocks = { invented: 100 }; },
    r => { r.recipeClocks = JSON.parse('{"constructor":100}'); },
    r => { r.sloops = { Recipe_Alternate_Screw_C: 2 }; }, r => { r.sloops = { Recipe_Alternate_Screw_C: 0.5 }; },
    r => { r.sloops = { invented: 1 }; }, r => { r.clock = 0; }, r => { r.clock = NaN; },
    ...[-1, 10001, .5, Infinity, NaN, null, '2', true].map(value => r => { r.somersloopBudget = value; }),
    ...[-1, 10001, .5, Infinity, NaN, null, '2', true].map(value => r => { r.powerShardBudget = value; }),
    r => { r.beltTier = 7; }, r => { r.beltTier = 1.5; }, r => { r.pipeTier = 3; },
    r => { r.settings.recipeMultiplier = 0.24; }, r => { r.settings.powerMultiplier = 5.01; },
    r => { r.settings.allowRemoteCode = true; }, r => { r.mode = 'simulate'; },
    r => { r.optimization = 'invented'; }, r => { r.resourcePolicy = 'invented'; }, r => { r.capInputs = 'true'; },
  ];
  for (const mutate of mutations) {
    const data = createDefaultProductionDraft(); mutate(data.request);
    assert.throws(() => validateProductionDraft(data), undefined, String(mutate));
    const response = await call('/api/production', 'PUT', { data, revision: 0 }, session);
    assert.equal(response.status, 400, String(mutate));
  }
  assert.equal((await (await call('/api/production', 'GET', undefined, session)).json()).revision, 0);
});

test('extraction settings reject unsupported tiers, purities, clocks and hidden fields', () => {
  for (const extraction of [null, [], { minerTier: 0 }, { minerTier: 4 }, { minerTier: 1.5 }, { purity: 'rich' }, { clock: 0 }, { clock: 251 }, { clock: Infinity }, { clock: '100' }, { ignoreLimits: true }]) {
    assert.throws(() => validateProductionDraft({ ...createDefaultProductionDraft(), extraction }));
  }
  assert.deepEqual(validateProductionDraft({ ...createDefaultProductionDraft(), extraction: {} }).extraction, { minerTier: 1, purity: 'normal', clock: 100 });
});

test('optional Somersloop budgets preserve the difference between manual mode and a zero automatic budget', async () => {
  const session = await login();
  assert.equal(Object.hasOwn(createDefaultProductionDraft().request, 'somersloopBudget'), false);
  let revision = 0;
  for (const budget of [0, 10000]) {
    const data = createDefaultProductionDraft(); data.request.somersloopBudget = budget;
    const response = await call('/api/production', 'PUT', { data, revision }, session);
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json(); revision = saved.revision;
    assert.equal(saved.data.request.somersloopBudget, budget);
    assert.equal((await (await call('/api/production', 'GET', undefined, session)).json()).data.request.somersloopBudget, budget);
  }
});

test('input cap defaults follow target versus maximize mode while explicit caps are preserved', () => {
  const data = createDefaultProductionDraft(); assert.equal(data.request.capInputs, false);
  delete data.request.capInputs; data.request.mode = 'maximize';
  assert.equal(validateProductionDraft(data).request.capInputs, true);
  data.request.capInputs = false; assert.equal(validateProductionDraft(data).request.capInputs, false);
  data.request.mode = 'target'; data.request.capInputs = true;
  assert.equal(validateProductionDraft(data).request.capInputs, true);
});

test('two saves based on the same revision have exactly one winner', async () => {
  const admin = await login(), friend = await login('friend');
  const a = { ...createDefaultProductionDraft(), name: 'First draft' }, b = { ...createDefaultProductionDraft(), name: 'Second draft' };
  const results = await Promise.all([
    call('/api/production', 'PUT', { data: a, revision: 0 }, admin),
    call('/api/production', 'PUT', { data: b, revision: 0 }, friend),
  ]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const winner = await results.find(response => response.status === 200).json();
  assert.deepEqual(await (await call('/api/production', 'GET', undefined, admin)).json(), winner);
  assert.equal(winner.revision, 1);
});
