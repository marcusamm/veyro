import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export * from './app/factory/production-graph.ts'; export * from './app/factory/production.ts'; export * from './app/factory/templates.ts'; export * from './app/factory/allocation.ts'; export * from './app/factory/engine.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { productionGraph, solveProductionPlan, factoryTemplates, templateRequest, allocatePowerShards, recipeRates, catalog } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1e-5 * Math.max(1, Math.abs(expected)), `${label}: ${actual} != ${expected}`);
const total = (edges, id, side, itemId) => edges.filter(edge => edge[side] === id && edge.itemId === itemId).reduce((sum, edge) => sum + edge.rate, 0);
function solve(request) {
  const plan = solveProductionPlan(request);
  assert.equal(plan.status, 'optimal', plan.message);
  return plan;
}
function assertGraphMatchesPlan(plan, mode = 'groups') {
  const graph = productionGraph(plan, mode);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  assert.equal(nodes.size, graph.nodes.length, 'unique node IDs');
  assert.equal(new Set(graph.edges.map(edge => edge.id)).size, graph.edges.length, 'unique edge IDs');
  assert.ok(Number.isFinite(graph.width) && graph.width > 0);
  assert.ok(Number.isFinite(graph.height) && graph.height > 0);
  for (const node of graph.nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `finite position ${node.id}`);
    assert.ok(node.x >= 0 && node.y >= 0, `nonnegative position ${node.id}`);
    assert.ok(node.x + 220 <= graph.width && node.y + 85 <= graph.height, `visible node ${node.id}`);
    assert.ok(node.title && node.subtitle, `visible label ${node.id}`);
    for (const other of graph.nodes) if (other.id !== node.id) {
      assert.ok(node.x + 220 <= other.x || other.x + 220 <= node.x || node.y + 85 <= other.y || other.y + 85 <= node.y, `overlapping boxes ${node.id}, ${other.id}`);
    }
  }
  for (const edge of graph.edges) {
    assert.ok(nodes.has(edge.from) && nodes.has(edge.to), `valid endpoints ${edge.id}`);
    assert.ok(Number.isFinite(edge.rate) && edge.rate > 0, `positive finite flow ${edge.id}`);
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    assert.ok(from.kind === 'supply' || from.kind === 'recipe', `producer kind ${edge.id}`);
    assert.ok(to.kind === 'recipe' || to.kind === 'product' || to.kind === 'surplus', `consumer kind ${edge.id}`);
  }
  for (const [prefix, rows] of [['raw', plan.resources], ['input', plan.externalInputs]]) for (const row of rows) {
    const id = `${prefix}:${row.itemId}`;
    assert.equal(nodes.get(id)?.kind, 'supply');
    near(total(graph.edges, id, 'from', row.itemId), row.rate, `${id} supply`);
    assert.equal(graph.edges.filter(edge => edge.to === id).length, 0, `${id} cannot consume`);
  }
  for (const row of plan.recipes) {
    const recipeNodes = graph.nodes.filter(node => node.recipeId === row.recipeId), ids = new Set(recipeNodes.map(node => node.id));
    assert.equal(recipeNodes.length, graph.individual ? row.machineCount : 1, `${row.recipeId} physical node count`);
    const incoming = graph.edges.filter(edge => ids.has(edge.to)), outgoing = graph.edges.filter(edge => ids.has(edge.from));
    for (const input of row.inputs) near(incoming.filter(edge => edge.itemId === input.itemId).reduce((sum, edge) => sum + edge.rate, 0), input.rate, `${row.recipeId} input ${input.itemId}`);
    for (const output of row.outputs) near(outgoing.filter(edge => edge.itemId === output.itemId).reduce((sum, edge) => sum + edge.rate, 0), output.rate, `${row.recipeId} output ${output.itemId}`);
    for (const edge of incoming) assert.ok(row.inputs.some(input => input.itemId === edge.itemId), `${row.recipeId} accepts only recipe inputs`);
    for (const edge of outgoing) assert.ok(row.outputs.some(output => output.itemId === edge.itemId), `${row.recipeId} supplies only recipe outputs`);
  }
  for (const [kind, rows] of [['product', plan.products], ['surplus', plan.surplus]]) for (const row of rows) {
    if (row.rate < 1e-7) continue;
    const id = `${kind}:${row.itemId}`;
    assert.equal(nodes.get(id)?.kind, kind);
    near(total(graph.edges, id, 'to', row.itemId), row.rate, `${id} delivery`);
    assert.equal(graph.edges.filter(edge => edge.from === id).length, 0, `${id} cannot supply`);
  }
  for (const balance of plan.balances) {
    const itemFlow = graph.edges.filter(edge => edge.itemId === balance.itemId).reduce((sum, edge) => sum + edge.rate, 0);
    near(itemFlow, balance.produced + balance.external, `${balance.itemId} total graph supply`);
    near(itemFlow, balance.consumed + balance.requested + balance.surplus, `${balance.itemId} total graph demand`);
  }
  return graph;
}

