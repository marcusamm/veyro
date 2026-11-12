import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, DEFAULT_ENDPOINTS, createSnapshot, frmRotationToYaw, normalizeBatch } from '../scripts/lib/frm-world.mjs';
import { loadConfig, pollAndPublish, readLimitedJson, retryDelay, runBridge } from '../scripts/world-map-bridge.mjs';

// Synthetic fixtures shaped like the pinned FRM 1.5.5 implementation; no player/save data.
const token = 'a'.repeat(64);
const env = { WORLD_INGEST_TOKEN: token, WORLD_ID: 'test-world', WORLD_NAME: 'Test world' };
const base = (overrides = {}) => ({ ID: 'Build_ConstructorMk1_C_123', ClassName: 'Build_ConstructorMk1_C', Name: 'Constructor', location: { x: -123456.75, y: 65432.5, z: -400, rotation: 90 }, ...overrides });
const json = (body, options) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...options });
const snapshotOf = batches => createSnapshot(batches, { worldId: 'test-world', worldName: 'Test world', sequence: 1234, observedAt: '2026-11-12T12:00:00Z' });

test('retains real centimetres, stable actor ID and recipe; modern clocks are already percent', () => {
  const [entity] = normalizeBatch('getFactory', [base({ ManuSpeed: 250, RecipeClassName: 'Recipe_IronPlate_C', IsProducing: true, PowerInfo: { PowerConsumed: 13.42 } })]).entities;
  assert.deepEqual(entity, { id: 'Build_ConstructorMk1_C_123', className: 'Build_ConstructorMk1_C', name: 'Constructor', kind: 'machine', x: -123456.75, y: 65432.5, z: -400, yaw: 0, recipeId: 'Recipe_IronPlate_C', clockPercent: 250, producing: true, powerMW: 13.42 });
  assert.equal(normalizeBatch('getGenerators', [base({ CurrentPotential: 150 })]).entities[0].clockPercent, 150);
  assert.equal(normalizeBatch('getGenerators', [base({ CurrentPotential: 1 })]).entities[0].clockPercent, 1, 'do not guess that a low modern clock is an old ratio');
  assert.equal(normalizeBatch('getExtractor', [base({ ManuSpeed: 100, RecipeClassName: 'Desc_IronOre_C' })]).entities[0].recipeId, undefined);
});

test('FRM compass rotation converts back to Unreal yaw at all cardinal directions', () => {
  assert.deepEqual([0, 90, 180, 270, 360].map(frmRotationToYaw), [270, 0, 90, 180, 270]);
  assert.equal(frmRotationToYaw(151.5), 61.5);
});

test('unrecognized building classes survive, junctions classify by verified class names', () => {
  const future = base({ ClassName: 'Build_FutureMachine_C', Name: 'Future machine' });
  assert.equal(normalizeBatch('getFactory', [future]).entities[0].className, 'Build_FutureMachine_C');
  for (const [className, kind] of [['Build_ConveyorAttachmentSplitterSmart_C', 'splitter'], ['Build_ConveyorAttachmentMergerPriority_C', 'merger'], ['Build_FutureJunction_C', 'other']]) {
    assert.equal(normalizeBatch('getSplitterMerger', [base({ ClassName: className })]).entities[0].kind, kind);
  }
});

test('no missing, old uppercase, string, nonfinite, or oversized coordinate becomes an invented zero', () => {
  for (const location of [undefined, null, {}, { X: 1, Y: 2, Z: 3 }, { x: 1, y: 2, z: 3 }, { x: '1', y: 2, z: 3, rotation: 0 }, { x: NaN, y: 2, z: 3, rotation: 0 }, { x: 2_000_001, y: 2, z: 3, rotation: 0 }]) {
    assert.throws(() => normalizeBatch('getFactory', [base({ location })]), BridgeError);
  }
  assert.throws(() => normalizeBatch('getFactory', [base({ ID: 0 })]), /ID/);
  assert.throws(() => normalizeBatch('getFactory', [base({ ManuSpeed: 25_000 })]), /clock/);
  assert.throws(() => normalizeBatch('getFactory', [base({ IsProducing: 'false' })]), /true or false/);
});

