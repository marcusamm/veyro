import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const data = JSON.parse(await readFile(new URL('./satisfactory-1.2.json', import.meta.url), 'utf8'));
const recipes = new Map(data.recipes.map(r => [r.id, r]));
const machines = new Map(data.machines.map(m => [m.id, m]));
const items = new Map(data.items.map(i => [i.id, i]));
const rate = (id, side, itemId) => {
  const r = recipes.get(id);
  return r[side].find(v => v.itemId === itemId).amount * 60 / r.durationSeconds * machines.get(r.machineId).manufacturingSpeed;
};

test('snapshot is pinned to stable 1.2.5.0 and retains all machine recipes', () => {
  assert.equal(data.provenance.gameVersion, '1.2.5.0');
  assert.equal(data.provenance.steamBuildId, '26281294');
  assert.equal(data.recipes.length, 276);
  assert.equal(data.items.length, 175);
  assert.equal(data.machines.length, 11);
  assert.equal(recipes.size, data.recipes.length);
  assert.equal(machines.size, data.machines.length);
  assert.equal(items.size, data.items.length);
  for (const r of recipes.values()) {
    assert.ok(machines.has(r.machineId), r.id);
    assert.ok(r.durationSeconds > 0, r.id);
    for (const row of [...r.ingredients, ...r.products]) {
      assert.ok(items.has(row.itemId), r.id);
      assert.ok(row.amount > 0 && Number.isFinite(row.amount), r.id);
    }
  }
});

test('basic iron recipes preserve exact per-minute quantities', () => {
  assert.equal(rate('Recipe_IngotIron_C', 'ingredients', 'Desc_OreIron_C'), 30);
  assert.equal(rate('Recipe_IngotIron_C', 'products', 'Desc_IronIngot_C'), 30);
  assert.equal(rate('Recipe_IronPlate_C', 'ingredients', 'Desc_IronIngot_C'), 30);
  assert.equal(rate('Recipe_IronPlate_C', 'products', 'Desc_IronPlate_C'), 20);
  assert.equal(rate('Recipe_Screw_C', 'ingredients', 'Desc_IronRod_C'), 10);
  assert.equal(rate('Recipe_Screw_C', 'products', 'Desc_IronScrew_C'), 40);
});

test('liquid quantities use m³ once and retain byproducts', () => {
  assert.equal(items.get('Desc_Water_C').unit, 'm³');
  assert.equal(rate('Recipe_AluminaSolution_C', 'ingredients', 'Desc_Water_C'), 180);
  assert.equal(rate('Recipe_AluminaSolution_C', 'products', 'Desc_AluminaSolution_C'), 120);
  assert.equal(rate('Recipe_AluminaSolution_C', 'products', 'Desc_Silica_C'), 50);
});

test('all transport tiers use the game capacities, without rounding', () => {
  assert.deepEqual(data.transport.belts.map(b => b.capacity), [60, 120, 270, 480, 780, 1200]);
  assert.deepEqual(data.transport.pipes.map(p => p.capacity), [300, 600]);
});

test('variable machine power and fixed Blender power are distinguished', () => {
  const pasta = recipes.get('Recipe_SpaceElevatorPart_9_C');
  assert.equal(pasta.powerMinMW, 500);
  assert.equal(pasta.powerMaxMW, 1500);
  assert.equal(pasta.powerMW, 1000);
  const sculpture = data.recipes.find(r => r.name === 'Biochemical Sculptor');
  assert.ok(sculpture);
  assert.equal(sculpture.powerMinMW, 75);
  assert.equal(sculpture.powerMaxMW, 75);
});

test('schematic dataset does not invent physical machine footprints', () => {
  for (const m of machines.values()) {
    assert.equal(m.footprintVerified, false);
    assert.equal(m.widthM, undefined);
    assert.equal(m.lengthM, undefined);
    assert.equal(m.maxClockPercent, 250);
  }
});