test('all template graphs conserve every recipe input and output at three scales', () => {
  for (const template of factoryTemplates) for (const scale of [0.5, 1, 3.25]) {
    const plan = solve(templateRequest(template, scale));
    assertGraphMatchesPlan(plan);
  }
});

test('aluminum graph retains both directions of the recovered-water loop', () => {
  const graph = assertGraphMatchesPlan(solve(templateRequest('aluminum-sheets')));
  const alumina = graph.nodes.find(node => node.recipeId === 'Recipe_AluminaSolution_C');
  const scrap = graph.nodes.find(node => node.recipeId === 'Recipe_AluminumScrap_C');
  assert.ok(alumina && scrap);
  const solution = graph.edges.find(edge => edge.from === alumina.id && edge.to === scrap.id && edge.itemId === 'Desc_AluminaSolution_C');
  const recoveredWater = graph.edges.find(edge => edge.from === scrap.id && edge.to === alumina.id && edge.itemId === 'Desc_Water_C');
  assert.ok(solution && recoveredWater, 'both recycling edges must be represented');
  near(solution.rate, 60, 'alumina solution');
  near(recoveredWater.rate, 30, 'returned water');
  assert.equal(alumina.x, scrap.x, 'recycling group shares one stage');
  assert.notEqual(alumina.y, scrap.y, 'recycling machines remain separate visible boxes');
  near(total(graph.edges, 'raw:Desc_Water_C', 'from', 'Desc_Water_C'), 60, 'fresh water');
});

test('surplus fluid has a visible destination instead of disappearing from the graph', () => {
  const request = templateRequest('plastic-rubber');
  request.outputs = [{ itemId: 'Desc_Plastic_C', rate: 40 }];
  const graph = assertGraphMatchesPlan(solve(request));
  assert.equal(graph.nodes.find(node => node.id === 'surplus:Desc_HeavyOilResidue_C')?.kind, 'surplus');
  near(total(graph.edges, 'surplus:Desc_HeavyOilResidue_C', 'to', 'Desc_HeavyOilResidue_C'), 20, 'residue exit');
});

test('existing supplied items connect directly to targets or to their consuming recipes', () => {
  const passThrough = solve({ outputs: [{ itemId: 'Desc_IronPlate_C', rate: 60 }], inputs: [{ itemId: 'Desc_IronPlate_C', rate: 60 }], resourcePolicy: 'closed' });
  const direct = assertGraphMatchesPlan(passThrough);
  assert.equal(passThrough.recipes.length, 0);
  assert.ok(direct.edges.some(edge => edge.from === 'input:Desc_IronPlate_C' && edge.to === 'product:Desc_IronPlate_C' && edge.rate === 60));
  const shared = solve({ outputs: [{ itemId: 'Desc_IronPlate_C', rate: 20 }, { itemId: 'Desc_IronRod_C', rate: 30 }], inputs: [{ itemId: 'Desc_IronIngot_C', rate: 60 }], resourcePolicy: 'closed' });
  const graph = assertGraphMatchesPlan(shared);
  assert.equal(graph.edges.filter(edge => edge.from === 'input:Desc_IronIngot_C').length, 2, 'the input must feed both production branches');
});