test('malformed endpoint envelopes are rejected instead of silently treating them as an empty world', () => {
  for (const response of [null, {}, { data: [] }, { error: 'missing mod' }, '[]']) assert.throws(() => normalizeBatch('getFactory', response), /must return an array/);
  assert.throws(() => normalizeBatch('getAll', []), /read-only/);
  assert.throws(() => normalizeBatch('setFactory', []), /read-only/);
  assert.throws(() => normalizeBatch('getFactory', new Array(30_001)), /30,000/);
});

test('only whitelisted map fields leave FRM, including player/storage responses', () => {
  const forbidden = { Inventory: [{ Name: 'SECRET INVENTORY' }], InputInventory: 'SECRET INPUT', OutputInventory: 'SECRET OUTPUT', AccountID: 'SECRET ACCOUNT', SteamID: 'SECRET STEAM', IP: 'SECRET IP', Chat: 'SECRET CHAT', Email: 'SECRET EMAIL', AuthenticationToken: 'SECRET TOKEN', features: { secret: 'SECRET FEATURE' } };
  const player = normalizeBatch('getPlayer', [base({ ...forbidden, Name: 'TestPlayer', Online: true })]);
  const storage = normalizeBatch('getStorageInv', [base({ ...forbidden, ID: 'Storage_1' })]);
  const serialized = JSON.stringify(snapshotOf([player, storage]));
  assert.ok(!serialized.includes('SECRET'));
  assert.ok(!serialized.includes('Inventory'));
  assert.equal(player.entities[0].name, 'TestPlayer');
  assert.equal(player.entities[0].online, true);
  assert.equal(storage.entities[0].kind, 'storage');
});

const transport = (overrides = {}) => base({ ClassName: 'Build_ConveyorBeltMk6_C', location0: { x: 0, y: 20, z: 100 }, location1: { x: 160, y: 20, z: 100 }, SplineData: [{ x: 0, y: 20, z: 100 }, { x: 75, y: 30, z: 100 }, { x: 150, y: 20, z: 100 }], ...overrides });
test('belts retain curved geometry in world cm and append the actual unsampled connector', () => {
  const row = normalizeBatch('getBelts', [transport()]).links[0];
  assert.equal(row.id, 'Build_ConstructorMk1_C_123');
  assert.equal(row.tier, 6);
  assert.deepEqual(row.points, [{ x: 0, y: 20, z: 100 }, { x: 75, y: 30, z: 100 }, { x: 150, y: 20, z: 100 }, { x: 160, y: 20, z: 100 }]);
  const swapped = transport({ location1: transport().location0, location0: transport().location1 });
  assert.deepEqual(normalizeBatch('getBelts', [swapped]).links[0].points, row.points);
});

test('lifts preserve elevation; short pipes retain both real connectors; unknown tiers are omitted', () => {
  const lift = normalizeBatch('getLifts', [transport({ ClassName: 'Build_ConveyorLiftMk3_C', SplineData: undefined, location1: { x: 0, y: 20, z: 2100 } })]).links[0];
  assert.equal(lift.kind, 'belt'); assert.equal(lift.tier, 3); assert.equal(lift.points[1].z, 2100);
  const short = normalizeBatch('getPipes', [transport({ ClassName: 'Build_PipelineMK2_C', SplineData: [transport().location0] })]).links[0];
  assert.equal(short.kind, 'pipe'); assert.equal(short.tier, 2); assert.equal(short.points.length, 2);
  assert.equal(normalizeBatch('getPipes', [transport({ ClassName: 'Build_Pipeline_C' })]).links[0].tier, 1);
  assert.equal(normalizeBatch('getBelts', [transport({ ClassName: 'Build_FutureConveyor_C' })]).links[0].tier, undefined);
  assert.throws(() => normalizeBatch('getBelts', [transport({ SplineData: undefined })]), /SplineData/);
  assert.throws(() => normalizeBatch('getPipes', [transport({ location1: undefined })]), /location1/);
});

