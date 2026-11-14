import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export * from './app/factory/construction.ts'; export * from './app/factory/production.ts'; export * from './app/factory/engine.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { constructionMaterials, productionBoosts, planExtraction, manifoldMaterials, solveProductionPlan, catalog, itemById } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const data = JSON.parse(await readFile(new URL('../app/factory/data/construction-costs.json', import.meta.url), 'utf8'));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const quantity = (rows, itemId) => rows.find(row => row.itemId === itemId)?.rate || 0;
const request = { outputs: [{ itemId: 'Desc_IronPlate_C', rate: 60 }], beltTier: 3, pipeTier: 1 };
const plan = solveProductionPlan(request);
assert.equal(plan.status, 'optimal');
const resources = (rows, settings = request, options = {}) => planExtraction({ ...plan, resources: rows }, settings, options);

test('construction supplement covers every production machine and preserves the reviewed source pin', () => {
  assert.equal(data.provenance.sourceSha256, catalog.provenance.sourceSha256);
  assert.equal(data.provenance.gameVersion, '1.2.5.0');
  assert.equal(Object.keys(data.costs).length, 20);
  for (const machine of catalog.machines) assert.ok(data.costs[machine.id]?.length, machine.id);
  for (const list of Object.values(data.costs)) for (const row of list) {
    assert.ok(itemById[row.itemId], row.itemId);
    assert.ok(Number.isSafeInteger(row.rate) && row.rate > 0);
  }
});

test('60 plates require three smelters and constructors, with integer construction bills', () => {
  assert.equal(plan.totals.machines, 6);
  const bill = constructionMaterials(plan);
  assert.equal(bill.length, 4);
  assert.equal(quantity(bill, 'Desc_IronRod_C'), 15);
  assert.equal(quantity(bill, 'Desc_Wire_C'), 24);
  assert.equal(quantity(bill, 'Desc_IronPlateReinforced_C'), 6);
  assert.equal(quantity(bill, 'Desc_Cable_C'), 24);
  assert.equal(quantity(bill, 'BP_ItemDescriptorPortableMiner_C'), 0);
});

test('installed boosts remain separate from the construction ingredients', () => {
  const boosted = solveProductionPlan({ ...request, recipeClocks: { Recipe_IronPlate_C: 250 }, sloops: { Recipe_IronPlate_C: 1 } });
  assert.equal(boosted.status, 'optimal');
  assert.deepEqual(productionBoosts(boosted), { powerShards: 1, somersloops: 1 });
  assert.equal(quantity(constructionMaterials(boosted), 'Desc_IronPlateReinforced_C'), 2);
});

test('90 iron ore sizes two normal Mk.1 miners and accounts for the partial miner power', () => {
  const supply = planExtraction(plan, request);
  assert.equal(supply.complete, true); assert.equal(supply.count, 2);
  const row = supply.rows[0]; assert.equal(row.machineId, 'Desc_MinerMk1_C');
  near(row.clock, 100); near(row.lastClock, 50);
  near(supply.powerMW, 5 + 5 * Math.pow(.5, 1.321929));
  assert.equal(quantity(supply.materials, 'BP_ItemDescriptorPortableMiner_C'), 2);
  assert.equal(quantity(supply.materials, 'Desc_IronPlate_C'), 20);
  assert.equal(quantity(supply.materials, 'Desc_Cement_C'), 20);
});

test('a Mk.3 miner on pure nodes is limited by its own outgoing belt', () => {
  const supply = resources([{ itemId: 'Desc_OreIron_C', rate: 600 }], request, { minerTier: 3, purity: 'pure', clock: 250 });
  const row = supply.rows[0];
  assert.equal(row.count, 3); assert.equal(row.clockLimited, true);
  near(row.perMachineRate, 270); near(row.clock, 56.25); near(row.lastClock, 12.5);
  assert.equal(row.powerShards, 0);
  near(row.powerMW, 45 * (2 * Math.pow(.5625, 1.321929) + Math.pow(.125, 1.321929)));
});
test('omitted transport choices use the same Mk.6 belt and Mk.2 pipe defaults as the production solver', () => {
  const req = { outputs: request.outputs };
  const ore = resources([{ itemId: 'Desc_OreIron_C', rate: 1200 }], req, { minerTier: 3, purity: 'pure', clock: 250 });
  assert.equal(ore.count, 1);
  near(ore.rows[0].clock, 250);
  const oil = resources([{ itemId: 'Desc_LiquidOil_C', rate: 600 }], req, { purity: 'pure', clock: 250 });
  assert.equal(oil.count, 1);
  near(oil.rows[0].clock, 250);
});

