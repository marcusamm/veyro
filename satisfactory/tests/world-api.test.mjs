import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { hashPassword, sha256 } from '../server/password.ts';

const root = new URL('../', import.meta.url);
const bundle = await build({ entryPoints: [fileURLToPath(new URL('server/index.ts', root))], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022' });
const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)).default;
const migration = (await Promise.all(['0001_factory_auth.sql', '0002_factory_layout.sql', '0003_world_map.sql', '0004_production_plan.sql'].map(name => readFile(new URL('migrations/' + name, root), 'utf8')))).join('\n');
const password = 'world-tests-only', adminId = 'test-marcus', friendId = 'test-friend';
const hash = await hashPassword(password);
let sqlite, env, beforeBatch;
class Statement {
  constructor(sql, params = []) { this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.sql, params); }
  execute() { const rows = sqlite.prepare(this.sql).all(...this.params); return { success: true, results: rows, meta: { changes: sqlite.prepare('SELECT changes() n').get().n } }; }
  async run() { return this.execute(); }
  async all() { return this.execute(); }
  async first(column) { const row = this.execute().results[0]; return row ? (column ? row[column] : row) : null; }
}
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(migration); beforeBatch = null;
  const insert = sqlite.prepare('INSERT INTO factory_users(id,username,display_name,password_hash,role,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)');
  insert.run(adminId, 'marcus', 'Marcus', hash, 'admin', 'test', 'test');
  insert.run(friendId, 'friend', 'Friend', hash, 'player', 'test', 'test');
  env = { DB: { prepare: sql => new Statement(sql), batch: async statements => {
    if (beforeBatch) { const callback = beforeBatch; beforeBatch = null; callback(); }
    sqlite.exec('BEGIN'); try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
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
async function login(username = 'marcus') { const response = await call('/api/auth/login', 'POST', { username, password }); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0].split('=')[1]; }
async function configure(session) { const response = await call('/api/world/connection', 'POST', {}, session); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).token; }
const entity = (id = 'machine-1') => ({ id, className: 'Build_SmelterMk1_C', name: 'Synthetic test smelter', kind: 'machine', x: -120000, y: 45000, z: 1600, yaw: 90, recipeId: 'Recipe_IngotIron_C', clockPercent: 150, powerMW: 6.836935, producing: true });
const snapshot = (sequence = 1) => ({ version: 1, coordinateSystem: 'satisfactory-ue-cm', worldId: 'synthetic-test-world', worldName: 'Synthetic integration test world', sequence, observedAt: new Date().toISOString(), source: { kind: 'frm', version: 'test-fixture' }, entities: [entity()], links: [{ id: 'belt-1', kind: 'belt', tier: 3, points: [{ x: -120000, y: 45000, z: 1600 }, { x: -119000, y: 45000, z: 1600 }] }] });
function ingest(token, data = snapshot()) { return worker.fetch(new Request('https://factory.test/api/world/ingest', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), env); }
const plan = () => ({ version: 1, worldId: 'synthetic-test-world', markers: [{ id: 'proposed-1', kind: 'machine', label: 'Planned smelter', x: -120000, y: 48000, z: 1600, rotation: 0, recipeId: 'Recipe_IngotIron_C', clockPercent: 200 }] });

test('world reads require a player session; only Marcus can configure the ingest credential', async () => {
  for (const path of ['/api/world', '/api/world/plan', '/api/world/connection']) assert.equal((await call(path)).status, 401, path);
  const admin = await login(), friend = await login('friend');
  assert.equal((await call('/api/world', 'GET', undefined, friend)).status, 200);
  assert.equal((await call('/api/world/plan', 'GET', undefined, friend)).status, 200);
  for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await call('/api/world/connection', method, method === 'POST' ? {} : undefined, friend)).status, 403);
  assert.equal((await call('/api/world/connection', 'POST', {}, admin, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('/api/world/plan', 'PUT', { data: plan(), revision: 0 }, friend, { Origin: 'https://evil.test' })).status, 403);
  const token = await configure(admin);
  assert.equal((await call('/api/world', 'GET', undefined, undefined, { Authorization: 'Bearer ' + token })).status, 401);
  sqlite.prepare('UPDATE factory_users SET active=0 WHERE id=?').run(friendId);
  assert.equal((await call('/api/world', 'GET', undefined, friend)).status, 401);
});