test('actor IDs remain deterministic across endpoint reorder and duplicate IDs are refused', () => {
  const a = base({ ID: 'Z' }), b = base({ ID: 'A' });
  assert.deepEqual(snapshotOf([normalizeBatch('getFactory', [a, b])]), snapshotOf([normalizeBatch('getFactory', [b, a])]));
  assert.throws(() => snapshotOf([normalizeBatch('getFactory', [a, a])]), /duplicate actor IDs/);
});

test('configuration requires explicit token/world identity, uses narrow defaults, and has no credential URL support', () => {
  const cfg = loadConfig(env);
  assert.equal(cfg.frmUrl.href, 'http://127.0.0.1:8080/');
  assert.equal(cfg.ingestUrl.href, 'https://satisfactoryvenner.veyro.dk/api/world/ingest');
  assert.equal(cfg.intervalMs, 15_000);
  assert.deepEqual(cfg.endpoints, DEFAULT_ENDPOINTS);
  for (const missing of ['WORLD_INGEST_TOKEN', 'WORLD_ID', 'WORLD_NAME']) assert.throws(() => loadConfig({ ...env, [missing]: undefined }), BridgeError);
  for (const frm of ['http://example.org:8080', 'http://169.254.169.254', 'http://0.0.0.0:8080', 'http://8.8.8.8', 'ftp://127.0.0.1', 'http://u:p@127.0.0.1', 'http://127.0.0.1/getAll', 'http://127.0.0.1/?token=x']) assert.throws(() => loadConfig({ ...env, FRM_URL: frm }), BridgeError);
  for (const frm of ['http://localhost:8080', 'http://10.1.2.3:8080', 'http://172.16.0.8:8080', 'http://192.168.2.4:8080', 'http://[::1]:8080', 'http://[fd12::123]:8080', 'https://private.example.org:8080']) assert.ok(loadConfig({ ...env, FRM_URL: frm }));
  for (const values of [{ WORLD_POLL_SECONDS: '9' }, { WORLD_POLL_SECONDS: 'NaN' }, { WORLD_POLL_SECONDS: '3601' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { WORLD_INGEST_URL: 'http://example.org/api/world/ingest' }, { WORLD_INGEST_URL: 'https://example.org/wrong' }, { FRM_AUTH_TOKEN: 'abc\nsecret' }]) assert.throws(() => loadConfig({ ...env, ...values }), BridgeError);
});

test('endpoint selection is explicit and read-only; it cannot silently skip an unavailable endpoint', () => {
  assert.deepEqual(loadConfig({ ...env, FRM_ENDPOINTS: 'getFactory, getBelts' }).endpoints, ['getFactory', 'getBelts']);
  for (const value of ['', 'getAll', 'getFactory,getFactory', 'setFactory', '../getPlayer', 'getFactory,']) assert.throws(() => loadConfig({ ...env, FRM_ENDPOINTS: value }), BridgeError);
});

test('bounded body reader handles untrusted lengths, chunked bodies, HTML and malformed JSON', async () => {
  assert.deepEqual(await readLimitedJson(json([1, 2]), 'Fixture', 16), [1, 2]);
  await assert.rejects(readLimitedJson(new Response('[]', { headers: { 'content-length': '100' } }), 'Fixture', 10), /byte limit/);
  await assert.rejects(readLimitedJson(new Response('[' + ' '.repeat(100) + ']', { headers: { 'content-type': 'application/json' } }), 'Fixture', 10), /byte limit/);
  await assert.rejects(readLimitedJson(new Response('<h1>Error</h1>', { headers: { 'content-type': 'text/html' } }), 'Fixture'), /did not return JSON/);
  await assert.rejects(readLimitedJson(new Response('{"secret":"NOT LOGGED"', { headers: { 'content-type': 'application/json' } }), 'Fixture'), /malformed JSON/);
});

test('completed polls push once to HTTPS, timestamp covers the oldest observation, sequence is monotonic', async () => {
  const config = loadConfig({ ...env, FRM_AUTH_TOKEN: 'test-frm-token', FRM_ENDPOINTS: 'getFactory,getPlayer' });
  const calls = []; let readCount = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.href, options });
    assert.equal(options.redirect, 'error');
    if (options.method === 'GET') {
      assert.equal(options.headers['X-FRM-Authorization'], 'test-frm-token');
      assert.equal(options.headers.authorization, undefined); readCount++;
      return json(readCount === 1 ? [base()] : []);
    }
    assert.equal(readCount, 2);
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.headers['X-FRM-Authorization'], undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.sequence, 1_800_000_000_101);
    assert.equal(body.observedAt, new Date(1_799_999_990_000).toISOString());
    return json({ accepted: true, sequence: body.sequence });
  };
  const result = await pollAndPublish(config, { fetchImpl, previousSequence: 1_800_000_000_100, now: () => readCount === 0 ? 1_799_999_990_000 : 1_800_000_000_000 });
  assert.equal(calls.length, 3); assert.equal(result.entities, 1);
  assert.ok(calls.at(-1).url.startsWith('https://'));
});

