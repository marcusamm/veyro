import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export * from './app/factory/manifolds.ts'; export * from './app/factory/production.ts'; export * from './app/factory/templates.ts'; export * from './app/factory/allocation.ts'; export * from './app/factory/engine.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { buildManifolds, solveProductionPlan, aggregateRecipeVariants, factoryTemplates, templateRequest, allocatePowerShards, recipeRates, catalog } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const sum = (rows, field = 'rate') => rows.reduce((total, row) => total + row[field], 0);
const near = (a, b, message = '') => assert.ok(Math.abs(a - b) <= Math.max(1e-11, Math.abs(b) * 1e-6), `${message}: ${a} != ${b}`);
const solve = request => {
  const plan = solveProductionPlan(request);
  assert.equal(plan.status, 'optimal', plan.message);
  return plan;
};

function inspect(plan, request) {
  const network = buildManifolds(plan, request);
  assert.equal(network.status, 'ready', network.message);
  assert.equal(network.componentsComplete, true);
  assert.equal(network.machines.length, plan.totals.machines);
  const machines = new Map(network.machines.map(machine => [machine.id, machine]));
  const endpoints = new Map(network.endpoints.map(endpoint => [endpoint.id, endpoint]));
  const junctions = new Map(network.junctions.map(junction => [junction.id, junction]));
  for (const array of [network.machines, network.rails, network.endpoints, network.junctions, network.connections]) {
    assert.equal(new Set(array.map(row => row.id)).size, array.length, 'stable unique IDs');
    if (array !== network.connections) assert.equal(new Set(array.map(row => row.label)).size, array.length, 'unique readable labels');
  }
  for (const machine of network.machines) {
    const expected = recipeRates(machine.recipeId, machine.clock, request.settings, machine.sloops);
    const base = recipeRates(machine.recipeId, 100, request.settings, machine.sloops);
    for (const side of ['inputs', 'outputs']) for (const row of machine[side]) {
      // The solver displays clocks rounded to four decimals while conserving exact flows.
      const clockTolerance = base[side].find(value => value.itemId === row.itemId).rate * 0.00000051 * machine.dutyCycle;
      assert.ok(Math.abs(row.rate - expected[side].find(value => value.itemId === row.itemId).rate * machine.dutyCycle) <= Math.max(1e-11, clockTolerance), `${machine.label} ${side} matches its rounded clock`);
      const branches = network.rails.filter(rail => rail.direction === (side === 'inputs' ? 'input' : 'output') && rail.itemId === row.itemId).flatMap(rail => rail.branches).filter(branch => branch.machineId === machine.id);
      assert.equal(branches.length, 1, 'each machine material port connects once');
      near(branches[0].rate, row.rate, 'machine port');
      near(branches[0].peakRate, row.rate / machine.dutyCycle, 'reserved burst rate');
    }
  }
  for (const row of plan.recipes) for (const side of ['inputs', 'outputs']) for (const port of row[side]) {
    near(sum(network.machines.filter(machine => machine.recipeId === row.recipeId).flatMap(machine => machine[side]).filter(value => value.itemId === port.itemId)), port.rate, `${row.recipeId} aggregate ${side}`);
  }
  for (const rail of network.rails) {
    near(sum(rail.branches), rail.totalRate, 'rail flow');
    near(sum(rail.branches, 'peakRate'), rail.peakRate, 'rail capacity reservation');
    assert.ok(rail.peakRate <= rail.capacity + 1e-7, 'parallel rails fit the selected tier');
    assert.equal(rail.junctions.length, Math.max(0, rail.branches.length - 1));
    assert.equal(rail.segments.length, rail.branches.length);
    assert.ok(endpoints.has(rail.endpointId));
    for (const [index, branch] of rail.branches.entries()) {
      assert.ok(machines.has(branch.machineId));
      const direct = rail.direction === 'input' ? index === rail.branches.length - 1 : index === 0;
      assert.equal(Boolean(branch.junctionId), !direct, 'one direct endpoint on a serial manifold');
      if (branch.junctionId) assert.ok(junctions.has(branch.junctionId));
      const covered = rail.direction === 'input' ? rail.branches.slice(index) : rail.branches.slice(0, index + 1);
      near(rail.segments[index].rate, sum(covered), 'progressive trunk flow');
      near(rail.segments[index].peakRate, sum(covered, 'peakRate'), 'progressive peak reservation');
      assert.ok(rail.segments[index].peakRate <= rail.capacity + 1e-7);
    }
    for (const junction of rail.junctions) {
      assert.equal(junction.scope, 'recipe');
      assert.equal(junction.railId, rail.id);
      assert.equal(junction.kind, rail.transport === 'pipe' ? 'pipe-junction' : rail.direction === 'input' ? 'splitter' : 'merger');
    }
  }
  for (const connection of network.connections) {
    assert.ok(endpoints.has(connection.from) && endpoints.has(connection.to));
    assert.equal(endpoints.get(connection.from).itemId, connection.itemId);
    assert.equal(endpoints.get(connection.to).itemId, connection.itemId);
    assert.ok(connection.rate > 0 && Number.isFinite(connection.peakRate));
    assert.ok(connection.peakRate <= connection.capacity + 1e-7);
  }
  for (const endpoint of network.endpoints) {
    const outgoing = ['supply', 'output'].includes(endpoint.kind);
    const connections = network.connections.filter(row => outgoing ? row.from === endpoint.id : row.to === endpoint.id);
    near(sum(connections), endpoint.rate, `${endpoint.label} conservation`);
    const chain = network.routingChains.find(row => row.endpointId === endpoint.id);
    assert.ok(chain);
    assert.equal(chain.direction, outgoing ? 'split' : 'merge');
    assert.equal(chain.junctions.length, connections.length - 1);
    near(sum(chain.branches), endpoint.rate);
    near(sum(chain.branches, 'peakRate'), endpoint.peakRate);
    for (const [index, segment] of chain.segments.entries()) {
      const covered = outgoing ? chain.branches.slice(index) : chain.branches.slice(0, index + 1);
      near(segment.rate, sum(covered), 'routing progressive flow');
      assert.ok(segment.peakRate <= endpoint.capacity + 1e-7);
    }
    for (const junction of chain.junctions) {
      assert.equal(junction.scope, 'routing');
      assert.equal(junction.endpointId, endpoint.id);
      assert.equal(junction.kind, endpoint.transport === 'pipe' ? 'pipe-junction' : outgoing ? 'splitter' : 'merger');
    }
  }
  const expectedRouting = network.endpoints.reduce((count, endpoint) => count + Math.max(0, network.connections.filter(row => row.from === endpoint.id || row.to === endpoint.id).length - 1), 0);
  assert.equal(network.totals.routingJunctions, expectedRouting);
  assert.equal(network.totals.recipeJunctions, network.rails.reduce((count, rail) => count + rail.branches.length - 1, 0));
  assert.equal(sum(network.components, 'count'), network.junctions.length);
  for (const component of network.components) {
    assert.equal(component.count, component.recipeCount + component.routingCount);
    assert.equal(component.count, network.junctions.filter(row => row.machineId === component.machineId).length);
  }
  for (const [kind, prefix, rows] of [['supply', 'raw:', plan.resources], ['supply', 'supplied:', plan.externalInputs], ['product', 'product:', plan.products], ['surplus', 'surplus:', plan.surplus]]) for (const row of rows) {
    near(sum(network.endpoints.filter(endpoint => endpoint.kind === kind && endpoint.id.startsWith(prefix) && endpoint.itemId === row.itemId)), row.rate, `${prefix} ${row.itemId}`);
  }
  return network;
}