test('oil purity, water without purity, pipe capacity and shard thresholds remain distinct', () => {
  const oil = resources([{ itemId: 'Desc_LiquidOil_C', rate: 450 }], request, { purity: 'pure', clock: 250 }).rows[0];
  assert.equal(oil.count, 2); near(oil.clock, 125); near(oil.lastClock, 62.5); assert.equal(oil.powerShards, 1);
  const water = resources([{ itemId: 'Desc_Water_C', rate: 450 }], { ...request, pipeTier: 2, settings: { recipeMultiplier: .25, powerMultiplier: 2 } }, { purity: 'impure', clock: 250 }).rows[0];
  assert.equal(water.purity, undefined); assert.equal(water.count, 2);
  near(water.clock, 250); near(water.lastClock, 125); assert.equal(water.powerShards, 4);
  near(water.powerMW, 40 * (Math.pow(2.5, 1.321929) + Math.pow(1.25, 1.321929)));
});

test('nitrogen needs explicit well context and cannot silently receive zero-cost extraction', () => {
  const supply = resources([{ itemId: 'Desc_NitrogenGas_C', rate: 120 }]);
  assert.equal(supply.complete, false); assert.equal(supply.rows[0].supported, false);
  assert.match(supply.rows[0].reason, /satellite purities.*pressurizer/);
  assert.deepEqual(supply.materials, []);
  const existing = planExtraction({ ...plan, resources: [], externalInputs: [{ itemId: 'Desc_NitrogenGas_C', rate: 120 }] }, request);
  assert.deepEqual(existing.rows, []); assert.equal(existing.count, 0);
});

test('tiny extraction targets retain physical minimum clocks and an explicit duty cycle', () => {
  const row = resources([{ itemId: 'Desc_OreIron_C', rate: .001 }]).rows[0];
  assert.equal(row.count, 1); near(row.lastClock, 1); near(row.dutyCycle, .001 / .6);
  near(row.powerMaxMW, 5 * Math.pow(.01, 1.321929));
  near(row.powerMW, row.powerMaxMW * row.dutyCycle);
  for (const clock of [0, 251, NaN]) assert.throws(() => resources([], request, { clock }));
  assert.throws(() => constructionMaterials({ ...plan, recipes: [{ machineId: 'missing', machineCount: 1 }] }), /unavailable/);
});

test('verified splitter, merger and pipe-junction costs form a separate exact schematic bill', () => {
  const bill = manifoldMaterials({ componentsComplete: true, components: [
    { machineId: 'Desc_ConveyorAttachmentSplitter_C', count: 3 },
    { machineId: 'Desc_ConveyorAttachmentMerger_C', count: 2 },
    { machineId: 'Desc_PipelineJunction_Cross_C', count: 4 },
    { machineId: 'Desc_PipelineJunction_T_C', count: 1 },
  ] });
  assert.equal(bill.length, 4);
  assert.equal(quantity(bill, 'Desc_IronPlate_C'), 10);
  assert.equal(quantity(bill, 'Desc_Cable_C'), 6);
  assert.equal(quantity(bill, 'Desc_IronRod_C'), 4);
  assert.equal(quantity(bill, 'Desc_CopperSheet_C'), 25);
  assert.equal(quantity(constructionMaterials(plan), 'Desc_IronPlate_C'), 0);
});

test('large or incomplete manifold previews never become a partial inventory bill', () => {
  assert.deepEqual(manifoldMaterials({ componentsComplete: false, components: [{ machineId: 'Desc_ConveyorAttachmentSplitter_C', count: 50 }] }), []);
  assert.deepEqual(manifoldMaterials({ componentsComplete: true, components: [] }), []);
  for (const count of [-1, .5, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => manifoldMaterials({ componentsComplete: true, components: [{ machineId: 'Desc_ConveyorAttachmentSplitter_C', count }] }));
  assert.throws(() => manifoldMaterials({ componentsComplete: true, components: [{ machineId: 'invented-junction', count: 1 }] }));
});