test('a failed/malformed/unsupported selected endpoint prevents the entire upload', async () => {
  for (const failure of [() => json({ error: 'unsupported' }), () => json({}, { status: 404 }), () => json([base({ location: null })]), () => { throw new Error('SECRET FAILURE BODY'); }]) {
    let calls = 0, posts = 0;
    await assert.rejects(pollAndPublish(loadConfig({ ...env, FRM_ENDPOINTS: 'getFactory,getPlayer' }), { fetchImpl: async (_url, options) => {
      if (options.method === 'POST') posts++;
      calls++; return calls === 1 ? json([base()]) : failure();
    } }), BridgeError);
    assert.equal(posts, 0);
  }
});

test('revoked token, world conflicts, transport failures and unacknowledged uploads never count as success', async () => {
  const config = loadConfig({ ...env, FRM_ENDPOINTS: 'getFactory' });
  for (const response of [json({}, { status: 401 }), json({}, { status: 409 }), json({ accepted: false }), json({ accepted: true, sequence: 0 })]) {
    await assert.rejects(pollAndPublish(config, { fetchImpl: async (_url, options) => options.method === 'GET' ? json([]) : response }), BridgeError);
  }
  await assert.rejects(pollAndPublish(config, { fetchImpl: async () => { throw new Error(`secret ${token}`); } }), error => error instanceof BridgeError && !error.message.includes(token));
});

test('abort interrupts a poll; no map upload follows an aborted read', async () => {
  const controller = new AbortController(); let posted = false;
  const promise = pollAndPublish(loadConfig({ ...env, FRM_ENDPOINTS: 'getFactory' }), { signal: controller.signal, fetchImpl: async (_url, options) => {
    if (options.method === 'POST') posted = true;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  controller.abort();
  await assert.rejects(promise, /timed out or was stopped/);
  assert.equal(posted, false);
});

test('loop serializes polls, backs off failures, recovers, and never logs tokens or raw responses', async () => {
  const controller = new AbortController(), waits = [], logs = [];
  let getCount = 0, active = 0, maxActive = 0;
  const config = loadConfig({ ...env, FRM_ENDPOINTS: 'getFactory,getPlayer' });
  await runBridge(config, {
    signal: controller.signal, log: value => logs.push(value),
    fetchImpl: async (_url, options) => {
      active++; maxActive = Math.max(maxActive, active);
      try {
        await Promise.resolve();
        if (options.method === 'GET') { getCount++; if (getCount === 1) throw new Error(`secret ${token}`); return json([]); }
        return json({ accepted: true, sequence: JSON.parse(options.body).sequence });
      } finally { active--; }
    },
    wait: async ms => { waits.push(ms); if (waits.length === 2) controller.abort(); },
  });
  assert.equal(maxActive, 1);
  assert.deepEqual(waits, [30_000, 15_000]);
  assert.ok(!logs.join(' ').includes(token));
  assert.ok(logs.some(line => line.includes('Map accepted')));
  assert.equal(retryDelay(15_000, 100), 300_000);
});