test('status starts disconnected, waits for real data, and only then reports fresh telemetry', async () => {
  const admin = await login();
  assert.deepEqual(await (await call('/api/world', 'GET', undefined, admin)).json(), { status: 'not_connected', configured: false, snapshot: null, lastReceivedAt: null });
  const token = await configure(admin); assert.match(token, /^[a-f0-9]{64}$/);
  const row = sqlite.prepare('SELECT * FROM factory_world_connection').get(); assert.equal(row.token_hash, await sha256(token)); assert.notEqual(row.token_hash, token);
  const waiting = await (await call('/api/world', 'GET', undefined, admin)).json(); assert.equal(waiting.status, 'waiting'); assert.equal(waiting.snapshot, null);
  const original = snapshot(); const sent = await ingest(token, original); assert.equal(sent.status, 200, await sent.clone().text());
  const response = await call('/api/world', 'GET', undefined, admin), state = await response.json();
  assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(state.status, 'live'); assert.deepEqual(state.snapshot, original);
  const metadata = await (await call('/api/world/connection', 'GET', undefined, admin)).json(); assert.equal(metadata.worldId, original.worldId); assert.equal(metadata.token, undefined); assert.equal(metadata.token_hash, undefined);
  sqlite.prepare('UPDATE factory_world_connection SET received_at=?,observed_at=?').run(new Date(Date.now() - 120000).toISOString(), new Date(Date.now() - 120000).toISOString());
  assert.equal((await (await call('/api/world', 'GET', undefined, admin)).json()).status, 'stale');
});

test('new live snapshots never overwrite player plans, and stale plan saves are rejected', async () => {
  const admin = await login(), friend = await login('friend'), token = await configure(admin);
  const factoryBefore = await (await call('/api/factory', 'GET', undefined, admin)).json();
  const documentsBefore = await (await call('/api/plan', 'GET', undefined, admin)).json();
  assert.equal((await ingest(token)).status, 200);
  const saved = await call('/api/world/plan', 'PUT', { data: plan(), revision: 0 }, friend); assert.equal(saved.status, 200, await saved.clone().text());
  const expected = await saved.json(); assert.equal(expected.updatedBy, friendId); assert.equal(expected.revision, 1);
  assert.equal((await call('/api/world/plan', 'PUT', { data: plan(), revision: 0 }, admin)).status, 409);
  const changed = snapshot(2); changed.entities[0].clockPercent = 250;
  assert.equal((await ingest(token, changed)).status, 200);
  assert.deepEqual(await (await call('/api/world/plan', 'GET', undefined, admin)).json(), expected);
  assert.deepEqual(await (await call('/api/factory', 'GET', undefined, admin)).json(), factoryBefore);
  assert.deepEqual(await (await call('/api/plan', 'GET', undefined, admin)).json(), documentsBefore);
  assert.equal((await call('/api/world/plan', 'PUT', { data: { ...plan(), worldId: 'another-world' }, revision: 1 }, admin)).status, 409);
});

test('pre-server plans survive the first snapshot and bind to the real world only on a player save', async () => {
  const admin = await login(), friend = await login('friend');
  const unbound = { ...plan(), worldId: null };
  const saved = await call('/api/world/plan', 'PUT', { data: unbound, revision: 0 }, friend);
  assert.equal(saved.status, 200, await saved.clone().text());
  const before = await saved.json(); assert.equal(before.data.worldId, null);
  const token = await configure(admin); assert.equal((await ingest(token)).status, 200);
  const after = await (await call('/api/world/plan', 'GET', undefined, friend)).json();
  assert.deepEqual(after, before, 'First telemetry must not rebind or change an existing draft.');
  assert.equal((await call('/api/world/plan', 'PUT', { data: unbound, revision: 1 }, friend)).status, 409);
  const bound = { ...unbound, worldId: 'synthetic-test-world' };
  const result = await call('/api/world/plan', 'PUT', { data: bound, revision: 1 }, friend);
  assert.equal(result.status, 200, await result.clone().text());
  const updated = await result.json(); assert.equal(updated.revision, 2); assert.deepEqual(updated.data.markers, before.data.markers);
  assert.equal((await call('/api/world/plan', 'PUT', { data: bound, revision: 1 }, admin)).status, 409);
  assert.equal((await call('/api/world/plan', 'PUT', { data: { ...bound, worldId: 'another-world' }, revision: 2 }, admin)).status, 409);
});

test('rotation and revocation invalidate old tokens without destroying the last world or its plans', async () => {
  const admin = await login(), oldToken = await configure(admin); assert.equal((await ingest(oldToken)).status, 200);
  const newToken = await configure(admin); assert.notEqual(newToken, oldToken);
  assert.equal((await ingest(oldToken, snapshot(2))).status, 401);
  assert.equal((await ingest(newToken, snapshot(2))).status, 200);
  assert.equal((await call('/api/world/connection', 'DELETE', undefined, admin)).status, 200);
  assert.equal((await ingest(newToken, snapshot(3))).status, 401);
  const state = await (await call('/api/world', 'GET', undefined, admin)).json(); assert.equal(state.status, 'not_connected'); assert.equal(state.snapshot.sequence, 2);
});

