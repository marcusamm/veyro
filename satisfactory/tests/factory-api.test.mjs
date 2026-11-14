import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { sha256 } from '../server/password.ts';

// Exercise the deployed Worker handler and its real SQL with only D1 replaced.
const root = new URL('../', import.meta.url);
const bundle = await build({ entryPoints: [fileURLToPath(new URL('server/index.ts', root))], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022' });
const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)).default;
const migration = (await Promise.all(['0001_factory_auth.sql', '0002_factory_layout.sql', '0003_world_map.sql'].map(name => readFile(new URL(`migrations/${name}`, root), 'utf8')))).join('\n');
const userId = '00000000-0000-4000-8000-000000000002';
const token = 'a'.repeat(64), tokenHash = await sha256(token);
let sqlite, env;
class Statement {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...params) { return new Statement(this.sql, params); }
    execute() { return { success: true, results: sqlite.prepare(this.sql).all(...this.params), meta: { changes: sqlite.prepare('SELECT changes() AS count').get().count } }; }
    async first(column) { const row = this.execute().results[0]; return row ? (column ? row[column] : row) : null; }
    async run() { return this.execute(); }
    async all() { return this.execute(); }
}
beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(migration);
    sqlite.prepare('INSERT INTO factory_users(id,username,display_name,password_hash,role,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(userId, 'friend', 'Test friend', 'not-used-by-session-fixture', 'player', 'test', 'test');
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare('INSERT INTO factory_sessions(token_hash,user_id,expires_at,created_at,auth_version) VALUES(?,?,?,?,0)').run(tokenHash, userId, now + 3600, now);
    env = { DB: { prepare: sql => new Statement(sql) }, ASSETS: { fetch: async () => new Response('test') } };
});
afterEach(() => sqlite.close());
const settings = { recipeMultiplier: 1, powerMultiplier: 1 };
const iron = 'Desc_OreIron_C';
const extractor = (extra = {}) => ({ id: 'miner', kind: 'extractor', extractorId: 'Desc_MinerMk1_C', itemId: iron, x: 0, y: 0, rotation: 0, ...extra });
const fixture = () => ({ version: 1, name: 'Synthetic extractor test', nodes: [extractor()], edges: [], settings: { ...settings } });
function request(method = 'GET', body, headers = {}) {
    return new Request('https://factory.test/api/factory', {
        method,
        headers: { Cookie: `__Host-factory_session=${token}`, Origin: 'https://factory.test', 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
}
const call = (...args) => worker.fetch(request(...args), env);
const savedLayout = async () => (await call()).json();

test('extractor type, purity, overclock and connections survive save/reload for every miner tier', async () => {
    const data = fixture();
    data.nodes.push({ id: 'out', kind: 'sink', itemId: iron, rate: 1200, x: 400, y: 0, rotation: 0 });
    data.edges.push({ id: 'belt', from: 'miner', to: 'out', fromPort: 'out:0', toPort: 'in:0', itemId: iron, transport: 'belt', tier: 6 });
    for (const [index, extractorId] of ['Desc_MinerMk1_C', 'Desc_MinerMk2_C', 'Desc_MinerMk3_C'].entries()) {
        Object.assign(data.nodes[0], { extractorId, clock: 250, purity: 'pure' });
        const response = await call('PUT', { data, revision: index });
        assert.equal(response.status, 200, await response.clone().text());
        const result = await savedLayout();
        assert.deepEqual(result.data, data);
        assert.equal(result.revision, index + 1);
        assert.equal(result.updatedBy, userId);
        assert.ok(result.updatedAt);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
});

test('oil and water extractor defaults normalize without changing old manual sources', async () => {
    const data = fixture();
    data.nodes = [
        extractor({ id: 'oil', extractorId: 'Desc_OilPump_C', itemId: 'Desc_LiquidOil_C', purity: 'impure' }),
        extractor({ id: 'water', extractorId: 'Desc_WaterPump_C', itemId: 'Desc_Water_C' }),
        { id: 'manual', kind: 'source', itemId: iron, rate: 47.5, x: 800, y: 0, rotation: 90 },
    ];
    const response = await call('PUT', { data, revision: 0 });
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await savedLayout()).data;
    assert.equal(result.nodes[0].clock, 100);
    assert.equal(result.nodes[0].purity, 'impure');
    assert.equal(result.nodes[1].clock, 100);
    assert.equal(result.nodes[1].purity, 'normal');
    assert.deepEqual(result.nodes[2], data.nodes[2]);
});

test('invalid extractor imports cannot overwrite an already saved factory', async () => {
    assert.equal((await call('PUT', { data: fixture(), revision: 0 })).status, 200);
    const before = await savedLayout();
    const invalidChanges = [
        n => { n.extractorId = 'missing'; },
        n => { n.extractorId = 'Desc_WaterPump_C'; },
        n => { n.itemId = 'Desc_IronPlate_C'; },
        n => { n.purity = 'rich'; },
        n => { n.purity = null; },
        n => { n.clock = null; },
        n => { n.clock = '100'; },
        n => { n.clock = 0; },
        n => { n.clock = 250.01; },
        n => { n.rate = 1200; },
        n => { n.sloops = 1; },
        n => { n.recipeId = 'Recipe_IngotIron_C'; },
        n => { n.filters = {}; },
        n => { n.extractorId = 'Desc_WaterPump_C'; n.itemId = 'Desc_Water_C'; n.purity = 'pure'; },
    ];
    for (const change of invalidChanges) {
        const data = fixture();
        change(data.nodes[0]);
        const response = await call('PUT', { data, revision: 1 });
        assert.equal(response.status, 400, JSON.stringify(data.nodes[0]));
        assert.ok((await response.json()).error);
        assert.deepEqual(await savedLayout(), before);
    }
});

test('fields from another node type and explicit null numeric inputs are rejected', async () => {
    const candidates = [
        { id: 'n', kind: 'source', itemId: iron, rate: null, x: 0, y: 0, rotation: 0 },
        { id: 'n', kind: 'source', itemId: iron, extractorId: 'Desc_MinerMk1_C', x: 0, y: 0, rotation: 0 },
        { id: 'n', kind: 'source', itemId: iron, purity: 'pure', x: 0, y: 0, rotation: 0 },
        { id: 'n', kind: 'machine', recipeId: 'Recipe_IngotIron_C', clock: null, x: 0, y: 0, rotation: 0 },
        { id: 'n', kind: 'machine', recipeId: 'Recipe_IngotIron_C', sloops: null, x: 0, y: 0, rotation: 0 },
        { id: 'n', kind: 'machine', recipeId: 'Recipe_IngotIron_C', purity: 'normal', x: 0, y: 0, rotation: 0 },
    ];
    for (const node of candidates) {
        const data = fixture(); data.nodes = [node];
        assert.equal((await call('PUT', { data, revision: 0 })).status, 400, JSON.stringify(node));
    }
    assert.equal((await savedLayout()).revision, 0);
});

test('concurrent factory saves accept exactly one draft and never merge incompatible revisions', async () => {
    const a = fixture(), b = fixture();
    a.name = 'Player A'; b.name = 'Player B';
    b.nodes[0].extractorId = 'Desc_MinerMk3_C';
    const replies = await Promise.all([call('PUT', { data: a, revision: 0 }), call('PUT', { data: b, revision: 0 })]);
    assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
    const winner = await replies.find(r => r.status === 200).json();
    const loser = await replies.find(r => r.status === 409).json();
    assert.equal(loser.code, 'revision_conflict');
    assert.deepEqual(await savedLayout(), winner);
    assert.equal(winner.revision, 1);
});

test('invalid connections and oversized boards fail without advancing the revision', async () => {
    const data = fixture();
    data.nodes.push({ id: 'out', kind: 'sink', itemId: iron, rate: 60, x: 400, y: 0, rotation: 0 });
    const connection = { id: 'edge', from: 'miner', to: 'out', fromPort: 'out:0', toPort: 'in:0', itemId: iron, transport: 'belt', tier: 1 };
    for (const invalid of [
        { ...connection, fromPort: 'out:missing' },
        { ...connection, itemId: 'Desc_OreCopper_C' },
        { ...connection, transport: 'pipe' },
        { ...connection, tier: 7 },
        { ...connection, to: 'deleted-node' },
    ]) {
        data.edges = [invalid];
        assert.equal((await call('PUT', { data, revision: 0 })).status, 400);
    }
    data.edges = [connection, { ...connection, id: 'duplicate-port' }];
    assert.equal((await call('PUT', { data, revision: 0 })).status, 400);
    data.edges = [];
    data.nodes = Array.from({ length: 251 }, (_, i) => extractor({ id: `n${i}` }));
    assert.equal((await call('PUT', { data, revision: 0 })).status, 400);
    assert.equal((await savedLayout()).revision, 0);
});
