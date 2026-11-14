import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ stdin: { contents: `export * from './app/factory/allocation.ts'; export * from './app/factory/production.ts'; export * from './app/factory/construction.ts'; export * from './app/factory/engine.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { allocatePowerShards, solveProductionPlan, productionBoosts, recipeRates, constructionMaterials } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);
const request = (rate, options = {}) => ({ outputs: [{ itemId: 'Desc_IronPlate_C', rate }], clock: 250, beltTier: 6, pipeTier: 2, powerShardBudget: 0, ...options });
function solve(req) { const plan = solveProductionPlan(req); assert.equal(plan.status, 'optimal', plan.message); return plan; }
function conserved(before, after) {
  assert.deepEqual(after.resources, before.resources); assert.deepEqual(after.products, before.products);
  for (const recipe of before.recipes) {
    const next = after.recipes.find(row => row.recipeId === recipe.recipeId);
    for (const side of ['inputs', 'outputs']) for (const row of recipe[side]) near(next[side].find(value => value.itemId === row.itemId).rate, row.rate);
  }
}

test('zero shards retains full machines and a partial machine; one shard removes the second constructor', () => {
  const req = request(30, { inputs: [{ itemId: 'Desc_IronIngot_C', rate: 45 }], capInputs: true });
  const original = solve(req), snapshot = JSON.stringify(original);
  const zero = allocatePowerShards(original, req, 0), one = allocatePowerShards(original, req, 1);
  assert.equal(zero.plan.totals.machines, 2); assert.equal(zero.shardsUsed, 0);
  assert.equal(one.plan.totals.machines, 1); assert.equal(one.shardsUsed, 1); assert.equal(one.shardsUnused, 0);
  near(one.plan.recipes[0].variants[0].clock, 150);
  assert.equal(one.plan.recipes[0].clockLimited, false);
  near(one.plan.totals.powerMW, recipeRates('Recipe_IronPlate_C', 150).powerMW);
  conserved(original, one.plan); assert.equal(JSON.stringify(original), snapshot);
  assert.equal(constructionMaterials(one.plan).find(row => row.itemId === 'Desc_IronPlateReinforced_C').rate, 2);
});

test('extraction wins a tie when one shard can remove either a miner or a production machine', () => {
  const req = request(30), original = solve(req);
  const allocation = allocatePowerShards(original, req, 1, { minerTier: 1, purity: 'impure', clock: 250 });
  assert.equal(allocation.extraction.count, 1); near(allocation.extraction.rows[0].clockGroups[0].clock, 150);
  assert.equal(allocation.plan.totals.machines, 4); assert.equal(allocation.plan.totals.powerShards, 0);
  assert.equal(allocation.shardsUsed, 1); conserved(original, allocation.plan);
});

test('one shared budget accounts for production and extraction shards together', () => {
  const req = request(60), original = solve(req);
  const allocation = allocatePowerShards(original, req, 3, { minerTier: 1, purity: 'normal', clock: 250 });
  assert.equal(allocation.extraction.count, 1); assert.equal(allocation.extraction.powerShards, 1);
  assert.equal(allocation.plan.totals.machines, 5); assert.equal(allocation.plan.totals.powerShards, 2);
  assert.equal(allocation.shardsUsed, 3); conserved(original, allocation.plan);
});

test('a belt-limited recipe gets mixed clocks without inventing transport capacity', () => {
  const req = request(1, { outputs: [{ itemId: 'Desc_IronScrew_C', rate: 100 }], inputs: [{ itemId: 'Desc_IronRod_C', rate: 25 }], capInputs: true, beltTier: 1 });
  const original = solve(req), allocation = allocatePowerShards(original, req, 20);
  assert.equal(allocation.plan.totals.machines, 2); assert.equal(allocation.shardsUsed, 1); assert.equal(allocation.shardsUnused, 19);
  const variants = allocation.plan.recipes[0].variants;
  assert.deepEqual(variants.map(row => row.clock), [150, 100]);
  for (const variant of variants) assert.ok(recipeRates('Recipe_Screw_C', variant.clock).outputs[0].rate <= 60);
  conserved(original, allocation.plan);
});

test('fractional pipe caps spend one shard for each partial clock step they unlock', () => {
  const req = request(20, { inputs: [{ itemId: 'Desc_IronIngot_C', rate: 30 }], capInputs: true, pipeTier: 1 });
  const plan = { ...solve(req), resources: [{ itemId: 'Desc_LiquidOil_C', rate: 840 }] };
  const allocation = allocatePowerShards(plan, req, 2, { purity: 'pure', clock: 250 });
  assert.equal(allocation.extraction.count, 3); assert.equal(allocation.extraction.powerShards, 2);
  assert.deepEqual(allocation.extraction.rows[0].clockGroups.map(row => [row.count, row.clock]), [[2, 125], [1, 100]]);
  near(allocation.extraction.powerMW, 40 * (2 * Math.pow(1.25, 1.321929) + 1));
});

test('automatic Somersloop variants stay at or below 100% and within their inventory budget', () => {
  const req = request(60, { somersloopBudget: 1, powerShardBudget: 10 }), original = solve(req);
  const allocation = allocatePowerShards(original, req, 10, { clock: 250 });
  assert.ok(allocation.plan.totals.somersloops > 0 && allocation.plan.totals.somersloops <= 1);
  for (const row of allocation.plan.recipes) for (const variant of row.variants) if (variant.sloops) {
    assert.ok(variant.clock <= 100); assert.equal(variant.powerShards, 0);
  }
  assert.equal(productionBoosts(allocation.plan).somersloops, allocation.plan.totals.somersloops);
  conserved(original, allocation.plan);
});

test('shards remain unused when no building can be removed, and unsupported wells remain explicit', () => {
  const req = request(20, { inputs: [{ itemId: 'Desc_IronIngot_C', rate: 30 }], capInputs: true });
  const original = solve(req), allocation = allocatePowerShards({ ...original, resources: [{ itemId: 'Desc_NitrogenGas_C', rate: 120 }] }, req, 100);
  assert.equal(allocation.shardsUsed, 0); assert.equal(allocation.shardsUnused, 100); assert.equal(allocation.extraction.complete, false);
  assert.equal(allocation.plan.totals.machines, 1);
  for (const budget of [-1, .5, 10001, NaN]) assert.throws(() => allocatePowerShards(original, req, budget));
});
test('omitted transport tiers retain the production solver defaults during shard allocation', () => {
  const req = { outputs: [{ itemId: 'Desc_IronScrew_C', rate: 100 }], inputs: [{ itemId: 'Desc_IronRod_C', rate: 25 }], capInputs: true, clock: 250, powerShardBudget: 3 };
  const original = solve(req), allocation = allocatePowerShards(original, req, 3);
  assert.equal(allocation.plan.totals.machines, 1);
  near(allocation.plan.recipes[0].clock, 250);
  assert.equal(allocation.shardsUsed, 3);
  conserved(original, allocation.plan);
});

