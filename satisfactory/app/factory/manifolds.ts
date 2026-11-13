import { itemById, recipeById, transportCapacity } from './engine';
import type { ProductionPlan, ProductionRequest } from './production';
import type { MaterialRate } from './types';

export type ManifoldMachine = {
  id: string; label: string; recipeId: string; machineId: string; index: number; variantIndex: number;
  clock: number; sloops: number; dutyCycle: number; inputs: MaterialRate[]; outputs: MaterialRate[];
};
export type ManifoldJunction = {
  id: string; label: string; kind: 'splitter' | 'merger' | 'pipe-junction'; machineId: string;
  itemId: string; scope: 'recipe' | 'routing'; railId?: string; endpointId?: string; index: number;
};
export type ManifoldSegment = {
  id: string; from: string; to: string; rate: number; peakRate: number; capacity: number;
};
export type ManifoldBranch = {
  id: string; machineId: string; portId: string; rate: number; peakRate: number; junctionId?: string;
};
export type ManifoldRail = {
  id: string; label: string; recipeId: string; itemId: string; direction: 'input' | 'output';
  transport: 'belt' | 'pipe'; tier: number; capacity: number; totalRate: number; peakRate: number;
  endpointId: string; branches: ManifoldBranch[]; segments: ManifoldSegment[]; junctions: ManifoldJunction[];
};
export type ManifoldEndpoint = {
  id: string; label: string; itemId: string; rate: number; peakRate: number;
  kind: 'supply' | 'input' | 'output' | 'product' | 'surplus';
  recipeId?: string; railId?: string; transport: 'belt' | 'pipe'; tier: number; capacity: number;
};
export type ManifoldConnection = {
  id: string; from: string; to: string; itemId: string; rate: number; peakRate: number;
  transport: 'belt' | 'pipe'; tier: number; capacity: number;
};
export type ManifoldRoutingChain = {
  id: string; endpointId: string; direction: 'split' | 'merge'; itemId: string;
  totalRate: number; peakRate: number; capacity: number;
  branches: { connectionId: string; rate: number; peakRate: number; junctionId?: string }[];
  segments: ManifoldSegment[]; junctions: ManifoldJunction[];
};
export type ManifoldPlan = {
  status: 'ready' | 'summary' | 'invalid'; message: string; componentsComplete: boolean;
  machines: ManifoldMachine[]; rails: ManifoldRail[]; endpoints: ManifoldEndpoint[];
  connections: ManifoldConnection[]; routingChains: ManifoldRoutingChain[]; junctions: ManifoldJunction[];
  components: { machineId: string; count: number; recipeCount: number; routingCount: number }[];
  totals: { machines: number; rails: number; splitters: number; mergers: number; pipeJunctions: number; recipeJunctions: number; routingJunctions: number };
  warnings: string[];
};
const EPS = 1e-12;
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(EPS, Math.max(Math.abs(a), Math.abs(b)) * 1e-7);
const name = (itemId: string) => itemById[itemId]?.name ?? itemId;
const label = (prefix: string, index: number) => `${prefix}${String(index + 1).padStart(2, '0')}`;

function empty(status: ManifoldPlan['status'], message: string, machines = 0): ManifoldPlan {
  return { status, message, componentsComplete: false, machines: [], rails: [], endpoints: [], connections: [], routingChains: [], junctions: [], components: [], totals: { machines, rails: 0, splitters: 0, mergers: 0, pipeJunctions: 0, recipeJunctions: 0, routingJunctions: 0 }, warnings: [] };
}

/** A deterministic schematic manifold network, not measured building placement. */
export function buildManifolds(plan: ProductionPlan, request: ProductionRequest, options: { maxMachines?: number } = {}): ManifoldPlan {
  if (plan.status !== 'optimal') return empty('invalid', 'Calculate a feasible production plan before creating manifolds.');
  const maximum = options.maxMachines ?? 250;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 250) return empty('invalid', 'Manifold detail supports a limit from 1 to 250 production machines.');
  if (!Number.isInteger(plan.totals.machines) || plan.totals.machines < 0) return empty('invalid', 'The production plan has an invalid machine count.');
  if (plan.totals.machines > maximum) return empty('summary', `This plan has ${plan.totals.machines} production machines. Manifold detail supports up to ${maximum}; reduce the target or plan separate modules. Exact junction counts and their construction bill are unavailable.`, plan.totals.machines);
  try { return createManifolds(plan, request, maximum); }
  catch (error) { return empty('invalid', error instanceof Error ? error.message : 'The manifold network could not be generated.', plan.totals.machines); }
}