test('all 14 templates preserve every physical port and endpoint through capacity-limited manifold chains', () => {
  for (const template of factoryTemplates) for (const beltTier of [1, 3]) for (const scale of [0.5, 1.25]) {
    const request = templateRequest(template, scale, { beltTier });
    inspect(solve(request), request);
  }
});

test('starter iron plates have exact serial splitter and merger counts, changing with belt capacity', () => {
  for (const [beltTier, localJunctions, splitters, mergers, rails] of [[3, 8, 4, 4, 4], [1, 5, 2, 3, 7]]) {
    const request = templateRequest('iron-plates', 1, { beltTier });
    const network = inspect(solve(request), request);
    assert.equal(network.totals.recipeJunctions, localJunctions);
    assert.equal(network.totals.routingJunctions, 0);
    assert.equal(network.totals.splitters, splitters);
    assert.equal(network.totals.mergers, mergers);
    assert.equal(network.rails.length, rails);
  }
});

test('a shared ingot supply branches between recipes and multiple sources merge into an input rail', () => {
  const request = { outputs: [{ itemId: 'Desc_IronPlate_C', rate: 20 }, { itemId: 'Desc_IronRod_C', rate: 30 }], inputs: [{ itemId: 'Desc_IronIngot_C', rate: 60 }], resourcePolicy: 'closed' };
  const network = inspect(solve(request), request);
  const supply = network.endpoints.find(row => row.kind === 'supply');
  const split = network.routingChains.find(row => row.endpointId === supply.id);
  assert.equal(split.junctions.length, 1);
  assert.equal(split.junctions[0].kind, 'splitter');
  const mixed = { outputs: [{ itemId: 'Desc_IronPlate_C', rate: 60 }], inputs: [{ itemId: 'Desc_IronIngot_C', rate: 20 }] };
  const second = inspect(solve(mixed), mixed);
  const merging = second.routingChains.find(row => row.direction === 'merge' && row.itemId === 'Desc_IronIngot_C' && row.junctions.length);
  assert.ok(merging, 'raw smelting and external ingots meet before the input manifold');
  assert.equal(merging.junctions[0].kind, 'merger');
});

