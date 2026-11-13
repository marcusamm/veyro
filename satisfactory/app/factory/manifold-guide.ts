import { itemById, machineById, recipeById } from './engine';
import type { buildManifolds } from './manifolds';

export type ManifoldGuideBranch = {
  machineId: string; label: string; rate: number; clock: number; sloops: number; dutyCycle: number;
};
export type ManifoldGuideRail = {
  railId: string; title: string; summary: string; steps: string[]; branches: ManifoldGuideBranch[];
};
export type ManifoldGuide = {
  ready: boolean;
  overview: string;
  counts: { machines: number; inputRails: number; outputRails: number; splitters: number; mergers: number; pipeJunctions: number } | null;
  rails: ManifoldGuideRail[];
  routing: { chainId: string; endpointId: string; title: string; steps: string[] }[];
  connections: { id: string; from: string; to: string; itemId: string; rate: number; instruction: string }[];
  startup: string[];
  warnings: string[];
};
type Model = ReturnType<typeof buildManifolds>;
const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 4 });
const fmt = (value: number) => value !== 0 && Math.abs(value) < 0.0001 ? value.toPrecision(4) : number.format(value);
const itemName = (id: string) => itemById[id]?.name || id;
const units = (id: string) => itemById[id]?.form === 'solid' ? 'items/min' : 'm³/min';
const transportName = (transport: 'belt' | 'pipe', tier: number) => `${transport === 'belt' ? 'Belt' : 'Pipe'} Mk.${tier}`;

/** Instructions for the explicit schematic, not a claim about game geometry.
 * Branch labels are steady-state demand. Ordinary splitters are not ratio valves,
 * and ordinary pipeline junctions do not enforce return-fluid priority.
 */
