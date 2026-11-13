import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ stdin: { contents: "export {solveProductionPlan} from './app/factory/production'; export {productionGraph} from './app/factory/production-graph'; export {factoryTemplates,templateRequest} from './app/factory/templates';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { solveProductionPlan, productionGraph, factoryTemplates, templateRequest } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} differs from ${b}`);

test('individual diagrams show every physical machine and preserve all recipe-group rates', () => {
  for (const template of factoryTemplates) {
    const plan = solveProductionPlan(templateRequest(template, .5));
    assert.equal(plan.status, 'optimal', template.id);
    const graph = productionGraph(plan, 'machines');
    assert.equal(graph.individual, true);
    assert.equal(graph.nodes.filter(n => n.kind === 'recipe').length, plan.totals.machines);
    for (const recipe of plan.recipes) {
      const ids = new Set(graph.nodes.filter(n => n.recipeId === recipe.recipeId).map(n => n.id));
      for (const row of recipe.inputs) near(graph.edges.filter(e => ids.has(e.to) && e.itemId === row.itemId).reduce((s, e) => s + e.rate, 0), row.rate);
      for (const row of recipe.outputs) near(graph.edges.filter(e => ids.has(e.from) && e.itemId === row.itemId).reduce((s, e) => s + e.rate, 0), row.rate);
    }
    assert.equal(new Set(graph.nodes.map(n => n.id)).size, graph.nodes.length);
  }
});

test('large individual diagrams fall back explicitly without dropping production', () => {
  const plan = solveProductionPlan(templateRequest('iron-plates', 100));
  assert.ok(plan.totals.machines > 250);
  const graph = productionGraph(plan, 'machines');
  assert.equal(graph.limited, true);
  assert.equal(graph.individual, false);
  assert.equal(graph.nodes.filter(n => n.kind === 'recipe').length, plan.recipes.length);
});