test('aluminum water return is routed explicitly and counted as fluid junctions', () => {
  const request = templateRequest('aluminum-sheets');
  const plan = solve(request), network = inspect(plan, request);
  const endpoints = new Map(network.endpoints.map(row => [row.id, row]));
  const returned = network.connections.filter(row => row.itemId === 'Desc_Water_C' && endpoints.get(row.from).recipeId === 'Recipe_AluminumScrap_C' && endpoints.get(row.to).recipeId === 'Recipe_AluminaSolution_C');
  near(sum(returned), 30, 'returned water');
  near(sum(network.endpoints.filter(row => row.id.startsWith('raw:Desc_Water_C:'))), 60, 'fresh water');
  assert.ok(network.totals.pipeJunctions > 0);
  assert.ok(network.junctions.filter(row => row.kind === 'pipe-junction').every(row => row.machineId === 'Desc_PipelineJunction_Cross_C'));
  assert.ok(plan.warnings.every(warning => network.warnings.includes(warning)));
  assert.ok(network.warnings.some(warning => warning.includes('recycled-fluid priority')));
});

test('mixed amplification and globally allocated clocks retain their physical schedules', () => {
  for (const id of ['iron-plates', 'reinforced-plates', 'motors', 'aluminum-sheets']) {
    const request = templateRequest(id, 1.25, { clock: 250, beltTier: 3, somersloopBudget: 3 });
    const plan = allocatePowerShards(solve(request), request, 8).plan;
    const network = inspect(plan, request);
    assert.equal(sum(network.machines, 'sloops'), plan.totals.somersloops);
    assert.ok(sum(network.machines, 'sloops') <= 3);
  }
});