export function buildManifoldGuide(model: Model): ManifoldGuide {
  if (model.status !== 'ready' || !model.componentsComplete) return {
    ready: false,
    overview: model.message || 'This plan has not been expanded into individual machine manifolds.',
    counts: null, rails: [], routing: [], connections: [], startup: [],
    warnings: [...new Set([...model.warnings, 'Exact junction counts and per-machine wiring are unavailable in this summary. Split the factory into smaller modules before using a build guide.'])],
  };
  const machineMap = new Map(model.machines.map(machine => [machine.id, machine]));
  const labels = new Map<string, string>(), nextMachine = new Map<string, number>();
  for (const machine of model.machines) {
    const index = (nextMachine.get(machine.recipeId) ?? 0) + 1; nextMachine.set(machine.recipeId, index);
    labels.set(machine.id, `${machine.label} · ${recipeById[machine.recipeId]?.name || machine.recipeId} — ${machineById[machine.machineId]?.name || 'Machine'} #${index}`);
  }
  for (const endpoint of model.endpoints) labels.set(endpoint.id, endpoint.label);
  for (const junction of model.junctions) {
    const kind = junction.kind === 'splitter' ? 'Splitter' : junction.kind === 'merger' ? 'Merger' : 'Pipeline junction';
    labels.set(junction.id, `${junction.label} · ${kind} (${itemName(junction.itemId)})`);
  }
  const railNumbers = new Map<string, number>();
  const rails: ManifoldGuideRail[] = model.rails.map(rail => {
    const group = `${rail.recipeId}|${rail.itemId}|${rail.direction}`, ordinal = (railNumbers.get(group) ?? 0) + 1;
    railNumbers.set(group, ordinal);
    const pipe = rail.transport === 'pipe', isInput = rail.direction === 'input';
    const transport = transportName(rail.transport, rail.tier);
    const branches = rail.branches.map(branch => {
      const machine = machineMap.get(branch.machineId)!;
      return { machineId: machine.id, label: labels.get(machine.id)!, rate: branch.rate, clock: machine.clock, sloops: machine.sloops, dutyCycle: machine.dutyCycle };
    });
    const summary = `${fmt(rail.totalRate)} ${units(rail.itemId)} average · ${transport} capacity ${fmt(rail.capacity)} ${units(rail.itemId)}${rail.peakRate > rail.totalRate + 1e-7 ? ` · running-rate reservation ${fmt(rail.peakRate)} ${units(rail.itemId)}` : ''}.`;
    const steps: string[] = [];
    if (isInput) {
      steps.push(`Build a separate ${itemName(rail.itemId)} input ${pipe ? 'pipe' : 'belt'} for this row. Follow the inlet-to-machine direction in the drawing; keep other recipe ingredients on their own rails.`);
      for (const branch of rail.branches) {
        const machine = machineMap.get(branch.machineId)!, label = labels.get(machine.id)!;
        if (branch.junctionId) {
          const junction = labels.get(branch.junctionId) || branch.junctionId;
          steps.push(pipe
            ? `${junction}: keep the main pipe continuing along the row and connect one side branch to ${label}'s ${itemName(rail.itemId)} input. Required average flow: ${fmt(branch.rate)} ${units(rail.itemId)}. A junction does not set that flow or its priority.`
            : `${junction}: feed its input from the previous trunk segment, connect one output to ${label}'s ${itemName(rail.itemId)} input, and use one output to continue the manifold. Leave the unused output disconnected. Required average demand: ${fmt(branch.rate)} ${units(rail.itemId)}.`);
        } else steps.push(`Connect the final trunk directly to ${label}'s ${itemName(rail.itemId)} input (${fmt(branch.rate)} ${units(rail.itemId)}). Do not add an extra terminal ${pipe ? 'junction' : 'splitter'}.`);
      }
      steps.push(`Use ${transport} for the trunk and branches shown. The summed running-rate reservation is ${fmt(rail.peakRate)} ${units(rail.itemId)}; do not combine this with another parallel rail if their combined rate would exceed ${fmt(rail.capacity)}.`);
    } else {
      steps.push(`Collect only ${itemName(rail.itemId)} on this output ${pipe ? 'pipe' : 'belt'}. Follow the machine-to-outlet arrows; byproducts use their own output rails.`);
      for (const branch of rail.branches) {
        const label = labels.get(branch.machineId)!;
        steps.push(branch.junctionId
          ? `Connect ${label}'s ${itemName(rail.itemId)} output (${fmt(branch.rate)} ${units(rail.itemId)}) to ${labels.get(branch.junctionId) || branch.junctionId}; join it with the collection trunk and continue towards the rail outlet.`
          : `Connect ${label}'s ${itemName(rail.itemId)} output directly to the start of the collection trunk (${fmt(branch.rate)} ${units(rail.itemId)}). Follow the merge chain to the outlet.`);
      }
      steps.push(`Route the outlet to the named next-stage rail, requested output or surplus destination in the connection list. Keep parallel collection rails separate until a downstream line has enough capacity.`);
    }
    return { railId: rail.id, title: `${rail.label} · ${recipeById[rail.recipeId]?.name || rail.recipeId}: ${itemName(rail.itemId)} ${isInput ? 'input' : 'output'} — rail ${ordinal}`, summary, steps, branches };
  });
  const connectionMap = new Map(model.connections.map(connection => [connection.id, connection]));
  const endpointMap = new Map(model.endpoints.map(endpoint => [endpoint.id, endpoint]));
  const routing = model.routingChains.map(chain => {
    const endpoint = endpointMap.get(chain.endpointId)!;
    const split = chain.direction === 'split', pipe = endpoint.transport === 'pipe';
    const steps: string[] = [];
    const branchLabel = (connectionId: string) => {
      const connection = connectionMap.get(connectionId)!;
      const other = split ? connection.to : connection.from;
      return `${connection.id} ${split ? 'to' : 'from'} ${labels.get(other) || other}`;
    };
    if (chain.branches.length === 1) {
      const branch = chain.branches[0];
      steps.push(`Connect ${branchLabel(branch.connectionId)} directly ${split ? 'from' : 'to'} ${endpoint.label}. No routing ${pipe ? 'junction' : split ? 'splitter' : 'merger'} is needed here; the rail may still have its own machine junctions.`);
    } else if (split) {
      for (const [index, branch] of chain.branches.entries()) {
        const previous = index === 0 ? endpoint.label : labels.get(chain.junctions[index - 1].id)!;
        if (branch.junctionId) {
          const junction = labels.get(branch.junctionId)!;
          const next = index + 1 < chain.junctions.length ? labels.get(chain.junctions[index + 1].id)! : branchLabel(chain.branches[index + 1].connectionId);
          steps.push(pipe
            ? `${junction}: connect the trunk from ${previous}, one side branch ${branchLabel(branch.connectionId)} (${fmt(branch.rate)} ${units(chain.itemId)} average), and the continuation towards ${next}. Leave the remaining port unused; this junction cannot set flow priority.`
            : `${junction}: connect its input from ${previous}; connect one output ${branchLabel(branch.connectionId)} (${fmt(branch.rate)} ${units(chain.itemId)} average) and a second output towards ${next}. Leave its third output disconnected.`);
        } else steps.push(`Connect the final continuation from ${previous} directly ${branchLabel(branch.connectionId)} (${fmt(branch.rate)} ${units(chain.itemId)} average). Do not add another routing ${pipe ? 'junction' : 'splitter'}.`);
      }
    } else {
      const first = chain.branches[0];
      steps.push(`Start the collection trunk with ${branchLabel(first.connectionId)} (${fmt(first.rate)} ${units(chain.itemId)} average), leading to ${labels.get(chain.junctions[0].id)!}.`);
      for (let index = 1; index < chain.branches.length; index++) {
        const branch = chain.branches[index], junction = labels.get(branch.junctionId!)!;
        const previous = index === 1 ? branchLabel(first.connectionId) : labels.get(chain.junctions[index - 2].id)!;
        const next = index < chain.branches.length - 1 ? labels.get(chain.junctions[index].id)! : endpoint.label;
        steps.push(pipe
          ? `${junction}: join the trunk ${previous.startsWith('C') ? '' : 'from '}${previous} with ${branchLabel(branch.connectionId)} (${fmt(branch.rate)} ${units(chain.itemId)} average), then continue to ${next}. Leave the remaining port unused; verify flow direction in game.`
          : `${junction}: connect one input ${previous.startsWith('C') ? '' : 'from '}${previous}, a second input ${branchLabel(branch.connectionId)} (${fmt(branch.rate)} ${units(chain.itemId)} average), and its output to ${next}. Leave the third input disconnected.`);
      }
    }
    steps.push(`Keep this ${transportName(endpoint.transport, endpoint.tier)} chain within ${fmt(chain.capacity)} ${units(chain.itemId)}. Its required net throughput is ${fmt(chain.totalRate)} ${units(chain.itemId)}; ordinary junctions do not enforce the branch allocation.`);
    return { chainId: chain.id, endpointId: chain.endpointId, title: `${split ? 'Distribute' : 'Collect'} ${itemName(chain.itemId)} ${split ? 'from' : 'at'} ${endpoint.label}`, steps };
  });
  const connections = model.connections.map(connection => {
    const from = labels.get(connection.from) || connection.from, to = labels.get(connection.to) || connection.to;
    return { id: connection.id, from, to, itemId: connection.itemId, rate: connection.rate,
      instruction: `${from} → ${to}: ${itemName(connection.itemId)}, ${fmt(connection.rate)} ${units(connection.itemId)}, using ${transportName(connection.transport, connection.tier)}. Follow the indicated junction chain; the rate is a production requirement, not a programmable splitter setting.` };
  });
  const intermittent = model.machines.some(machine => machine.dutyCycle < 1 - 1e-8);
  const fluids = model.rails.some(rail => rail.transport === 'pipe');
  const recycle = model.warnings.some(warning => /recycl|return flow|loop/i.test(warning));
  const warnings = [...model.warnings,
    'This is a connection schematic. Junction counts describe this simple chain, not the minimum possible count or exact Satisfactory Calculator geometry.',
    'Ordinary conveyor splitters initially share available items between open outputs. The displayed branch rates are reached after the manifold buffers fill, provided every upstream supply and downstream output can sustain the plan.',
  ];
  if (fluids) warnings.push('Pipeline junctions are bidirectional. Head lift, fill state, sloshing, pump placement and fluid priority are not simulated; arrows show intended net production flow.');
  if (intermittent) warnings.push('Some machines run intermittently below the minimum continuous clock. Rails reserve running rates, but start/stop timing and buffers between stages still need to be arranged in-game.');
  if (recycle) warnings.push('Recycled fluids must keep moving. A plain pipe junction does not guarantee return-flow priority; keep the return line identifiable and control fresh supply to the stated net demand.');
  const startup = [
    'Set every machine to its listed recipe, clock and Somersloop count before enabling the row. Mixed boost groups are different physical machines.',
    'Connect and check every input ingredient and every output, including surplus and liquid byproducts. A blocked byproduct can stop the main product.',
    'Prime the input manifolds and machine buffers from the upstream end. Allow time for the last machines to fill before judging throughput; no fixed warm-up time is assumed.',
    'Start upstream stages, then enable the downstream consumers. Compare sustained input/output rates against the plan after buffers stabilize.',
  ];
  if (recycle) startup.splice(2, 0, 'Seed recycling loops with the required startup material, connect the return path, and test return flow before increasing fresh input. Do not interpret a steady-state balance as proof that an empty loop will start itself.');
  return { ready: true, overview: `Build ${model.machines.length} production machines with separate ingredient and product rails. Each local rail is a simple manifold chain with one machine branch per junction; the last input or first output machine connects directly to the trunk.`,
    counts: { machines: model.machines.length, inputRails: model.rails.filter(r => r.direction === 'input').length, outputRails: model.rails.filter(r => r.direction === 'output').length,
      splitters: model.junctions.filter(j => j.kind === 'splitter').length, mergers: model.junctions.filter(j => j.kind === 'merger').length, pipeJunctions: model.junctions.filter(j => j.kind === 'pipe-junction').length },
    rails, routing, connections, startup, warnings: [...new Set(warnings)] };
}