test('overclock and Somersloop graphs use actual boosted rates, without fabricated material', () => {
  assertGraphMatchesPlan(solve(templateRequest('reinforced-plates', 1.75, {
    clock: 250, beltTier: 1,
    sloops: { Recipe_IronPlateReinforced_C: 2, Recipe_IronPlate_C: 1, Recipe_Screw_C: 1 },
  })));
});

test('individual-machine graphs match each clock and Somersloop group after global shard allocation', () => {
  for (const [id, scale, sloops, shards] of [['iron-plates', 1.25, 0, 1], ['rotors', 1, 2, 4], ['motors', 1, 3, 5], ['aluminum-sheets', 1, 4, 3]]) {
    const request = templateRequest(id, scale, { clock: 250, somersloopBudget: sloops, powerShardBudget: shards });
    const solved = solve(request), plan = allocatePowerShards(solved, request, shards, { clock: 250 }).plan;
    const graph = assertGraphMatchesPlan(plan, 'machines');
    assert.equal(graph.individual, true);
    for (const row of plan.recipes) {
      let index = 0;
      for (const variant of row.variants) for (let machine = 0; machine < variant.machineCount; machine++) {
        const id = `recipe:${row.recipeId}:${index++}`;
        const last = machine === variant.machineCount - 1;
        const rates = recipeRates(row.recipeId, last ? variant.lastClock : variant.clock, request.settings, variant.sloops);
        const duty = last ? variant.dutyCycle : 1;
        for (const input of rates.inputs) near(total(graph.edges, id, 'to', input.itemId), input.rate * duty, `${id} physical input`);
        for (const output of rates.outputs) near(total(graph.edges, id, 'from', output.itemId), output.rate * duty, `${id} physical output`);
      }
    }
  }
});

test('large individual-machine requests fall back to conserved grouped flows', () => {
  const plan = solve(templateRequest('iron-plates', 100));
  assert.ok(plan.totals.machines > 250);
  const graph = assertGraphMatchesPlan(plan, 'machines');
  assert.equal(graph.individual, false);
  assert.equal(graph.limited, true);
  assert.equal(graph.nodes.filter(node => node.kind === 'recipe').length, plan.recipes.length);
});

test('tiny supported targets keep their small ingredient edges and state intermittent duty', () => {
  const recipeId = 'Recipe_Alternate_Screw_2_C';
  const plan = solve({ outputs: [{ itemId: 'Desc_IronScrew_C', rate: 0.000001 }], inputs: [{ itemId: 'Desc_SteelPlate_C', rate: 1 }], resourcePolicy: 'closed', allowedAlternates: [recipeId], excludedRecipes: catalog.recipes.filter(recipe => recipe.id !== recipeId).map(recipe => recipe.id) });
  const graph = productionGraph(plan, 'machines');
  const ingredient = graph.edges.find(edge => edge.itemId === 'Desc_SteelPlate_C');
  assert.ok(ingredient, 'a positive ingredient must not disappear under a display cutoff');
  assert.ok(Math.abs(ingredient.rate - 1e-6 / 52) < 1e-12);
  assert.match(graph.nodes.find(node => node.recipeId === recipeId).subtitle, /0\.00003846% duty/);
  assert.ok(graph.edges.some(edge => edge.itemId === 'Desc_IronScrew_C' && edge.rate === 1e-6));
});

test('graph construction is deterministic and leaves the calculation unchanged', () => {
  const plan = solve(templateRequest('motors'));
  const before = structuredClone(plan), first = productionGraph(plan), second = productionGraph(plan);
  assert.deepEqual(first, second);
  assert.deepEqual(plan, before);
});

test('infeasible plans still produce a finite empty graphic', () => {
  const plan = solveProductionPlan({ outputs: [{ itemId: 'Desc_IronPlate_C', rate: 60 }], resourcePolicy: 'closed' });
  assert.equal(plan.status, 'infeasible');
  const graph = productionGraph(plan);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.ok(Number.isFinite(graph.width) && graph.width > 0);
  assert.ok(Number.isFinite(graph.height) && graph.height > 0);
});