function createManifolds(plan: ProductionPlan, request: ProductionRequest, maximum: number): ManifoldPlan {
  const result = empty('ready', 'Manifolds generated from the calculated physical machine schedule.', plan.totals.machines);
  const transport = (itemId: string) => {
    if (!itemById[itemId]) throw new Error(`Unknown manifold material: ${itemId}.`);
    const medium = itemById[itemId].form === 'solid' ? 'belt' as const : 'pipe' as const;
    const tier = medium === 'belt' ? request.beltTier ?? 3 : request.pipeTier ?? 1;
    const capacity = transportCapacity(medium, tier);
    if (!Number.isInteger(tier) || capacity <= 0) throw new Error('Choose a valid belt and pipe tier before building manifolds.');
    return { transport: medium, tier, capacity };
  };
  const junction = (direction: 'input' | 'output', itemId: string, scope: ManifoldJunction['scope'], ownerId: string, index: number): ManifoldJunction => {
    const fluid = transport(itemId).transport === 'pipe';
    const kind = fluid ? 'pipe-junction' : direction === 'input' ? 'splitter' : 'merger';
    const value: ManifoldJunction = {
      id: `${ownerId}:junction:${index}`, label: label('J', result.junctions.length), kind,
      machineId: fluid ? 'Desc_PipelineJunction_Cross_C' : direction === 'input' ? 'Desc_ConveyorAttachmentSplitter_C' : 'Desc_ConveyorAttachmentMerger_C',
      itemId, scope, ...(scope === 'recipe' ? { railId: ownerId } : { endpointId: ownerId }), index,
    };
    result.junctions.push(value); return value;
  };
  const positiveRates = (rates: MaterialRate[], share: number): MaterialRate[] => rates.map(row => {
    const rate = row.rate * share;
    if (!Number.isFinite(rate) || rate < 0) throw new Error('A machine has an invalid material flow.');
    return { itemId: row.itemId, rate };
  }).filter(row => row.rate > EPS);

  for (const recipe of plan.recipes) {
    if (!recipeById[recipe.recipeId]) throw new Error('A production recipe is not in the game catalog.');
    let index = 0;
    for (const [variantIndex, variant] of (recipe.variants?.length ? recipe.variants : [recipe]).entries()) {
      if (!Number.isInteger(variant.machineCount) || variant.machineCount < 1 || variant.exactMachines <= 0 || !Number.isFinite(variant.exactMachines)) throw new Error('A production group has an invalid physical machine schedule.');
      if (result.machines.length + variant.machineCount > maximum) throw new Error('The physical machine schedule exceeds the manifold detail limit. Recalculate the production plan.');
      if (variant.fullMachines !== variant.machineCount - 1) throw new Error('A production group has an invalid final machine schedule.');
      for (let count = 0; count < variant.machineCount; count++) {
        const last = count >= variant.fullMachines;
        const share = last ? (variant.exactMachines - variant.fullMachines) / variant.exactMachines : 1 / variant.exactMachines;
        const dutyCycle = last ? variant.dutyCycle : 1;
        const clock = last ? variant.lastClock : variant.clock;
        if (!Number.isFinite(share) || share <= 0 || !Number.isFinite(dutyCycle) || dutyCycle <= 0 || dutyCycle > 1 || !Number.isFinite(clock) || clock < 1 || clock > 250) throw new Error('A production group has an invalid clock or duty cycle.');
        const machine: ManifoldMachine = {
          id: `machine:${recipe.recipeId}:${index}`, label: label('M', result.machines.length), recipeId: recipe.recipeId, machineId: recipe.machineId,
          index: ++index, variantIndex, clock, sloops: variant.sloops, dutyCycle,
          inputs: positiveRates(variant.inputs, share), outputs: positiveRates(variant.outputs, share),
        };
        result.machines.push(machine);
      }
    }
  }
  if (result.machines.length !== plan.totals.machines) throw new Error('The machine schedule does not match the production plan totals.');

  for (const recipe of plan.recipes) for (const direction of ['input', 'output'] as const) {
    const machines = result.machines.filter(machine => machine.recipeId === recipe.recipeId);
    const rates = direction === 'input' ? 'inputs' : 'outputs';
    const items = [...new Set(machines.flatMap(machine => machine[rates].map(row => row.itemId)))];
    for (const itemId of items) {
      const medium = transport(itemId);
      const ports = machines.flatMap(machine => {
        const row = machine[rates].find(row => row.itemId === itemId);
        if (!row) return [];
        const peakRate = row.rate / machine.dutyCycle;
        if (peakRate > medium.capacity && !close(peakRate, medium.capacity)) throw new Error(`${machine.label} has a ${name(itemId)} port exceeding the selected transport tier. Recalculate with a lower clock or higher transport capacity.`);
        return [{ id: `${machine.id}:${direction}:${itemId}`, machineId: machine.id, portId: `${direction === 'input' ? 'in' : 'out'}:${itemId}`, rate: row.rate, peakRate } satisfies ManifoldBranch];
      });
      const groups: ManifoldBranch[][] = [];
      let group: ManifoldBranch[] = [], peak = 0;
      for (const port of ports) {
        if (group.length && peak + port.peakRate > medium.capacity && !close(peak + port.peakRate, medium.capacity)) { groups.push(group); group = []; peak = 0; }
        group.push(port); peak += port.peakRate;
      }
      if (group.length) groups.push(group);
      for (const [line, branches] of groups.entries()) {
        const id = `rail:${recipe.recipeId}:${direction}:${itemId}:${line}`;
        const rail: ManifoldRail = { id, label: label('R', result.rails.length), recipeId: recipe.recipeId, itemId, direction, ...medium,
          totalRate: branches.reduce((sum, branch) => sum + branch.rate, 0), peakRate: branches.reduce((sum, branch) => sum + branch.peakRate, 0),
          endpointId: `${id}:endpoint`, branches, segments: [], junctions: [],
        };
        for (let n = 0; n < branches.length - 1; n++) rail.junctions.push(junction(direction, itemId, 'recipe', id, n));
        let cumulative = 0, cumulativePeak = 0;
        for (let n = 0; n < branches.length; n++) {
          const branch = branches[n];
          if (direction === 'input') {
            const station = n < branches.length - 1 ? rail.junctions[n].id : branch.id;
            rail.segments.push({ id: `${id}:segment:${n}`, from: n === 0 ? rail.endpointId : rail.junctions[n - 1].id, to: station, rate: Math.max(0, rail.totalRate - cumulative), peakRate: Math.max(0, rail.peakRate - cumulativePeak), capacity: medium.capacity });
            if (n < branches.length - 1) branch.junctionId = rail.junctions[n].id;
          } else {
            cumulative += branch.rate; cumulativePeak += branch.peakRate;
            if (n > 0) branch.junctionId = rail.junctions[n - 1].id;
            rail.segments.push({ id: `${id}:segment:${n}`, from: n === 0 ? branch.id : rail.junctions[n - 1].id, to: n < branches.length - 1 ? rail.junctions[n].id : rail.endpointId, rate: cumulative, peakRate: cumulativePeak, capacity: medium.capacity });
          }
          if (direction === 'input') { cumulative += branch.rate; cumulativePeak += branch.peakRate; }
        }
        result.rails.push(rail);
        result.endpoints.push({ id: rail.endpointId, label: `${rail.label} · ${recipeById[rail.recipeId].name} / ${direction} / ${name(itemId)}`, itemId, rate: rail.totalRate, peakRate: rail.peakRate, kind: direction, recipeId: recipe.recipeId, railId: id, ...medium });
      }
    }
  }

  const external = (rows: MaterialRate[], kind: 'supply' | 'product' | 'surplus', prefix: string, title: string) => {
    for (const row of rows) {
      if (!Number.isFinite(row.rate) || row.rate < 0) throw new Error('An external material flow is invalid.');
      if (row.rate <= EPS) continue;
      const medium = transport(row.itemId), count = Math.max(1, Math.ceil(row.rate / medium.capacity - 1e-10));
      // Keep a corrupted input from expanding thousands of source or sink lines.
      if (count > 1000 || result.endpoints.length + count > 5000) throw new Error('The external transport network is too large for manifold detail. Split this production target into smaller modules.');
      for (let line = 0; line < count; line++) {
        const rate = Math.min(medium.capacity, row.rate - line * medium.capacity);
        if (rate <= EPS) continue;
        result.endpoints.push({ id: `${prefix}:${row.itemId}:${line}`, label: `${title} · ${name(row.itemId)} · line ${line + 1}`, itemId: row.itemId, rate, peakRate: rate, kind, ...medium });
      }
    }
  };
  external(plan.resources, 'supply', 'raw', 'Raw supply');
  external(plan.externalInputs, 'supply', 'supplied', 'Existing supply');
  external(plan.products, 'product', 'product', 'Finished output');
  external(plan.surplus, 'surplus', 'surplus', 'Surplus output');

  const items = [...new Set(result.endpoints.map(endpoint => endpoint.itemId))];
  for (const itemId of items) {
    const producers = result.endpoints.filter(endpoint => endpoint.itemId === itemId && (endpoint.kind === 'supply' || endpoint.kind === 'output')).map(endpoint => ({ endpoint, left: endpoint.rate }));
    const consumers = result.endpoints.filter(endpoint => endpoint.itemId === itemId && endpoint.kind !== 'supply' && endpoint.kind !== 'output').map(endpoint => ({ endpoint, left: endpoint.rate }));
    for (const consumer of consumers) for (const producer of producers) {
      const rate = Math.min(producer.left, consumer.left);
      if (rate <= EPS) continue;
      const peakRate = Math.max(rate / producer.endpoint.rate * producer.endpoint.peakRate, rate / consumer.endpoint.rate * consumer.endpoint.peakRate);
      result.connections.push({ id: label('C', result.connections.length), from: producer.endpoint.id, to: consumer.endpoint.id, itemId, rate, peakRate, ...transport(itemId) });
      producer.left -= rate; consumer.left -= rate;
    }
    const unbalanced = (row: { endpoint: ManifoldEndpoint; left: number }) => Math.abs(row.left) > Math.max(EPS, row.endpoint.rate * 1e-7);
    if (producers.some(unbalanced) || consumers.some(unbalanced)) throw new Error(`The ${name(itemId)} manifold network does not balance. Recalculate the production plan.`);
  }

  for (const endpoint of result.endpoints) {
    const outgoing = endpoint.kind === 'supply' || endpoint.kind === 'output';
    const connections = result.connections.filter(connection => outgoing ? connection.from === endpoint.id : connection.to === endpoint.id);
    if (!connections.length) continue;
    const chain: ManifoldRoutingChain = { id: `routing:${endpoint.id}`, endpointId: endpoint.id, direction: outgoing ? 'split' : 'merge', itemId: endpoint.itemId, totalRate: endpoint.rate, peakRate: endpoint.peakRate, capacity: endpoint.capacity,
      branches: connections.map(connection => ({ connectionId: connection.id, rate: connection.rate, peakRate: connection.rate / endpoint.rate * endpoint.peakRate })), segments: [], junctions: [],
    };
    for (let n = 0; n < connections.length - 1; n++) chain.junctions.push(junction(outgoing ? 'input' : 'output', endpoint.itemId, 'routing', endpoint.id, n));
    let cumulative = 0, cumulativePeak = 0;
    for (const [n, branch] of chain.branches.entries()) {
      const connector = `${chain.id}:${branch.connectionId}`;
      if (outgoing) {
        const station = n < connections.length - 1 ? chain.junctions[n].id : connector;
        chain.segments.push({ id: `${chain.id}:segment:${n}`, from: n === 0 ? endpoint.id : chain.junctions[n - 1].id, to: station, rate: Math.max(0, endpoint.rate - cumulative), peakRate: Math.max(0, endpoint.peakRate - cumulativePeak), capacity: endpoint.capacity });
        if (n < connections.length - 1) branch.junctionId = chain.junctions[n].id;
        cumulative += branch.rate; cumulativePeak += branch.peakRate;
      } else {
        cumulative += branch.rate; cumulativePeak += branch.peakRate;
        if (n > 0) branch.junctionId = chain.junctions[n - 1].id;
        chain.segments.push({ id: `${chain.id}:segment:${n}`, from: n === 0 ? connector : chain.junctions[n - 1].id, to: n < connections.length - 1 ? chain.junctions[n].id : endpoint.id, rate: cumulative, peakRate: cumulativePeak, capacity: endpoint.capacity });
      }
    }
    result.routingChains.push(chain);
  }
  const components = new Map<string, ManifoldPlan['components'][number]>();
  for (const value of result.junctions) {
    const component = components.get(value.machineId) ?? { machineId: value.machineId, count: 0, recipeCount: 0, routingCount: 0 };
    component.count++; if (value.scope === 'recipe') component.recipeCount++; else component.routingCount++;
    components.set(value.machineId, component);
  }
  result.components = [...components.values()]; result.componentsComplete = true;
  result.totals = { machines: result.machines.length, rails: result.rails.length,
    splitters: result.junctions.filter(value => value.kind === 'splitter').length,
    mergers: result.junctions.filter(value => value.kind === 'merger').length,
    pipeJunctions: result.junctions.filter(value => value.kind === 'pipe-junction').length,
    recipeJunctions: result.junctions.filter(value => value.scope === 'recipe').length,
    routingJunctions: result.junctions.filter(value => value.scope === 'routing').length,
  };
  result.warnings = [
    ...plan.warnings,
    'This is a connection schematic, not measured placement. It does not determine building footprints, foundation sizes, belt lengths or pipe head lift.',
    'Ordinary splitters do not enforce the displayed demand ratios. The rates describe a filled, steady-state manifold; allow input buffers to fill before judging output.',
    'Each rail reserves capacity for all connected machines running at once, including intermittent machines. Connections show average demand; buffers and startup timing still matter.',
    'Each branching or combining chain uses one binary junction per added branch. Free splitter, merger and pipe-junction ports remain unused; exact counts are for this generated design, not a minimum-junction optimization.',
    'Fluid junctions do not enforce flow direction or recycled-fluid priority. Check the water return, fill levels and head lift in game.',
  ];
  return result;
}
