import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export * from './app/factory/templates.ts'; export * from './app/factory/production.ts'; export * from './app/factory/engine.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { factoryTemplates, templateRequest, generateBuildGuide, solveProductionPlan, catalog, recipeById, itemById } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} != ${expected}`);
const rate = (rows, itemId) => rows.find(row => row.itemId === itemId)?.rate ?? 0;
const solve = (id, scale = 1) => {
  const plan = solveProductionPlan(templateRequest(id, scale));
  assert.equal(plan.status, 'optimal', `${id}: ${plan.message}`);
  return plan;
};

test('template catalog has concrete valid game targets and authored standard chains', () => {
  assert.equal(factoryTemplates.length, 14);
  assert.equal(new Set(factoryTemplates.map(template => template.id)).size, factoryTemplates.length);
  for (const template of factoryTemplates) {
    assert.ok(template.steps.length >= 3, template.id);
    assert.ok(template.tips.length >= 2, template.id);
    assert.ok(template.title && template.description && template.category && template.difficulty, template.id);
    for (const output of template.outputs) {
      assert.ok(itemById[output.itemId], `${template.id} output`);
      assert.ok(output.rate > 0 && Number.isFinite(output.rate), template.id);
    }
    for (const id of template.recipeIds) assert.ok(recipeById[id], `${template.id} recipe ${id}`);
  }
});

test('scaled requests copy targets and retain the authored recipe whitelist', () => {
  const template = factoryTemplates.find(template => template.id === 'iron-plates');
  const first = templateRequest(template, 2.5, { clock: 150, beltTier: 2 });
  assert.equal(first.clock, 150);
  assert.equal(first.beltTier, 2);
  assert.deepEqual(first.outputs, [{ itemId: 'Desc_IronPlate_C', rate: 150 }]);
  assert.deepEqual(catalog.recipes.filter(recipe => !first.excludedRecipes.includes(recipe.id)).map(recipe => recipe.id).sort(), [...template.recipeIds].sort());
  first.outputs[0].rate = 1;
  assert.equal(template.outputs[0].rate, 60);
  for (const scale of [0, -1, NaN, Infinity, 1001]) assert.throws(() => templateRequest(template, scale));
  assert.throws(() => templateRequest('not-a-template'));
});

test('every factory template is mass balanced at normal and fractional scale', () => {
  for (const template of factoryTemplates) for (const scale of [1, 0.5]) {
    const plan = solve(template.id, scale);
    for (const output of template.outputs) near(rate(plan.products, output.itemId), output.rate * scale, `${template.id} target`);
    for (const balance of plan.balances) near(balance.produced + balance.external, balance.consumed + balance.requested + balance.surplus, `${template.id} ${balance.itemId}`);
    for (const row of plan.recipes) assert.ok(template.recipeIds.includes(row.recipeId), `${template.id} unexpected recipe ${row.recipeId}`);
    const guide = generateBuildGuide(plan);
    assert.equal(guide.machines.reduce((sum, row) => sum + row.count, 0), plan.totals.machines);
    assert.ok(guide.steps.some(step => step.id === 'connections'));
    assert.ok(guide.steps.some(step => step.id === 'power-startup'));
    assert.ok(!JSON.stringify(guide).includes('undefined'));
    assert.ok(!JSON.stringify(guide).includes('NaN'));
  }
});

test('starter modules include all upstream requirements, not just the last recipe', () => {
  const cases = [
    ['iron-plates', 'Desc_OreIron_C', 90, 6],
    ['iron-rods', 'Desc_OreIron_C', 60, 6],
    ['screws', 'Desc_OreIron_C', 30, 6],
    ['wire', 'Desc_OreCopper_C', 60, 6],
    ['cable', 'Desc_OreCopper_C', 60, 8],
    ['concrete', 'Desc_Stone_C', 180, 4],
  ];
  for (const [id, item, required, machines] of cases) {
    const plan = solve(id);
    near(rate(plan.resources, item), required, id);
    assert.equal(plan.totals.machines, machines, id);
  }
});

test('plastic and rubber module continuously consumes its heavy oil residue', () => {
  const plan = solve('plastic-rubber');
  near(rate(plan.resources, 'Desc_LiquidOil_C'), 120);
  near(rate(plan.products, 'Desc_Plastic_C'), 40);
  near(rate(plan.products, 'Desc_Rubber_C'), 40);
  near(rate(plan.products, 'Desc_PetroleumCoke_C'), 180);
  near(rate(plan.surplus, 'Desc_HeavyOilResidue_C'), 0);
  const residue = plan.balances.find(row => row.itemId === 'Desc_HeavyOilResidue_C');
  near(residue.produced, 60);
  near(residue.consumed, 60);
  assert.ok(factoryTemplates.find(template => template.id === 'plastic-rubber').steps.some(step => step.includes('AWESOME Sink')));
});