test('invalid, stale, cross-world and oversized snapshots cannot replace the saved world', async () => {
  const admin = await login(), token = await configure(admin); assert.equal((await ingest(token, snapshot(10))).status, 200);
  assert.equal((await ingest(token, snapshot(9))).status, 409);
  assert.equal((await ingest(token, { ...snapshot(11), worldId: 'another-world' })).status, 409);
  for (const mutate of [
    data => { data.observedAt = new Date(Date.now() + 60000).toISOString(); },
    data => { data.observedAt = new Date(Date.now() - 660000).toISOString(); },
    data => { data.entities[0].x = 2000001; }, data => { data.entities[0].clockPercent = 251; },
    data => { data.entities.push(entity()); }, data => { data.entities[0].secret = 'should-not-be-retained'; },
    data => { data.entities[0].producing = 'yes'; }, data => { data.links[0].tier = 7; },
    data => { data.coordinateSystem = 'pixels'; }, data => { data.source.url = 'http://private-server'; },
    data => { data.sequence = Infinity; }, data => { data.links[0].points = []; },
  ]) { const data = snapshot(11); mutate(data); assert.equal((await ingest(token, data)).status, 400); }
  const tooLarge = new Request('https://factory.test/api/world/ingest', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': '8000001' }, body: '{}' });
  assert.equal((await worker.fetch(tooLarge, env)).status, 400);
  assert.equal((await ingest('0'.repeat(64), snapshot(11))).status, 401);
  const unchanged = await (await call('/api/world', 'GET', undefined, admin)).json(); assert.equal(unchanged.snapshot.sequence, 10);
});

test('invalid proposed markers and missing revisions are rejected without touching the shared plan', async () => {
  const admin = await login(), token = await configure(admin); await ingest(token);
  for (const mutate of [
    data => { data.markers[0].clockPercent = 0; }, data => { data.markers[0].recipeId = 'invented'; },
    data => { data.markers[0].rotation = 360; }, data => { data.markers[0].label = ''; },
    data => { data.markers.push({ ...data.markers[0] }); }, data => { data.markers[0].kind = 'destroy-game-building'; },
    data => { data.markers[0].width = 800; }, data => { data.markers[0].x = '1'; },
  ]) { const data = plan(); mutate(data); assert.equal((await call('/api/world/plan', 'PUT', { data, revision: 0 }, admin)).status, 400); }
  assert.equal((await call('/api/world/plan', 'PUT', { data: plan() }, admin)).status, 400);
  assert.equal((await (await call('/api/world/plan', 'GET', undefined, admin)).json()).revision, 0);
});

test('large snapshots round-trip through bounded chunks and atomically replace obsolete chunks', async () => {
  const admin = await login(), token = await configure(admin), data = snapshot();
  data.entities = Array.from({ length: 5000 }, (_, index) => ({ ...entity('machine-' + index), name: 'Synthetic 🏭 machine ' + index, x: index * 10 }));
  const response = await ingest(token, data); assert.equal(response.status, 200, await response.clone().text());
  const chunks = sqlite.prepare('SELECT data FROM factory_world_chunks').all(); assert.ok(chunks.length > 1); assert.ok(chunks.every(chunk => Buffer.byteLength(chunk.data) <= 750000));
  assert.deepEqual((await (await call('/api/world', 'GET', undefined, admin)).json()).snapshot, data);
  const smaller = snapshot(2); assert.equal((await ingest(token, smaller)).status, 200);
  assert.equal(sqlite.prepare('SELECT count(DISTINCT snapshot_id) n FROM factory_world_chunks').get().n, 1);
  assert.deepEqual((await (await call('/api/world', 'GET', undefined, admin)).json()).snapshot, smaller);
});

test('token revocation racing upload publication leaves no orphan chunks or unauthorized snapshot', async () => {
  const admin = await login(), token = await configure(admin); await ingest(token);
  beforeBatch = () => sqlite.prepare('UPDATE factory_world_connection SET token_hash=NULL WHERE id=1').run();
  const response = await ingest(token, snapshot(2)); assert.equal(response.status, 409);
  const state = await (await call('/api/world', 'GET', undefined, admin)).json(); assert.equal(state.snapshot.sequence, 1); assert.equal(state.status, 'not_connected');
  assert.equal(sqlite.prepare('SELECT count(DISTINCT snapshot_id) n FROM factory_world_chunks').get().n, 1);
});

test('a newer concurrent upload wins atomically over an older upload', async () => {
  const admin = await login(), token = await configure(admin); await ingest(token);
  beforeBatch = () => sqlite.prepare('UPDATE factory_world_connection SET sequence=3 WHERE id=1').run();
  assert.equal((await ingest(token, snapshot(2))).status, 409);
  assert.equal(sqlite.prepare('SELECT sequence FROM factory_world_connection').get().sequence, 3);
  assert.equal(sqlite.prepare('SELECT count(DISTINCT snapshot_id) n FROM factory_world_chunks').get().n, 1);
});
