import gameData from './data/satisfactory-1.2.json';
import { itemById, recipeRates, transportCapacity } from './engine';
import { aggregateRecipeVariants, type ProductionPlan, type ProductionRequest, type ProductionVariant } from './production';
import { extractionFromRows, planExtraction, type ExtractionOptions, type ExtractionPlan, type ExtractionRow } from './construction';

type ClockGroup = { count: number; clock: number; dutyCycle: number; shardsPerMachine: number };
type Group = { work: number; cap: number; count: number; shards: number; extractor: boolean; amplified: boolean; clockLimited?: boolean; recipeId?: string; variant?: ProductionVariant; extractionRow?: ExtractionRow };
export type ShardAllocation = { plan: ProductionPlan; extraction: ExtractionPlan; shardsUsed: number; shardsUnused: number };
const EPS = 1e-9;
const shardCount = (clock: number) => Math.max(0, Math.ceil((clock - 100) / 50 - EPS));

// Full 50-point steps are useful before a final transport-limited partial step.
function requiredShards(work: number, count: number, cap: number): number {
  if (count < 1 || count * cap / 100 < work - EPS) return Infinity;
  const extra = (work - count) * 100;
  if (extra <= EPS) return 0;
  const steps = Math.floor((cap - 100) / 50 + EPS), wholeCapacity = steps * 50 * count;
  if (extra <= wholeCapacity + EPS) return Math.ceil(extra / 50 - EPS);
  const partial = cap - 100 - steps * 50;
  return partial > EPS ? steps * count + Math.ceil((extra - wholeCapacity) / partial - EPS) : Infinity;
}

/** Compact runs avoid creating millions of individual buildings for a large target. */
function clockGroups(group: Group): ClockGroup[] {
  const runs: ClockGroup[] = [];
  const add = (count: number, effectiveClock: number) => {
    if (count <= 0 || effectiveClock <= 0) return;
    const clock = Math.max(1, effectiveClock), dutyCycle = Math.min(1, effectiveClock);
    runs.push({ count, clock, dutyCycle, shardsPerMachine: shardCount(clock) });
  };
  if (group.shards === 0) {
    const cap = Math.min(100, group.cap), full = group.count - 1;
    add(full, cap); add(1, Math.min(cap, Math.max(0, group.work * 100 - full * cap)));
    return runs;
  }
  const extra = (group.work - group.count) * 100, wholeStep = Math.floor((group.cap - 100) / 50 + EPS) * 50;
  let floorClock = 100, capacity = wholeStep, extraToPlace = extra;
  if (extra > wholeStep * group.count + EPS) {
    floorClock += wholeStep; extraToPlace -= wholeStep * group.count; capacity = group.cap - floorClock;
  }
  const full = Math.min(group.count, Math.floor(extraToPlace / capacity + EPS));
  add(full, floorClock + capacity);
  const remainder = Math.max(0, extraToPlace - full * capacity), partial = remainder > EPS ? 1 : 0;
  if (partial) add(1, floorClock + remainder);
  add(group.count - full - partial, floorClock);
  return runs;
}

/** SC-style greedy physical allocation: remove one building at the lowest extra shard cost.
 * Extraction wins equal-cost ties. Somersloop-amplified groups stay at or below 100%.
 * Material flows and the selected recipes are preserved; this does not rerun the LP.
 */