test('aluminum template credits recycled water and recovered silica', () => {
  const plan = solve('aluminum-sheets');
  for (const [itemId, required] of [['Desc_OreBauxite_C', 60], ['Desc_Water_C', 60], ['Desc_Coal_C', 30], ['Desc_RawQuartz_C', 30], ['Desc_OreCopper_C', 20]]) near(rate(plan.resources, itemId), required, itemId);
  const water = plan.balances.find(row => row.itemId === 'Desc_Water_C');
  near(water.produced, 30);
  near(water.consumed, 90);
  const guide = generateBuildGuide(plan);
  assert.ok(guide.steps.some(step => step.title.includes('recycling group')));
  assert.ok(guide.steps.find(step => step.id === 'supplies').details.some(text => text.includes('60 m³/min Water')));
});

test('build guides update numerical supplies and clocks after scaling', () => {
  const plan = solve('iron-plates', 1.25);
  const guide = generateBuildGuide(plan);
  assert.ok(guide.steps.find(step => step.id === 'supplies').details.some(text => text.includes('112.5 items/min Iron Ore')));
  const instructions = guide.steps.flatMap(step => step.details).join('\n');
  assert.match(instructions, /75%/);
  assert.match(instructions, /75 items\/min Iron Plate/);
  assert.ok(guide.warnings.some(text => text.includes('Physical footprints')));
});

test('build guides state the actual boosts and transport-limited machine clocks', () => {
  const boosted = solveProductionPlan(templateRequest('iron-plates', 1, { clock: 150, sloops: { Recipe_IronPlate_C: 1 } }));
  assert.equal(boosted.status, 'optimal');
  const boostedText = generateBuildGuide(boosted).steps.flatMap(step => step.details).join('\n');
  assert.match(boostedText, /Install 1 Somersloop in each machine/);
  assert.match(boostedText, /Power Shards/);
  const limited = solveProductionPlan(templateRequest('screws', 1, { clock: 250, beltTier: 1 }));
  assert.equal(limited.status, 'optimal');
  assert.ok(limited.recipes.some(recipe => recipe.clockLimited));
  assert.match(generateBuildGuide(limited).steps.flatMap(step => step.details).join('\n'), /belt or pipe tier limits this recipe/);
});

test('mixed Somersloop groups have distinct build instructions instead of a false uniform schedule', () => {
  const plan = solveProductionPlan({ outputs: [{ itemId: 'Desc_IronPlate_C', rate: 60 }], inputs: [{ itemId: 'Desc_IronIngot_C', rate: 90 }], resourcePolicy: 'closed', excludedRecipes: catalog.recipes.filter(recipe => recipe.id !== 'Recipe_IronPlate_C').map(recipe => recipe.id) });
  assert.equal(plan.status, 'optimal');
  const original = plan.recipes[0];
  const group = (sloops, output, power) => ({ exactMachines: 1, machineCount: 1, fullMachines: 0, requestedClock: 100, clock: 100, lastClock: 100, clockLimited: false, dutyCycle: 1, sloops, powerShards: 0, inputs: [{ itemId: 'Desc_IronIngot_C', rate: 30 }], outputs: [{ itemId: 'Desc_IronPlate_C', rate: output }], powerMW: power, powerMinMW: power, powerMaxMW: power });
  plan.recipes = [{ ...original, machineCount: 2, exactMachines: 2, fullMachines: 1, sloops: 0, totalSomersloops: 1, variants: [group(0, 20, 4), group(1, 40, 16)], inputs: [{ itemId: 'Desc_IronIngot_C', rate: 60 }], powerMW: 20, powerMinMW: 20, powerMaxMW: 20 }];
  plan.externalInputs = [{ itemId: 'Desc_IronIngot_C', rate: 60 }];
  plan.totals = { machines: 2, powerMW: 20, powerMinMW: 20, powerMaxMW: 20, powerShards: 0, somersloops: 1 };
  const guide = generateBuildGuide(plan), instructions = guide.steps.flatMap(step => step.details).join('\n');
  assert.equal(guide.machines.find(machine => machine.name === 'Constructor')?.count, 2);
  assert.match(instructions, /Iron Plate, group 1: Place 1 × Constructor/);
  assert.match(instructions, /Iron Plate, group 2: Place 1 × Constructor/);
  assert.match(instructions, /Leave the Somersloop slots empty in this group/);
  assert.match(instructions, /Install 1 Somersloop in each machine \(1 total for this group\)/);
  assert.match(instructions, /Collect from this group: 20 items\/min Iron Plate/);
  assert.match(instructions, /Collect from this group: 40 items\/min Iron Plate/);
  assert.match(instructions, /Reserve 0 Power Shards and 1 Somersloop for/);
  assert.doesNotMatch(instructions, /Place 2 × Constructor/);
});

