import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ stdin: { contents: `export * from './app/factory/editor.ts'; export * from './app/factory/engine.ts'; export * from './app/factory/validation.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { changeProductionRecipe, changeExtractorBuilding, changeNodeMaterial, parseNumericDraft, nodeBounds, createEmptyFactoryLayout, validateFactoryLayout, calculateFactory } = api;
const ore = 'Desc_OreIron_C', iron = 'Desc_IronIngot_C';
function ironLine() {
 return { ...createEmptyFactoryLayout(), nodes: [
  { id: 'supply', kind: 'source', itemId: ore, rate: 60, x: -30, y: 0, rotation: 0 },
  { id: 'smelter', kind: 'machine', recipeId: 'Recipe_IngotIron_C', clock: 100, sloops: 1, x: 0, y: 0, rotation: 0 },
  { id: 'output', kind: 'sink', itemId: iron, rate: 1000, x: 30, y: 0, rotation: 0 }
 ], edges: [
  { id: 'ore-belt', from: 'supply', to: 'smelter', fromPort: 'out:0', toPort: `in:${ore}`, itemId: ore, transport: 'belt', tier: 1 },
  { id: 'ingot-belt', from: 'smelter', to: 'output', fromPort: `out:${iron}`, toPort: 'in:0', itemId: iron, transport: 'belt', tier: 1 }
 ] };
}
test('upgrade saved manual supply to a miner, change tiers and reload without losing matching belts', () => {
 const layout = ironLine();
 changeExtractorBuilding(layout, 'supply', 'Desc_MinerMk1_C');
 assert.equal(layout.nodes[0].kind, 'extractor'); assert.equal(layout.nodes[0].rate, undefined); assert.equal(layout.edges.length, 2);
 for (const tier of [1, 2, 3]) {
  changeExtractorBuilding(layout, 'supply', `Desc_MinerMk${tier}_C`);
  const restored = validateFactoryLayout(JSON.parse(JSON.stringify(layout)));
  const result = calculateFactory(restored);
  assert.equal(result.supported, true); assert.equal(restored.nodes[0].extractorId, `Desc_MinerMk${tier}_C`);
  assert.equal(result.nodes.supply.outputs[0].rate, [60, 120, 240][tier - 1]);
  assert.equal(restored.edges.length, 2); assert.ok(result.nodes.supply.powerMW > 0);
 }
});
test('switching extractor medium removes incompatible belts and resets water purity', () => {
 const layout = ironLine(); changeExtractorBuilding(layout, 'supply', 'Desc_MinerMk3_C'); layout.nodes[0].purity = 'pure'; layout.nodes[0].clock = 200;
 changeExtractorBuilding(layout, 'supply', 'Desc_WaterPump_C');
 assert.equal(layout.nodes[0].itemId, 'Desc_Water_C'); assert.equal(layout.nodes[0].purity, 'normal'); assert.equal(layout.nodes[0].clock, 200);
 assert.deepEqual(layout.edges.map(e => e.id), ['ingot-belt']);
 assert.doesNotThrow(() => validateFactoryLayout(layout));
});
test('new recipe retains matching inputs and outputs and preserves usable Somersloops', () => {
 const layout = ironLine(); changeProductionRecipe(layout, 'smelter', 'Recipe_Alternate_PureIronIngot_C');
 assert.equal(layout.nodes[1].sloops, 1); assert.equal(layout.edges.length, 2);
 assert.doesNotThrow(() => validateFactoryLayout(layout));
 changeProductionRecipe(layout, 'smelter', 'Recipe_IronPlate_C');
 assert.equal(layout.edges.length, 0); assert.equal(layout.nodes[1].sloops, 1);
 assert.doesNotThrow(() => validateFactoryLayout(layout));
});
test('changing a junction material clears old filters and connections but a no-op keeps them', () => {
 const layout = ironLine(); changeNodeMaterial(layout, 'supply', ore); assert.equal(layout.edges.length, 2);
 changeNodeMaterial(layout, 'supply', 'Desc_Coal_C'); assert.deepEqual(layout.edges.map(e => e.id), ['ingot-belt']);
 assert.doesNotThrow(() => validateFactoryLayout(layout));
});
test('numeric entry never treats an empty or partial input as zero or accepts non-finite values', () => {
 for (const value of ['', ' ', '-', '.', '1e', 'NaN', 'Infinity', '-1', '251']) assert.equal(parseNumericDraft(value, 0, 250), null, value);
 assert.equal(parseNumericDraft('0', 0, 250), 0); assert.equal(parseNumericDraft('125.5', 1, 250), 125.5);
 assert.equal(parseNumericDraft('0', 1, 250), null);
});
test('fit bounds contain the complete rotated multi-port building', () => {
 const node = { id: 'large', kind: 'machine', x: 100, y: -20, rotation: 90 };
 const bounds = nodeBounds(node, 22, 45);
 assert.ok(bounds.minX < 100 - 22.5); assert.ok(bounds.maxX > 100 + 22.5);
 assert.ok(bounds.minY < -31); assert.ok(bounds.maxY > -9);
});

test('integer budgets reject decimals without rounding or changing the saved value', () => {
 for (const draft of ['0.5', '1.99', '-1', 'Infinity', '']) assert.equal(parseNumericDraft(draft, 0, 500, true), null);
 assert.equal(parseNumericDraft('0', 0, 500, true), 0);
 assert.equal(parseNumericDraft('12', 0, 500, true), 12);
 assert.equal(parseNumericDraft('12.0', 0, 500, true), 12);
 assert.equal(parseNumericDraft('12.5', 0, 500), 12.5);
});