export function allocatePowerShards(plan: ProductionPlan, request: ProductionRequest, budget: number, extractionOptions: ExtractionOptions = {}): ShardAllocation {
  if (!Number.isInteger(budget) || budget < 0 || budget > 10000) throw new Error('Power Shard budget must be a whole number from 0 to 10,000.');
  const extraction = planExtraction(plan, request, extractionOptions);
  if (plan.status !== 'optimal') return { plan, extraction, shardsUsed: 0, shardsUnused: budget };
  const groups: Group[] = [];
  for (const recipe of plan.recipes) for (const variant of recipe.variants) {
    const unit = recipeRates(recipe.recipeId, 100, request.settings, variant.sloops);
    const main = unit.outputs[0], output = variant.outputs.find(row => row.itemId === main.itemId);
    if (!output || main.rate <= 0) throw new Error('A production variant has no calculable output.');
    const work = output.rate / main.rate;
    const requestedClock = request.recipeClocks?.[recipe.recipeId] ?? request.clock ?? 100;
    let portCap = 250;
    for (const port of [...unit.inputs, ...unit.outputs]) {
      const solid = itemById[port.itemId].form === 'solid';
      const capacity = transportCapacity(solid ? 'belt' : 'pipe', solid ? request.beltTier ?? 3 : request.pipeTier ?? 1);
      if (capacity <= 0) throw new Error('Unknown transport tier for Power Shard allocation.');
      portCap = Math.min(portCap, capacity / port.rate * 100);
    }
    const cap = Math.min(requestedClock, portCap, variant.sloops > 0 ? 100 : 250);
    groups.push({ work, cap, count: Math.max(1, Math.ceil(work / (Math.min(100, cap) / 100) - EPS)), shards: 0, extractor: false, amplified: variant.sloops > 0, clockLimited: portCap < requestedClock - 1e-6, recipeId: recipe.recipeId, variant });
  }
  for (const row of extraction.rows) if (row.supported) {
    const definition = gameData.extractors.find(extractor => extractor.id === row.machineId)!;
    const baseRate = definition.baseRate * (row.purity ? definition.purityMultipliers[row.purity] : 1), work = row.rate / baseRate;
    groups.push({ work, cap: row.clock, count: Math.max(1, Math.ceil(work / (Math.min(100, row.clock) / 100) - EPS)), shards: 0, extractor: true, amplified: false, extractionRow: row });
  }
  let remaining = budget;
  while (remaining > 0) {
    let choice: { group: Group; shards: number; cost: number } | undefined;
    for (const group of groups) {
      if (group.amplified || group.count <= 1 || group.cap <= 100) continue;
      const shards = requiredShards(group.work, group.count - 1, group.cap), cost = shards - group.shards;
      if (Number.isFinite(shards) && cost <= remaining && (!choice || cost < choice.cost || cost === choice.cost && group.extractor && !choice.group.extractor)) choice = { group, shards, cost };
    }
    if (!choice) break;
    remaining -= choice.cost; choice.group.count--; choice.group.shards = choice.shards;
  }
  const variantsByRecipe = new Map<string, ProductionVariant[]>(), extracted = new Map<string, ExtractionRow>();
  for (const group of groups) {
    const schedule = clockGroups(group);
    if (group.extractor) {
      const original = group.extractionRow!, definition = gameData.extractors.find(row => row.id === original.machineId)!;
      const power = (clock: number) => definition.powerMW * (clock / 100) ** definition.powerExponent * (request.settings?.powerMultiplier ?? 1);
      const highClock = Math.max(...schedule.map(run => run.clock)), last = schedule[schedule.length - 1];
      extracted.set(original.itemId, { ...original, count: group.count, fullMachines: group.count - 1, clock: highClock, lastClock: last.clock, dutyCycle: Math.min(...schedule.map(run => run.dutyCycle)), powerShards: schedule.reduce((sum, run) => sum + run.count * run.shardsPerMachine, 0), clockGroups: schedule,
        perMachineRate: original.perMachineRate * highClock / original.clock,
        powerMW: schedule.reduce((sum, run) => sum + run.count * power(run.clock) * run.dutyCycle, 0), powerMaxMW: schedule.reduce((sum, run) => sum + run.count * power(run.clock), 0) });
      continue;
    }
    const original = group.variant!, variants = variantsByRecipe.get(group.recipeId!) || [];
    for (const run of schedule) {
      const share = run.count * run.clock / 100 * run.dutyCycle / group.work;
      const unit = recipeRates(group.recipeId!, run.clock, request.settings, original.sloops);
      variants.push({ ...original, exactMachines: run.count * run.dutyCycle, machineCount: run.count, fullMachines: run.count - 1, clock: run.clock, lastClock: run.clock, dutyCycle: run.dutyCycle,
        powerShards: run.count * run.shardsPerMachine, clockLimited: group.clockLimited || false,
        inputs: original.inputs.map(row => ({ ...row, rate: row.rate * share })), outputs: original.outputs.map(row => ({ ...row, rate: row.rate * share })),
        powerMW: run.count * unit.powerMW * run.dutyCycle, powerMinMW: run.count * unit.powerMinMW * run.dutyCycle, powerMaxMW: run.count * unit.powerMaxMW });
    }
    variantsByRecipe.set(group.recipeId!, variants);
  }
  const recipes = plan.recipes.map(row => aggregateRecipeVariants(row.recipeId, variantsByRecipe.get(row.recipeId)!));
  const totals = recipes.reduce((sum, row) => ({ machines: sum.machines + row.machineCount, powerMW: sum.powerMW + row.powerMW, powerMinMW: sum.powerMinMW + row.powerMinMW, powerMaxMW: sum.powerMaxMW + row.powerMaxMW, powerShards: sum.powerShards + row.powerShards, somersloops: sum.somersloops + row.totalSomersloops }), { machines: 0, powerMW: 0, powerMinMW: 0, powerMaxMW: 0, powerShards: 0, somersloops: 0 });
  if (request.somersloopBudget !== undefined && totals.somersloops > request.somersloopBudget) throw new Error('The solver returned a Somersloop allocation that cannot fit the baseline clock. Recalculate before assigning Power Shards.');
  const allocatedExtraction = extractionFromRows(extraction.rows.map(row => extracted.get(row.itemId) || row));
  const shardsUsed = totals.powerShards + allocatedExtraction.powerShards;
  if (shardsUsed > budget) throw new Error('The physical allocation exceeded its Power Shard budget.');
  return { plan: { ...plan, recipes, totals, warnings: [...plan.warnings, 'Power Shards are shared across production and modeled extraction. Somersloop-amplified machines stay at or below 100%; shards are spent only when they remove a building.'] }, extraction: allocatedExtraction, shardsUsed, shardsUnused: budget - shardsUsed };
}