test('limited Somersloops produce buildable mixed groups within the installed budget', () => {
  const request = { outputs: [{ itemId: 'Desc_IronPlate_C', rate: 60 }], inputs: [{ itemId: 'Desc_IronIngot_C', rate: 90 }], resourcePolicy: 'closed', clock: 100, beltTier: 3, excludedRecipes: catalog.recipes.filter(recipe => recipe.id !== 'Recipe_IronPlate_C').map(recipe => recipe.id) };
  for (const [budget, expectedIngots, expectedMachines] of [[0, 90, 3], [1, 60, 2], [2, 45, 2]]) {
    const plan = solveProductionPlan({ ...request, somersloopBudget: budget });
    assert.equal(plan.status, 'optimal', plan.message);
    const installed = plan.recipes.flatMap(row => row.variants).reduce((sum, variant) => sum + variant.machineCount * variant.sloops, 0);
    assert.ok(installed <= budget, `${installed} installed exceeds budget ${budget}`);
    assert.equal(plan.totals.somersloops, installed);
    near(rate(plan.externalInputs, 'Desc_IronIngot_C'), expectedIngots, 'ingot use');
    assert.equal(plan.totals.machines, expectedMachines);
    if (budget === 1) {
      assert.equal(plan.recipes[0].variants.length, 2);
      const instructions = generateBuildGuide(plan).steps.flatMap(step => step.details).join('\n');
      assert.match(instructions, /group 1: Place 1 × Constructor/);
      assert.match(instructions, /group 2: Place 1 × Constructor/);
      assert.match(instructions, /Leave the Somersloop slots empty/);
    }
  }
});

test('budgeted template guides count physical slots instead of fractional machine equivalents', () => {
  for (const [id, budget] of [['iron-plates', 1], ['rotors', 2], ['motors', 3], ['aluminum-sheets', 4]]) {
    const plan = solveProductionPlan(templateRequest(id, 1, { somersloopBudget: budget }));
    assert.equal(plan.status, 'optimal', `${id}: ${plan.message}`);
    let installed = 0;
    for (const row of plan.recipes) {
      const count = row.variants.reduce((sum, variant) => sum + variant.machineCount, 0);
      assert.equal(count, row.machineCount);
      const slots = row.variants.reduce((sum, variant) => sum + variant.machineCount * variant.sloops, 0);
      assert.equal(slots, row.totalSomersloops);
      installed += slots;
      for (const input of row.inputs) near(row.variants.reduce((sum, variant) => sum + rate(variant.inputs, input.itemId), 0), input.rate, `${id} variant input`);
      for (const output of row.outputs) near(row.variants.reduce((sum, variant) => sum + rate(variant.outputs, output.itemId), 0), output.rate, `${id} variant output`);
    }
    assert.ok(installed <= budget, `${id}: ${installed} > ${budget}`);
    assert.equal(plan.totals.somersloops, installed);
    const guide = generateBuildGuide(plan);
    assert.equal(guide.machines.reduce((sum, machine) => sum + machine.count, 0), plan.totals.machines);
    assert.ok(!JSON.stringify(guide).includes('undefined'));
    for (const output of factoryTemplates.find(template => template.id === id).outputs) near(rate(plan.products, output.itemId), output.rate, `${id} output`);
  }
});

test('an impossible factory gets no misleading construction instructions', () => {
  const plan = solveProductionPlan({ ...templateRequest('iron-plates'), excludedRecipes: catalog.recipes.map(recipe => recipe.id) });
  assert.notEqual(plan.status, 'optimal');
  const guide = generateBuildGuide(plan);
  assert.deepEqual(guide.steps, []);
  assert.deepEqual(guide.machines, []);
  assert.ok(guide.warnings.length > 0);
});
