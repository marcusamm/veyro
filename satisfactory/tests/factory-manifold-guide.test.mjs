import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export * from './app/factory/manifold-guide.ts'; export * from './app/factory/manifolds.ts'; export * from './app/factory/production.ts'; export * from './app/factory/templates.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { buildManifoldGuide, buildManifolds, solveProductionPlan, templateRequest, factoryTemplates } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const fixture = (id, scale = 1, overrides = {}) => {
  const request = templateRequest(id, scale, overrides), plan = solveProductionPlan(request);
  assert.equal(plan.status, 'optimal', plan.message);
  const model = buildManifolds(plan, request), guide = buildManifoldGuide(model);
  assert.equal(model.status, 'ready', model.message);
  assert.equal(guide.ready, true);
  return { request, plan, model, guide };
};

test('plate guide names every physical machine, rail and junction exactly as the schematic', () => {
  const { model, guide } = fixture('iron-plates');
  assert.deepEqual(guide.counts, { machines: 6, inputRails: 2, outputRails: 2, splitters: 4, mergers: 4, pipeJunctions: 0 });
  for (const rail of model.rails) {
    const instructions = guide.rails.find(row => row.railId === rail.id);
    assert.match(instructions.title, new RegExp(`^${rail.label} ·`));
    assert.equal(instructions.branches.length, rail.branches.length);
    assert.equal(rail.junctions.length, rail.branches.length - 1);
    for (const branch of rail.branches) {
      const machine = model.machines.find(row => row.id === branch.machineId);
      const text = instructions.branches.find(row => row.machineId === machine.id);
      assert.match(text.label, new RegExp(`^${machine.label} ·`));
      near(text.rate, branch.rate);
      if (branch.junctionId) assert.ok(instructions.steps.some(text => text.includes(model.junctions.find(row => row.id === branch.junctionId).label)));
    }
    assert.ok(instructions.steps.some(text => /final trunk directly|directly to the start/.test(text)));
  }
});

test('mixed boosted and plain machines retain their own demand and Somersloop schedule', () => {
  const { model, guide } = fixture('iron-plates', 1, { somersloopBudget: 1 });
  const constructors = model.machines.filter(machine => machine.recipeId === 'Recipe_IronPlate_C');
  assert.deepEqual(constructors.map(machine => machine.sloops).sort(), [0, 1]);
  const output = guide.rails.filter(rail => model.rails.find(row => row.id === rail.railId).recipeId === 'Recipe_IronPlate_C' && model.rails.find(row => row.id === rail.railId).direction === 'output').flatMap(rail => rail.branches);
  const sortedRates = output.map(row => row.rate).sort((a, b) => a - b);
  near(sortedRates[0], 20); near(sortedRates[1], 40);
  assert.deepEqual(output.map(row => row.sloops).sort(), [0, 1]);
  assert.ok(guide.startup.some(text => text.includes('Mixed boost groups')));
});

test('routing instructions describe every splitter branch and terminal continuation', () => {
  const { model, guide } = fixture('rotors');
  const chains = model.routingChains.filter(chain => chain.direction === 'split' && chain.branches.length > 1);
  assert.ok(chains.length > 0);
  for (const chain of chains) {
    const instructions = guide.routing.find(row => row.chainId === chain.id);
    assert.ok(instructions);
    for (const branch of chain.branches) assert.ok(instructions.steps.some(text => text.includes(branch.connectionId)));
    for (const junction of chain.junctions) assert.ok(instructions.steps.some(text => text.includes(junction.label)));
    assert.ok(instructions.steps.some(text => text.includes('third output disconnected')));
    assert.ok(instructions.steps.some(text => text.includes('Do not add another routing splitter')));
  }
});

test('routing instructions merge separate sources into one ingredient rail', () => {
  const { model, guide } = fixture('screws', 1, { inputs: [{ itemId: 'Desc_IronIngot_C', rate: 15 }], capInputs: false });
  const chains = model.routingChains.filter(chain => chain.direction === 'merge' && chain.branches.length > 1);
  assert.ok(chains.length > 0);
  for (const chain of chains) {
    const instructions = guide.routing.find(row => row.chainId === chain.id);
    for (const branch of chain.branches) assert.ok(instructions.steps.some(text => text.includes(branch.connectionId)));
    assert.ok(instructions.steps.some(text => text.includes('Start the collection trunk')));
    assert.ok(instructions.steps.some(text => text.includes('third input disconnected')));
    assert.ok(instructions.steps.some(text => text.includes(model.endpoints.find(row => row.id === chain.endpointId).label)));
  }
});