test('intermittent branches reserve running peaks rather than packing their tiny average rates together', () => {
  const recipeId = 'Recipe_Alternate_Screw_2_C';
  const request = { outputs: [{ itemId: 'Desc_IronScrew_C', rate: 0.0026 }], inputs: [{ itemId: 'Desc_SteelPlate_C', rate: 1 }], resourcePolicy: 'closed', beltTier: 1, allowedAlternates: [recipeId], excludedRecipes: catalog.recipes.filter(recipe => recipe.id !== recipeId).map(recipe => recipe.id) };
  const original = solve(request), variant = original.recipes[0].variants[0];
  const copies = 25, row = aggregateRecipeVariants(recipeId, Array.from({ length: copies }, () => structuredClone(variant)));
  const scale = rows => rows.map(value => ({ ...value, rate: value.rate * copies }));
  const plan = { ...original, recipes: [row], totals: { ...original.totals, machines: copies }, resources: scale(original.resources), externalInputs: scale(original.externalInputs), products: scale(original.products), surplus: scale(original.surplus) };
  const network = inspect(plan, request), rails = network.rails.filter(rail => rail.direction === 'output');
  assert.equal(rails.length, 2, '25 machines at 2.6/min peak need two Mk.1 belts');
  near(sum(rails, 'totalRate'), 0.065);
  near(sum(rails, 'peakRate'), 65);
  assert.ok(network.machines.every(machine => machine.dutyCycle < 0.01));
});

test('tiny valid targets retain external supply lines and every positive material connection', () => {
  const recipeId = 'Recipe_Alternate_Screw_2_C';
  const request = { outputs: [{ itemId: 'Desc_IronScrew_C', rate: 1e-6 }], inputs: [{ itemId: 'Desc_SteelPlate_C', rate: 1 }], resourcePolicy: 'closed', allowedAlternates: [recipeId], excludedRecipes: catalog.recipes.filter(recipe => recipe.id !== recipeId).map(recipe => recipe.id) };
  const network = inspect(solve(request), request);
  assert.equal(network.connections.length, 2);
  near(network.connections.find(row => row.itemId === 'Desc_SteelPlate_C').rate, 1e-6 / 52);
});

test('direct existing-supply delivery and single machines do not invent junctions', () => {
  const direct = { outputs: [{ itemId: 'Desc_IronPlate_C', rate: 60 }], inputs: [{ itemId: 'Desc_IronPlate_C', rate: 60 }], resourcePolicy: 'closed' };
  const network = inspect(solve(direct), direct);
  assert.equal(network.machines.length, 0);
  assert.equal(network.connections.length, 1);
  assert.deepEqual(network.components, []);
  const request = templateRequest('iron-plates', 1 / 3);
  const onePerStage = inspect(solve(request), request);
  assert.equal(onePerStage.machines.length, 2);
  assert.equal(onePerStage.junctions.length, 0);
});

test('large or invalid networks explicitly withhold exact junction counts', () => {
  const request = templateRequest('iron-plates', 100), plan = solve(request);
  const large = buildManifolds(plan, request);
  assert.equal(large.status, 'summary');
  assert.equal(large.componentsComplete, false);
  assert.equal(large.machines.length, 0);
  assert.deepEqual(large.components, []);
  assert.match(large.message, /counts.*unavailable/);
  const smallRequest = templateRequest('iron-plates'), small = solve(smallRequest);
  for (const broken of [
    { ...small, status: 'infeasible' },
    { ...small, totals: { ...small.totals, machines: 1 } },
    { ...small, recipes: [{ ...small.recipes[0], variants: [{ ...small.recipes[0].variants[0], machineCount: 1000000 }] }] },
  ]) {
    const value = buildManifolds(broken, smallRequest);
    assert.equal(value.status, 'invalid');
    assert.equal(value.componentsComplete, false);
    assert.deepEqual(value.junctions, []);
  }
  const highClock = templateRequest('iron-plates', 1, { clock: 250, beltTier: 3 });
  const capacityMismatch = buildManifolds(solve(highClock), { ...highClock, beltTier: 1 });
  assert.equal(capacityMismatch.status, 'invalid');
  assert.match(capacityMismatch.message, /port exceeding/);
});

test('schematic generation is deterministic and leaves the solver result unchanged', () => {
  const request = templateRequest('motors'), plan = solve(request), before = structuredClone(plan);
  assert.deepEqual(buildManifolds(plan, request), buildManifolds(plan, request));
  assert.deepEqual(plan, before);
});

test('large fractional targets under the detail limit tolerate floating point residuals', () => {
  for (const scale of [13.1234567, 22.2222222]) {
    const request = templateRequest('iron-plates', scale, { clock: 97.7777 });
    inspect(solve(request), request);
  }
});
