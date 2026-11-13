import type { ProductionPlan } from './production';
import { itemById, recipeById, machineById } from './engine';

export type FlowNode = { id: string; title: string; subtitle: string; kind: 'supply' | 'recipe' | 'product' | 'surplus'; x: number; y: number; recipeId?: string };
export type FlowEdge = { id: string; from: string; to: string; itemId: string; rate: number };
const FLOW_EPSILON = 1e-12;
export function productionGraph(plan: ProductionPlan, mode: 'groups' | 'machines' = 'groups') {
  const nodes: FlowNode[] = [], edges: FlowEdge[] = [];
  const individual = mode === 'machines' && plan.totals.machines <= 250;
  const producers = new Map<string, { id: string; left: number }[]>(), consumers = new Map<string, { id: string; left: number }[]>();
  const addRate = (map: typeof producers, itemId: string, id: string, rate: number) => { const list = map.get(itemId) || []; list.push({ id, left: rate }); map.set(itemId, list); };
  const add = (id: string, title: string, subtitle: string, kind: FlowNode['kind'], recipeId?: string) => nodes.push({ id, title, subtitle, kind, recipeId, x: 0, y: 0 });
  [...plan.resources.map(r => ({ ...r, prefix: 'raw', label: 'Raw resource' })), ...plan.externalInputs.map(r => ({ ...r, prefix: 'input', label: 'Supplied input' }))].forEach(r => {
    const id = `${r.prefix}:${r.itemId}`; add(id, itemById[r.itemId]?.name || r.itemId, r.label, 'supply'); addRate(producers, r.itemId, id, r.rate);
  });
  plan.recipes.forEach(r => {
    if (!individual) {
      const id = `recipe:${r.recipeId}`;
      add(id, recipeById[r.recipeId]?.name || r.recipeId, `${r.machineCount} × ${machineById[r.machineId]?.name || 'machine'}`, 'recipe', r.recipeId);
      r.outputs.forEach(v => addRate(producers, v.itemId, id, v.rate));
      r.inputs.forEach(v => addRate(consumers, v.itemId, id, v.rate));
      return;
    }
    let index = 0;
    for (const variant of r.variants || [r]) for (let n = 0; n < variant.machineCount; n++) {
      const id = `recipe:${r.recipeId}:${index++}`;
      const fraction = n < variant.fullMachines ? 1 / variant.exactMachines : (variant.exactMachines - variant.fullMachines) / variant.exactMachines;
      const clock = n < variant.fullMachines ? variant.clock : variant.lastClock;
      const duty = n >= variant.fullMachines && variant.dutyCycle < 1 - FLOW_EPSILON ? ` · ${Number((variant.dutyCycle * 100).toPrecision(4))}% duty` : '';
      add(id, `${recipeById[r.recipeId]?.name || r.recipeId} #${index}`, `${Number(clock.toFixed(4))}% · ${variant.sloops} Somersloops${duty}`, 'recipe', r.recipeId);
      variant.outputs.forEach(v => addRate(producers, v.itemId, id, v.rate * fraction));
      variant.inputs.forEach(v => addRate(consumers, v.itemId, id, v.rate * fraction));
    }
  });
  [...plan.products.map(r => ({ ...r, kind: 'product' as const })), ...plan.surplus.map(r => ({ ...r, kind: 'surplus' as const }))].forEach(r => {
    if (r.rate <= FLOW_EPSILON) return;
    const id = `${r.kind}:${r.itemId}`; add(id, itemById[r.itemId]?.name || r.itemId, r.kind === 'product' ? 'Requested output' : 'Surplus / by-product', r.kind); addRate(consumers, r.itemId, id, r.rate);
  });
  for (const [itemId, supply] of producers) for (const demand of consumers.get(itemId) || []) for (const producer of supply) {
    const rate = Math.min(producer.left, demand.left);
    if (rate > FLOW_EPSILON) { edges.push({ id: `flow-${edges.length}`, from: producer.id, to: demand.id, itemId, rate }); producer.left -= rate; demand.left -= rate; }
  }
  // Collapse strongly connected recipe groups before laying out the DAG. Recycling
  // links remain visible instead of being dropped or expanded indefinitely.
  const adjacency = new Map(nodes.map(n => [n.id, edges.filter(e => e.from === n.id).map(e => e.to)]));
  const indices = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], active = new Set<string>(), groups: string[][] = [];
  function visit(id: string) {
    indices.set(id, indices.size); low.set(id, indices.get(id)!); stack.push(id); active.add(id);
    for (const next of adjacency.get(id) || []) {
      if (!indices.has(next)) { visit(next); low.set(id, Math.min(low.get(id)!, low.get(next)!)); }
      else if (active.has(next)) low.set(id, Math.min(low.get(id)!, indices.get(next)!));
    }
    if (low.get(id) === indices.get(id)) { const group: string[] = []; let next: string; do { next = stack.pop()!; active.delete(next); group.push(next); } while (next !== id); groups.push(group); }
  }
  nodes.forEach(n => { if (!indices.has(n.id)) visit(n.id); });
  const groupOf = new Map(groups.flatMap((g, i) => g.map(id => [id, i] as const))), levels = groups.map(() => 0);
  for (let pass = 0; pass < groups.length; pass++) { let changed = false; for (const e of edges) { const a = groupOf.get(e.from)!, b = groupOf.get(e.to)!; if (a !== b && levels[b] < levels[a] + 1) { levels[b] = levels[a] + 1; changed = true; } } if (!changed) break; }
  const columns = new Map<number, FlowNode[]>();
  nodes.forEach(n => { const level = levels[groupOf.get(n.id)!]; const column = columns.get(level) || []; column.push(n); columns.set(level, column); });
  const height = Math.max(340, ...[...columns.values()].map(c => c.length * 142 + 80));
  for (const [column, values] of columns) values.forEach((n, index) => { n.x = 35 + column * 310; n.y = 35 + index * 142 + (height - 80 - values.length * 142) / 2; });
  return { nodes, edges, individual, limited: mode === 'machines' && !individual, width: Math.max(900, (Math.max(0, ...levels) + 1) * 310 + 40), height };
}