test('fluid loop guide retains net supplies, startup and return-priority limitations', () => {
  const { model, guide } = fixture('aluminum-sheets');
  const water = model.endpoints.filter(row => row.kind === 'supply' && row.itemId === 'Desc_Water_C').reduce((sum, row) => sum + row.rate, 0);
  near(water, 60);
  assert.ok(guide.warnings.some(text => text.includes('return-flow priority')));
  assert.ok(guide.startup.some(text => text.includes('Seed recycling loops')));
  assert.ok(guide.warnings.some(text => text.includes('Head lift')));
  const liquidRails = model.rails.filter(rail => rail.transport === 'pipe');
  assert.ok(liquidRails.length > 0);
  for (const rail of liquidRails) assert.match(guide.rails.find(row => row.railId === rail.id).summary, /Pipe Mk\.1/);
});

test('loop advice follows actual connections, not generic fluid or Somersloop warnings', () => {
  for (const [id, overrides] of [['iron-plates', {}], ['iron-plates', { somersloopBudget: 1 }], ['plastic-rubber', {}]]) {
    const { guide } = fixture(id, 1, overrides);
    assert.equal(guide.startup.some(text => text.includes('Seed recycling loops')), false, id);
    assert.equal(guide.warnings.some(text => text.includes('Recycled fluids must keep moving')), false, id);
  }
  const { model } = fixture('aluminum-sheets');
  const guide = buildManifoldGuide({ ...model, warnings: [] });
  assert.ok(guide.startup.some(text => text.includes('Seed recycling loops')));
  assert.ok(guide.warnings.some(text => text.includes('return-flow priority')));
});

test('large factory summary has no invented exact junction counts or instructions', () => {
  const request = templateRequest('iron-plates', 100), plan = solveProductionPlan(request);
  assert.equal(plan.status, 'optimal', plan.message);
  const model = buildManifolds(plan, request), guide = buildManifoldGuide(model);
  assert.equal(model.status, 'summary');
  assert.equal(guide.ready, false);
  assert.equal(guide.counts, null);
  assert.deepEqual(guide.rails, []);
  assert.deepEqual(guide.routing, []);
  assert.deepEqual(guide.connections, []);
  assert.match(guide.warnings.join('\n'), /Exact junction counts/);
});

test('tiny intermittent rates stay positive in labels and reserve running-rate capacity', () => {
  const { model, guide } = fixture('iron-plates', 1e-7);
  const input = guide.rails.find(row => model.rails.find(rail => rail.id === row.railId).direction === 'input');
  near(Number(input.summary.split(' ')[0]), 0.000009);
  assert.ok(Number(input.summary.split(' ')[0]) > 0);
  assert.match(input.summary, /running-rate reservation/);
  assert.ok(guide.warnings.some(text => text.includes('intermittently')));
  for (const rail of model.rails) {
    assert.ok(rail.peakRate <= rail.capacity + 1e-7);
    assert.ok(rail.peakRate > rail.totalRate);
    for (const branch of rail.branches) {
      const machine = model.machines.find(row => row.id === branch.machineId);
      near(branch.peakRate, branch.rate / machine.dutyCycle);
    }
  }
});

test('all template guides cover each rail and route without mutation or unresolved IDs', () => {
  for (const template of factoryTemplates) {
    const { model } = fixture(template.id), before = JSON.stringify(model), guide = buildManifoldGuide(model);
    assert.equal(JSON.stringify(model), before);
    assert.equal(guide.rails.length, model.rails.length);
    assert.equal(guide.routing.length, model.routingChains.length);
    assert.equal(guide.connections.length, model.connections.length);
    for (const connection of guide.connections) {
      assert.equal(connection.from, model.endpoints.find(row => row.id === model.connections.find(row => row.id === connection.id).from).label);
      assert.equal(connection.to, model.endpoints.find(row => row.id === model.connections.find(row => row.id === connection.id).to).label);
    }
    const text = [...guide.rails.flatMap(rail => [rail.title, rail.summary, ...rail.steps]), ...guide.routing.flatMap(chain => [chain.title, ...chain.steps]), ...guide.connections.map(connection => connection.instruction)].join('\n');
    assert.doesNotMatch(text, /undefined|NaN|rail:Recipe_|machine:Recipe_|:junction:/, template.id);
  }
});

