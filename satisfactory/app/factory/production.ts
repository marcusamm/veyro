import { catalog, itemById, recipeById, machineById, recipeRates, transportCapacity } from './engine';
import type { FactorySettings, MaterialRate } from './types';

/** Targets and external supplies are rates per minute (m³/min for fluids). */
export type ProductionRequest = {
  outputs: MaterialRate[];
  inputs?: MaterialRate[];
  allowedAlternates?: string[];
  allowedConverters?: string[];
  excludedRecipes?: string[];
  recipeOverrides?: Record<string, string>;
  clock?: number;
  recipeClocks?: Record<string, number>;
  sloops?: Record<string, number>;
  somersloopBudget?: number;
  powerShardBudget?: number;
  beltTier?: number;
  pipeTier?: number;
  settings?: FactorySettings;
  mode?: 'target' | 'maximize';
  optimization?: 'resources' | 'power' | 'buildings';
  resourcePolicy?: 'open' | 'closed';
  /** With caps enabled, named inputs cannot also be extracted or manufactured. */
  capInputs?: boolean;
};
export type ProductionVariant = {
  exactMachines: number; machineCount: number; fullMachines: number;
  requestedClock: number; clock: number; lastClock: number; clockLimited: boolean;
  /** Last machine's running fraction when a target is below its minimum clock. */
  dutyCycle: number; sloops: number; powerShards: number;
  inputs: MaterialRate[]; outputs: MaterialRate[];
  powerMW: number; powerMinMW: number; powerMaxMW: number;
};
export type ProductionRecipe = ProductionVariant & {
  recipeId: string; machineId: string; variants: ProductionVariant[]; totalSomersloops: number;
};
export type ProductionTransport = {
  itemId: string; rate: number; transport: 'belt' | 'pipe'; tier: number; capacity: number; lines: number;
};
export type ProductionBalance = {
  itemId: string; produced: number; consumed: number; external: number; requested: number; surplus: number;
};
export type ProductionPlan = {
  status: 'optimal' | 'infeasible' | 'unbounded' | 'error'; message: string;
  recipes: ProductionRecipe[]; resources: MaterialRate[]; externalInputs: MaterialRate[];
  products: MaterialRate[]; surplus: MaterialRate[]; transports: ProductionTransport[];
  balances: ProductionBalance[];
  totals: { machines: number; powerMW: number; powerMinMW: number; powerMaxMW: number; somersloops: number; powerShards: number };
  multiplier: number; warnings: string[];
};
export type ValidatedProductionRequest = Omit<Required<ProductionRequest>, 'somersloopBudget' | 'powerShardBudget'> & Pick<ProductionRequest, 'somersloopBudget' | 'powerShardBudget'>;
const EPS = 1e-8;
const own = (object: object, key: string) => Object.hasOwn(object, key);
const tidy = (n: number) => Math.abs(n) < 1e-10 ? 0 : n;
const fail = (message: string): never => { throw new Error(message); };
function finite(n: unknown, min: number, max: number, label: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) fail(`${label} must be between ${min} and ${max}.`);
  return n as number;
}
function rateList(value: unknown, label: string, positive: boolean): MaterialRate[] {
  if (!Array.isArray(value) || value.length > 100) fail(`${label} must contain at most 100 items.`);
  const totals = new Map<string, number>();
  for (const entry of value as MaterialRate[]) {
    if (!entry || !own(itemById, entry.itemId)) fail(`Unknown item in ${label}.`);
    const rate = finite(entry.rate, positive ? 0.000001 : 0, 1e7, label);
    totals.set(entry.itemId, (totals.get(entry.itemId) ?? 0) + rate);
    if (totals.get(entry.itemId)! > 1e7) fail(`${label} exceeds the rate limit for one item.`);
  }
  return [...totals].map(([itemId, rate]) => ({ itemId, rate }));
}
function recipeList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > catalog.recipes.length) fail(`Invalid ${label}.`);
  return [...new Set((value as unknown[]).map(id => typeof id === 'string' && own(recipeById, id) ? id : fail(`Unknown recipe in ${label}.`)))];
}
export function validateProductionRequest(value: ProductionRequest): ValidatedProductionRequest {
  if (!value || typeof value !== 'object') fail('A production request is required.');
  const outputs = rateList(value.outputs, 'Output targets', true);
  if (!outputs.length) fail('Choose at least one output target.');
  const inputs = rateList(value.inputs ?? [], 'Available inputs', false);
  const mode = value.mode ?? 'target', optimization = value.optimization ?? 'resources', resourcePolicy = value.resourcePolicy ?? 'open';
  if (!['target', 'maximize'].includes(mode)) fail('Unknown calculation mode.');
  if (!['resources', 'power', 'buildings'].includes(optimization)) fail('Unknown optimization objective.');
  if (!['open', 'closed'].includes(resourcePolicy)) fail('Unknown resource policy.');
  const clock = finite(value.clock ?? 100, 1, 250, 'Clock speed');
  const beltTier = value.beltTier ?? 6, pipeTier = value.pipeTier ?? 2;
  if (!Number.isInteger(beltTier) || !transportCapacity('belt', beltTier)) fail('Choose a valid belt tier.');
  if (!Number.isInteger(pipeTier) || !transportCapacity('pipe', pipeTier)) fail('Choose a valid pipe tier.');
  const settings = { recipeMultiplier: finite(value.settings?.recipeMultiplier ?? 1, 0.25, 2, 'Recipe cost'), powerMultiplier: finite(value.settings?.powerMultiplier ?? 1, 0.25, 5, 'Power multiplier') };
  const record = (v: unknown, label: string): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > catalog.recipes.length) fail(`Invalid ${label}.`);
    return v as Record<string, unknown>;
  };
  const recipeClocks: Record<string, number> = {}, sloops: Record<string, number> = {}, recipeOverrides: Record<string, string> = {};
  for (const [id, c] of Object.entries(record(value.recipeClocks ?? {}, 'recipe clocks'))) {
    if (!own(recipeById, id)) fail('Unknown recipe clock.');
    recipeClocks[id] = finite(c, 1, 250, 'Recipe clock');
  }
  for (const [id, s] of Object.entries(record(value.sloops ?? {}, 'Somersloops'))) {
    if (!own(recipeById, id)) fail('Unknown Somersloop recipe.');
    const count = finite(s, 0, machineById[recipeById[id].machineId].sloopSlots ?? 0, 'Somersloops');
    if (!Number.isInteger(count)) fail('Somersloop counts must be integers.');
    sloops[id] = count;
  }
  for (const [itemId, recipeId] of Object.entries(record(value.recipeOverrides ?? {}, 'recipe choices'))) {
    if (!own(itemById, itemId) || typeof recipeId !== 'string' || !own(recipeById, recipeId) || recipeById[recipeId].products[0]?.itemId !== itemId) fail('A chosen recipe must have the chosen item as its main product.');
    recipeOverrides[itemId] = recipeId as string;
  }
  if (value.capInputs !== undefined && typeof value.capInputs !== 'boolean') fail('Input caps must be on or off.');
  for (const budget of [value.somersloopBudget, value.powerShardBudget]) if (budget !== undefined) {
    finite(budget, 0, 10000, 'Boost inventory');
    if (!Number.isInteger(budget)) fail('Boost inventories must be whole numbers.');
  }
  return { outputs, inputs, mode, optimization, resourcePolicy, capInputs: value.capInputs ?? (mode === 'maximize'), clock, beltTier, pipeTier, settings, recipeClocks, sloops, recipeOverrides,
    ...(value.somersloopBudget === undefined ? {} : { somersloopBudget: value.somersloopBudget }), ...(value.powerShardBudget === undefined ? {} : { powerShardBudget: value.powerShardBudget }),
    allowedAlternates: recipeList(value.allowedAlternates ?? [], 'alternate recipes'), allowedConverters: recipeList(value.allowedConverters ?? [], 'converter recipes'), excludedRecipes: recipeList(value.excludedRecipes ?? [], 'excluded recipes') };
}

// Approximate map-resource weights used by SC's resource objective. These are
// optimization preferences, not a claim about the available nodes in a save.
const availability: Record<string, number> = {
  Desc_OreIron_C: 92100, Desc_Stone_C: 69900, Desc_Coal_C: 42300, Desc_OreCopper_C: 36900,
  Desc_OreGold_C: 15000, Desc_RawQuartz_C: 13500, Desc_LiquidOil_C: 12600, Desc_OreBauxite_C: 12300,
  Desc_NitrogenGas_C: 12000, Desc_Sulfur_C: 10800, Desc_SAM_C: 10200, Desc_OreUranium_C: 2100,
};
export const resourceWeight = (itemId: string) => itemId === 'Desc_Water_C' ? 0 : 100000 / (availability[itemId] ?? 1000);

/** Two-phase primal simplex for max(c*x), A*x <= b, x >= 0.
 * Adapted from this application's existing network solver. No external solver
 * code is bundled. Stable variable-index tie breaks make results deterministic.
 */
class Simplex {
  basis: number[]; nonbasis: number[]; table: Float64Array[]; rows: number; cols: number;
  constructor(A: number[][], b: number[], c: number[], private spend: (n: number) => void, private precision = EPS) {
    this.rows = b.length; this.cols = c.length;
    this.basis = b.map((_, i) => c.length + i); this.nonbasis = [...c.map((_, i) => i), -1];
    this.table = Array.from({ length: b.length + 2 }, () => new Float64Array(c.length + 2));
    spend((b.length + 2) * (c.length + 2));
    for (let i = 0; i < b.length; i++) {
      this.table[i].set(A[i]); this.table[i][c.length] = -1; this.table[i][c.length + 1] = b[i];
    }
    c.forEach((v, j) => this.table[b.length][j] = -v); this.table[b.length + 1][c.length] = 1;
  }
  pivot(r: number, s: number) {
    const D = this.table, m = this.rows, n = this.cols, inverse = 1 / D[r][s];
    this.spend((m + 2) * (n + 2));
    for (let i = 0; i < m + 2; i++) if (i !== r) {
      const factor = D[i][s] * inverse;
      if (Math.abs(factor) < 1e-15) continue;
      for (let j = 0; j < n + 2; j++) if (j !== s) D[i][j] -= D[r][j] * factor;
    }
    for (let j = 0; j < n + 2; j++) if (j !== s) D[r][j] *= inverse;
    for (let i = 0; i < m + 2; i++) if (i !== r) D[i][s] *= -inverse;
    D[r][s] = inverse; [this.basis[r], this.nonbasis[s]] = [this.nonbasis[s], this.basis[r]];
  }
  phase(phase: 1 | 2): boolean {
    const m = this.rows, n = this.cols, D = this.table, objective = phase === 1 ? m + 1 : m, EPS = this.precision;
    for (let iterations = 0; iterations < 12000; iterations++) {
      let s = -1;
      for (let j = 0; j <= n; j++) {
        if (phase === 2 && this.nonbasis[j] === -1) continue;
        if (s < 0 || D[objective][j] < D[objective][s] - EPS || (Math.abs(D[objective][j] - D[objective][s]) <= EPS && this.nonbasis[j] < this.nonbasis[s])) s = j;
      }
      if (s < 0 || D[objective][s] >= -EPS) return true;
      let r = -1;
      for (let i = 0; i < m; i++) if (D[i][s] > EPS) {
        const ratio = D[i][n + 1] / D[i][s], previous = r < 0 ? Infinity : D[r][n + 1] / D[r][s];
        if (r < 0 || ratio < previous - EPS || (Math.abs(ratio - previous) <= EPS && this.basis[i] < this.basis[r])) r = i;
      }
      if (r < 0) return false;
      this.pivot(r, s);
    }
    return fail('The optimization did not converge. Reduce the number of alternate recipes.');
  }
  solve(): { status: 'optimal' | 'infeasible' | 'unbounded'; x: number[] } {
    const m = this.rows, n = this.cols, D = this.table, EPS = this.precision;
    let r = 0;
    for (let i = 1; i < m; i++) if (D[i][n + 1] < D[r][n + 1]) r = i;
    if (m && D[r][n + 1] < -EPS) {
      this.pivot(r, n);
      if (!this.phase(1) || Math.abs(D[m + 1][n + 1]) > EPS) return { status: 'infeasible', x: [] };
      const artificial = this.basis.indexOf(-1);
      if (artificial >= 0) {
        let s = -1;
        for (let j = 0; j <= n; j++) if (Math.abs(D[artificial][j]) > EPS && (s < 0 || this.nonbasis[j] < this.nonbasis[s])) s = j;
        if (s >= 0) this.pivot(artificial, s);
      }
    }
    if (!this.phase(2)) return { status: 'unbounded', x: [] };
    const x = Array(n).fill(0);
    for (let i = 0; i < m; i++) if (this.basis[i] >= 0 && this.basis[i] < n) x[this.basis[i]] = Math.max(0, D[i][n + 1]);
    return { status: 'optimal', x };
  }
}

const empty = (status: ProductionPlan['status'], message: string): ProductionPlan => ({ status, message, recipes: [], resources: [], externalInputs: [], products: [], surplus: [], transports: [], balances: [], totals: { machines: 0, powerMW: 0, powerMinMW: 0, powerMaxMW: 0, somersloops: 0, powerShards: 0 }, multiplier: 0, warnings: [] });
const itemMap = (list: MaterialRate[]) => new Map(list.map(v => [v.itemId, v.rate]));
type AmplificationBounds = Map<string, { lower?: number; upper?: number }>;
type AmplificationAllocation = { kept?: Map<string, number>; freeBudget?: number; bounds?: AmplificationBounds };
type AmplificationUse = { key: string; recipeId: string; sloops: number; slots: number; machines: number; wholeVariable: number };
type OptimizationDetails = { objectives: number[]; amplified: AmplificationUse[] };
const optimizationDetails = new WeakMap<ProductionPlan, OptimizationDetails>();

export function solveProductionPlan(input: ProductionRequest): ProductionPlan {
  try {
    const request = validateProductionRequest(input);
    try { return request.somersloopBudget === undefined ? solveValidated(request) : solveBudgeted(request); }
    catch (e) {
      // Degenerate converter/recycling networks can leave roundoff-sized
      // reduced costs. Retry with a looser pivot threshold, then independently
      // verify material balances; never turn an infeasible result into success.
      if (!(e instanceof Error) || !/did not converge|Numerical verification|material-balance/.test(e.message)) throw e;
      return request.somersloopBudget === undefined ? solveValidated(request, 1e-7) : solveBudgeted(request, 1e-7);
    }
  }
  catch (e) { return empty('error', e instanceof Error ? e.message : 'The production plan could not be calculated.'); }
}

function solveValidated(request: ValidatedProductionRequest, precision = EPS, extraOutputs = true, allocation: AmplificationAllocation = {}): ProductionPlan {
  const supplied = itemMap(request.inputs), targets = itemMap(request.outputs);
  const allowed = new Set([...request.allowedAlternates, ...request.allowedConverters, ...Object.values(request.recipeOverrides)]), excluded = new Set(request.excludedRecipes);
  const forced = new Map<string, Set<string>>();
  for (const target of request.outputs) {
    const selected = request.allowedAlternates.filter(id => !excluded.has(id) && recipeById[id].products[0]?.itemId === target.itemId);
    if (selected.length) forced.set(target.itemId, new Set(selected));
  }
  for (const [itemId, recipeId] of Object.entries(request.recipeOverrides)) forced.set(itemId, new Set([recipeId]));
  let candidates = catalog.recipes.filter(recipe => {
    if (excluded.has(recipe.id) || recipe.alternate && !allowed.has(recipe.id)) return false;
    const primary = recipe.products[0]?.itemId;
    if (request.capInputs && supplied.has(primary)) return false;
    if (forced.has(primary) && !forced.get(primary)!.has(recipe.id)) return false;
    // Resource conversions are explicit choices; ordinary Converter production
    // (e.g. Ficsite and Excited Photonic Matter) remains available normally.
    if (recipe.machineId === 'Desc_Converter_C' && itemById[primary]?.resource && !allowed.has(recipe.id)) return false;
    return true;
  });
  // Remove branches that require items with no source at all (e.g. animal
  // remains without an external supply). This is exact structural pruning,
  // not an epsilon filter; recycling components retain their mutual sources.
  let pruned = true;
  while (pruned) {
    const produced = new Set(candidates.flatMap(r => r.products.map(p => p.itemId)));
    const next = candidates.filter(r => r.ingredients.every(i => produced.has(i.itemId)
      || (supplied.get(i.itemId) ?? 0) > 0
      || itemById[i.itemId].resource && request.resourcePolicy === 'open' && !(request.capInputs && supplied.has(i.itemId))));
    pruned = next.length !== candidates.length;
    candidates = next;
  }
  // Backwards closure includes every possible ingredient path and byproduct
  // producer, including cycles. It never assumes a recipe graph is a tree.
  const needed = new Set(request.outputs.map(p => p.itemId)), chosen = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const recipe of candidates) if (!chosen.has(recipe.id) && recipe.products.some(p => needed.has(p.itemId))) {
      chosen.add(recipe.id); changed = true;
      recipe.ingredients.forEach(i => needed.add(i.itemId));
    }
  }
  const recipes = candidates.filter(r => chosen.has(r.id));
  const automatic = request.somersloopBudget !== undefined;
  const units = recipes.flatMap(recipe => {
    const configuredClock = request.recipeClocks[recipe.id] ?? request.clock;
    const slots = machineById[recipe.machineId].sloopSlots ?? 0;
    const variants = automatic ? Array.from({ length: Math.min(slots, request.somersloopBudget!) + 1 }, (_, i) => i) : [request.sloops[recipe.id] ?? 0];
    return variants.flatMap(sloops => {
    const key = recipe.id + '|' + sloops;
    if (automatic && sloops > 0 && !allocation.bounds && !allocation.kept?.has(key) && sloops > (allocation.freeBudget ?? request.somersloopBudget!)) return [];
    const requestedClock = automatic && sloops > 0 || request.powerShardBudget !== undefined ? Math.min(100, configuredClock) : configuredClock;
    if (automatic && sloops > 0) {
      const at100 = recipeRates(recipe.id, 100, request.settings, sloops);
      if ([...at100.inputs, ...at100.outputs].some(p => {
        const solid = itemById[p.itemId].form === 'solid';
        return p.rate > transportCapacity(solid ? 'belt' : 'pipe', solid ? request.beltTier : request.pipeTier) + EPS;
      })) return [];
    }
    const full = recipeRates(recipe.id, requestedClock, request.settings, sloops);
    let clock = requestedClock, transportClock = 250;
    for (const rate of [...full.inputs, ...full.outputs]) {
      const solid = itemById[rate.itemId].form === 'solid', capacity = transportCapacity(solid ? 'belt' : 'pipe', solid ? request.beltTier : request.pipeTier);
      transportClock = Math.min(transportClock, requestedClock * capacity / rate.rate);
      if (rate.rate > capacity) clock = Math.min(clock, requestedClock * capacity / rate.rate);
    }
    if (clock < 1 - EPS) fail(`The selected transport cannot supply ${recipe.name} even at 1% clock.`);
    // recipeRates rounds to four decimal clock places; round down at capacity.
    clock = Math.max(1, Math.floor((clock + 1e-9) * 10000) / 10000);
    return [{ key, slots, recipe, requestedClock: configuredClock, clock, transportClock, sloops, ...recipeRates(recipe.id, clock, request.settings, sloops) }];
    });
  });
  const raw = catalog.items.filter(i => i.resource && needed.has(i.id) && request.resourcePolicy === 'open' && !(request.capInputs && supplied.has(i.id)));
  const explicit = request.inputs.filter(i => needed.has(i.itemId));
  const relevant = new Set([...request.outputs.map(p => p.itemId), ...raw.map(i => i.id), ...explicit.map(i => i.itemId)]);
  for (const unit of units) [...unit.inputs, ...unit.outputs].forEach(i => relevant.add(i.itemId));
  const items = [...relevant].sort();
  const resourceOffset = units.length, inputOffset = resourceOffset + raw.length, scaleIndex = inputOffset + explicit.length;
  const extraOffset = scaleIndex + 1;
  const wholeOffset = scaleIndex + (request.mode === 'maximize' ? 1 + (extraOutputs ? request.outputs.length : 0) : 0);
  const amplifiedIndices = automatic ? units.map((unit, index) => ({ unit, index })).filter(({ unit }) => unit.sloops > 0) : [];
  const wholeVariables = new Map(allocation.bounds ? amplifiedIndices.map(({ unit }, index) => [unit.key, wholeOffset + index]) : []);
  const variableCount = wholeOffset + wholeVariables.size, A: number[][] = [], b: number[] = [];
  const rateScale = Math.max(...request.outputs.map(p => p.rate));
  const row = () => Array(variableCount).fill(0) as number[];
  const add = (values: number[], bound: number) => {
    const scale = Math.max(1, ...values.map(Math.abs));
    A.push(values.map(v => v / scale)); b.push(bound / scale);
  };
  // sum(ingredients) - sum(products) - external + target*scale <= 0.
  // Slack is actual surplus; no material is ever invented at a cycle boundary.
  for (const itemId of items) {
    const coefficients = row();
    units.forEach((unit, j) => {
      coefficients[j] = (unit.inputs.find(p => p.itemId === itemId)?.rate ?? 0);
      if (!forced.has(itemId) || forced.get(itemId)!.has(unit.recipe.id))
        coefficients[j] -= unit.outputs.find(p => p.itemId === itemId)?.rate ?? 0;
    });
    raw.forEach((item, j) => { if (item.id === itemId) coefficients[resourceOffset + j] = -1; });
    explicit.forEach((item, j) => { if (item.itemId === itemId) coefficients[inputOffset + j] = -1; });
    const target = (targets.get(itemId) ?? 0) / rateScale;
    if (request.mode === 'maximize') {
      coefficients[scaleIndex] = target;
      if (extraOutputs) request.outputs.forEach((output, index) => { if (output.itemId === itemId) coefficients[extraOffset + index] = 1; });
      add(coefficients, 0);
    }
    else add(coefficients, -target);
  }
  explicit.forEach((input, j) => { const constraint = row(); constraint[inputOffset + j] = 1; add(constraint, input.rate / rateScale); });
  if (automatic) {
    const budget = row();
    for (const { unit, index } of amplifiedIndices) {
      const whole = wholeVariables.get(unit.key);
      if (whole !== undefined) {
        const linked = row(); linked[index] = 1; linked[whole] = -1; add(linked, 0);
        budget[whole] = unit.sloops;
        const bound = allocation.bounds?.get(unit.key);
        if (bound?.lower) { const minimum = row(); minimum[whole] = -1; add(minimum, -bound.lower / rateScale); }
        if (Number.isFinite(bound?.upper)) { const maximum = row(); maximum[whole] = 1; add(maximum, bound!.upper! / rateScale); }
      } else if (allocation.kept?.has(unit.key)) {
        const cap = row(); cap[index] = 1; add(cap, allocation.kept.get(unit.key)! / rateScale);
      } else budget[index] = unit.sloops;
    }
    add(budget, (allocation.bounds ? request.somersloopBudget! : allocation.freeBudget ?? request.somersloopBudget!) / rateScale);
  }
  let work = 0;
  const spend = (n: number) => { work += n; if (work > 800000000) fail('This request exceeds the calculation limit. Reduce the number of alternate recipes or split the targets.'); };
  const solve = (cost: number[], maximize = false) => new Simplex(A, b, cost.map(n => maximize ? n : -n), spend, precision).solve();
  let solved: ReturnType<Simplex['solve']>;
  let multiplier = 1;
  if (request.mode === 'maximize') {
    const objective = row(); objective[scaleIndex] = 1;
    solved = solve(objective, true);
    if (solved.status === 'unbounded') return empty('unbounded', 'Output is unbounded: cap a resource required by every selected production route, or use a closed resource budget.');
    if (solved.status !== 'optimal') return empty('infeasible', 'The available inputs and selected recipes cannot produce these outputs.');
    multiplier = solved.x[scaleIndex];
    if (multiplier < 1e-8) return empty('infeasible', 'No positive output can be produced with these input limits and recipes.');
    const lower = row(); lower[scaleIndex] = -1; add(lower, -multiplier);
    const upper = row(); upper[scaleIndex] = 1; add(upper, multiplier);
    if (extraOutputs) {
      const extraCost = row();
      request.outputs.forEach((output, index) => extraCost[extraOffset + index] = rateScale / output.rate);
      const extraResult = solve(extraCost, true);
      if (extraResult.status === 'unbounded') {
        const ratioOnly = solveValidated(request, precision, false, allocation);
        if (ratioOnly.status === 'optimal') ratioOnly.warnings.unshift('Extra output is unbounded on an uncapped production path; the result keeps the maximum common output ratio.');
        return ratioOnly;
      }
      if (extraResult.status !== 'optimal') return empty('infeasible', 'The remaining inputs cannot be allocated to these outputs.');
      const extraValue = extraCost.reduce((total, cost, index) => total + cost * extraResult.x[index], 0);
      add(extraCost.map(value => -value), -extraValue);
    }
  }
  const resourceCost = row(), buildingCost = row(), powerCost = row(), cleanupCost = row();
  raw.forEach((item, j) => { resourceCost[resourceOffset + j] = resourceWeight(item.id); cleanupCost[resourceOffset + j] = 1; });
  explicit.forEach((_item, j) => cleanupCost[inputOffset + j] = 1);
  units.forEach((unit, j) => { buildingCost[j] = 1; powerCost[j] = unit.powerMW; cleanupCost[j] = 1; });
  const objectives = request.optimization === 'power' ? [powerCost, resourceCost, buildingCost] : request.optimization === 'buildings' ? [buildingCost, resourceCost] : [resourceCost, buildingCost];
  // A final tie break eliminates otherwise free, unused water and supplied input.
  objectives.push(cleanupCost);
  const feasibilityRows = A.length;
  solved = { status: 'infeasible', x: [] };
  for (const cost of objectives) {
    if (!cost.some(c => c !== 0)) continue;
    solved = solve(cost);
    if (solved.status !== 'optimal') break;
    const optimum = cost.reduce((sum, c, j) => sum + c * solved.x[j], 0);
    // Preserve the earlier objective within floating point roundoff only.
    add(cost, optimum + Math.max(1, Math.abs(optimum)) * 1e-7);
  }
  if (solved.status !== 'optimal') return empty(solved.status, solved.status === 'unbounded' ? 'The selected optimization is unbounded.' : 'These targets cannot be met with the selected recipes and input limits. Add an external input, unlock a recipe or raise a limit.');
  // Refactor on the active recipe support before presenting results. An LP
  // tableau with hundreds of equivalent alternate paths can leave epsilon-sized
  // ghost recipes. Simply hiding them would break mass conservation. Instead,
  // solve the smaller physical network again with tight feasibility tolerances.
  // If a tiny recipe is genuinely necessary, the stricter support is infeasible
  // and the second pass retains it.
  for (const threshold of [1e-7, 1e-11]) {
    const active = Array.from({ length: variableCount }, (_, i) => i).filter(i => i >= units.length || solved.x[i] > threshold);
    const refinedA = A.slice(0, feasibilityRows).map(r => active.map(i => r[i])), refinedB = b.slice(0, feasibilityRows);
    let refined: ReturnType<Simplex['solve']> = { status: 'infeasible', x: [] };
    for (const cost of objectives) {
      const c = active.map(i => cost[i]);
      if (!c.some(Boolean)) continue;
      refined = new Simplex(refinedA, refinedB, c.map(v => -v), spend, 1e-10).solve();
      if (refined.status !== 'optimal') break;
      const optimum = c.reduce((sum, value, i) => sum + value * refined.x[i], 0), scale = Math.max(1, ...c.map(Math.abs));
      refinedA.push(c.map(v => v / scale)); refinedB.push((optimum + Math.max(1, Math.abs(optimum)) * 1e-10) / scale);
    }
    if (refined.status === 'optimal') {
      const expanded = Array(variableCount).fill(0);
      active.forEach((original, i) => expanded[original] = refined.x[i]);
      solved = { status: 'optimal', x: expanded };
      break;
    }
  }
  // Verify against the ORIGINAL inequalities as well as the frozen objectives.
  for (let i = 0; i < feasibilityRows; i++) {
    const left = A[i].reduce((sum, c, j) => sum + c * solved.x[j], 0);
    if (left > b[i] + 1e-5 * Math.max(1, Math.abs(b[i]))) fail('Numerical verification failed. Try smaller rates or fewer recipe alternatives.');
  }
  const solvedObjectives = objectives.map(cost => cost.reduce((total, coefficient, index) => total + coefficient * solved.x[index] * rateScale, 0));
  solved.x = solved.x.map((value, index) => request.mode === 'maximize' && index === scaleIndex ? value : value * rateScale);
  const plan = empty('optimal', 'Production plan calculated.');
  plan.multiplier = multiplier;
  plan.products = request.outputs.map((p, index) => ({ itemId: p.itemId, rate: p.rate * multiplier + (request.mode === 'maximize' && extraOutputs ? solved.x[extraOffset + index] : 0) }));
  plan.resources = raw.map((i, j) => ({ itemId: i.id, rate: tidy(solved.x[resourceOffset + j]) })).filter(i => i.rate > 0);
  plan.externalInputs = explicit.map((i, j) => ({ itemId: i.itemId, rate: tidy(solved.x[inputOffset + j]) })).filter(i => i.rate > 0);
  for (let j = 0; j < units.length; j++) {
    const exactMachines = solved.x[j];
    if (exactMachines <= 1e-12) continue;
    const u = units[j], machineCount = Math.max(1, Math.ceil(exactMachines - 1e-7)), fullMachines = machineCount - 1;
    const fraction = Math.min(1, Math.max(0, exactMachines - fullMachines)), theoreticalClock = u.clock * fraction;
    const lastClock = Math.min(u.clock, Math.max(1, Math.round(theoreticalClock * 10000) / 10000));
    const dutyCycle = theoreticalClock < 1 ? theoreticalClock : 1;
    const last = recipeRates(u.recipe.id, lastClock, request.settings, u.sloops);
    const shardsFor = (clock: number) => Math.max(0, Math.ceil((clock - 100) / 50 - 1e-8));
    const variant: ProductionVariant = { exactMachines, machineCount, fullMachines, requestedClock: u.requestedClock, clock: u.clock, lastClock, clockLimited: u.transportClock < u.requestedClock - 0.0001, dutyCycle, sloops: u.sloops, powerShards: fullMachines * shardsFor(u.clock) + shardsFor(lastClock),
      inputs: u.inputs.map(p => ({ itemId: p.itemId, rate: p.rate * exactMachines })), outputs: u.outputs.map(p => ({ itemId: p.itemId, rate: p.rate * exactMachines })),
      powerMW: fullMachines * u.powerMW + last.powerMW * dutyCycle, powerMinMW: fullMachines * u.powerMinMW + last.powerMinMW * dutyCycle, powerMaxMW: fullMachines * u.powerMaxMW + last.powerMaxMW };
    const existing = plan.recipes.find(r => r.recipeId === u.recipe.id);
    if (existing) Object.assign(existing, aggregateRecipeVariants(u.recipe.id, [...existing.variants, variant]));
    else plan.recipes.push(aggregateRecipeVariants(u.recipe.id, [variant]));
    plan.totals.machines += machineCount; plan.totals.powerMW += variant.powerMW; plan.totals.powerMinMW += variant.powerMinMW; plan.totals.powerMaxMW += variant.powerMaxMW;
    plan.totals.somersloops += machineCount * u.sloops; plan.totals.powerShards += variant.powerShards;
  }
  const produced = new Map<string, number>(), consumed = new Map<string, number>(), imported = new Map<string, number>();
  const sum = (map: Map<string, number>, rates: MaterialRate[]) => rates.forEach(p => map.set(p.itemId, (map.get(p.itemId) ?? 0) + p.rate));
  plan.recipes.forEach(r => { sum(produced, r.outputs); sum(consumed, r.inputs); });
  sum(imported, [...plan.resources, ...plan.externalInputs]);
  const products = itemMap(plan.products);
  plan.balances = items.map(itemId => {
    const p = produced.get(itemId) ?? 0, c = consumed.get(itemId) ?? 0, external = imported.get(itemId) ?? 0, requested = products.get(itemId) ?? 0;
    const surplus = tidy(p + external - c - requested);
    if (surplus < -1e-6 * Math.max(0.000001, requested, c, p, external)) fail('The production plan failed its material-balance verification.');
    return { itemId, produced: tidy(p), consumed: tidy(c), external: tidy(external), requested: tidy(requested), surplus: Math.max(0, surplus) };
  }).filter(p => p.produced || p.consumed || p.external || p.requested || p.surplus);
  plan.surplus = plan.balances.filter(p => p.surplus > 1e-6).map(p => ({ itemId: p.itemId, rate: p.surplus }));
  plan.transports = plan.balances.map(p => {
    const rate = p.produced + p.external, transport = itemById[p.itemId].form === 'solid' ? 'belt' as const : 'pipe' as const, tier = transport === 'belt' ? request.beltTier : request.pipeTier, capacity = transportCapacity(transport, tier);
    return { itemId: p.itemId, rate, transport, tier, capacity, lines: Math.ceil(rate / capacity - 1e-8) };
  }).filter(p => p.rate > 1e-7);
  if (plan.recipes.some(r => r.clockLimited)) plan.warnings.push('Some machine clocks were reduced to respect selected transport or boost-inventory settings.');
  if (plan.recipes.some(r => r.dutyCycle < 1 - EPS)) plan.warnings.push('A target is below a machine’s 1% minimum clock. Its last machine needs intermittent operation; reported rates and power are time averages.');
  if (plan.surplus.length) plan.warnings.push('All surplus must be removed, stored or consumed to prevent production backing up. Fluid surplus cannot be sent directly to an AWESOME Sink.');
  if (hasRecipeCycle(plan.recipes)) plan.warnings.push('This steady-state plan recycles materials. Supply startup material and prioritize return flows when building the loop.');
  plan.warnings.push('Power and building totals cover production machines only; miners, extractors, pumps, generators and standby draw are not included. Transport line counts are aggregate lower bounds, not a physical manifold layout.');
  const maximizeObjectives = request.mode === 'maximize' ? [-plan.multiplier, -plan.products.reduce((total, product, index) => total + product.rate / request.outputs[index].rate - plan.multiplier, 0)] : [];
  optimizationDetails.set(plan, { objectives: [...maximizeObjectives, ...solvedObjectives], amplified: amplifiedIndices.map(({ unit, index }) => ({ key: unit.key, recipeId: unit.recipe.id, sloops: unit.sloops, slots: unit.slots, machines: solved.x[index], wholeVariable: wholeVariables.has(unit.key) ? solved.x[wholeVariables.get(unit.key)!] : solved.x[index] })) });
  return plan;
}

export function aggregateRecipeVariants(recipeId: string, variants: ProductionVariant[]): ProductionRecipe {
  if (!variants.length || !own(recipeById, recipeId)) fail('A production recipe needs at least one machine variant.');
  const mergeRates = (side: 'inputs' | 'outputs') => {
    const merged = new Map<string, number>();
    for (const variant of variants) for (const p of variant[side]) merged.set(p.itemId, (merged.get(p.itemId) ?? 0) + p.rate);
    return [...merged].map(([itemId, rate]) => ({ itemId, rate }));
  };
  const sum = (field: 'exactMachines' | 'machineCount' | 'fullMachines' | 'powerShards' | 'powerMW' | 'powerMinMW' | 'powerMaxMW') => variants.reduce((total, v) => total + v[field], 0);
  return { ...variants[0], recipeId, machineId: recipeById[recipeId].machineId, variants, totalSomersloops: variants.reduce((total, v) => total + v.machineCount * v.sloops, 0),
    exactMachines: sum('exactMachines'), machineCount: sum('machineCount'), fullMachines: sum('fullMachines'), powerShards: sum('powerShards'), powerMW: sum('powerMW'), powerMinMW: sum('powerMinMW'), powerMaxMW: sum('powerMaxMW'),
    sloops: variants.every(v => v.sloops === variants[0].sloops) ? variants[0].sloops : 0,
    clockLimited: variants.some(v => v.clockLimited), dutyCycle: Math.min(...variants.map(v => v.dutyCycle)), inputs: mergeRates('inputs'), outputs: mergeRates('outputs') };
}

function betterPlan(candidate: ProductionPlan, incumbent: ProductionPlan): boolean {
  if (candidate.status !== 'optimal') return false;
  if (incumbent.status !== 'optimal') return true;
  const a = optimizationDetails.get(candidate)?.objectives, b = optimizationDetails.get(incumbent)?.objectives;
  if (!a || !b) return false;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const tolerance = 1e-8 * Math.max(1, Math.abs(a[i]), Math.abs(b[i]));
    if (a[i] < b[i] - tolerance) return true;
    if (a[i] > b[i] + tolerance) return false;
  }
  return false;
}

/** SC-style whole-machine amplification: LP relaxation, valid greedy incumbent,
 * then depth-first branch-and-bound (round up first), bounded at 40 nodes/400 ms.
 * Every returned plan respects the integer inventory, including partial machines.
 */
function solveBudgeted(request: ValidatedProductionRequest, precision = EPS): ProductionPlan {
  const budget = request.somersloopBudget!;
  if (budget === 0) return solveValidated(request, precision);
  const relaxed = solveValidated(request, precision);
  if (relaxed.status !== 'optimal') return relaxed;
  const kept = new Map<string, number>();
  let remaining = budget, current = relaxed;
  for (let round = 0; round < 4 && remaining > 0 && current.status === 'optimal'; round++) {
    const candidates = (optimizationDetails.get(current)?.amplified ?? []).filter(a => !kept.has(a.key) && a.machines > 1e-7)
      .map(a => ({ ...a, whole: Math.ceil(a.machines - 1e-7), usage: a.machines / Math.ceil(a.machines - 1e-7), contribution: a.machines * a.sloops / a.slots }))
      .sort((a, b) => b.usage - a.usage || b.contribution - a.contribution || a.key.localeCompare(b.key));
    if (!candidates.length) break;
    for (const candidate of candidates) {
      const affordable = Math.min(candidate.whole, Math.floor(remaining / candidate.sloops));
      if (affordable > 0) { kept.set(candidate.key, affordable); remaining -= affordable * candidate.sloops; }
    }
    current = solveValidated(request, precision, true, { kept, freeBudget: remaining });
  }
  let incumbent = solveValidated(request, precision, true, { kept, freeBudget: 0 });
  if (incumbent.status === 'optimal' && incumbent.totals.somersloops > budget) incumbent = empty('error', 'Amplification rounding exceeded the available inventory.');
  // An unboosted plan is a safe incumbent if greedy rounding picked a poor mix.
  if (incumbent.status !== 'optimal') {
    const baseline = solveValidated(request, precision, true, { kept: new Map(), freeBudget: 0 });
    if (baseline.status === 'optimal') incumbent = baseline;
  }
  const stack: AmplificationBounds[] = [new Map()];
  const started = performance.now();
  let nodes = 0, bounded = false;
  while (stack.length && nodes < 40 && performance.now() - started < 400) {
    const bounds = stack.pop()!; nodes++;
    let candidate: ProductionPlan;
    try { candidate = solveValidated(request, precision, true, { bounds }); }
    catch { bounded = true; continue; }
    if (candidate.status !== 'optimal' || !betterPlan(candidate, incumbent)) continue;
    const branch = (optimizationDetails.get(candidate)?.amplified ?? []).filter(a => {
      const fraction = a.wholeVariable - Math.floor(a.wholeVariable);
      return fraction > 1e-7 && fraction < 1 - 1e-7;
    }).sort((a, b) => b.wholeVariable * b.sloops - a.wholeVariable * a.sloops || a.key.localeCompare(b.key))[0];
    if (!branch) {
      if (candidate.totals.somersloops <= budget) incumbent = candidate;
      continue;
    }
    const previous = bounds.get(branch.key) ?? {};
    stack.push(new Map(bounds).set(branch.key, { ...previous, upper: Math.floor(branch.wholeVariable) }));
    stack.push(new Map(bounds).set(branch.key, { ...previous, lower: Math.ceil(branch.wholeVariable) }));
  }
  bounded ||= stack.length > 0;
  if (incumbent.status === 'optimal') {
    if (incumbent.totals.somersloops > budget) return empty('error', 'The result failed its whole-machine Somersloop inventory check.');
    if (bounded) incumbent.warnings.unshift('Somersloop allocation reached its bounded search limit. This plan respects your inventory; a better allocation may exist.');
    return incumbent;
  }
  return bounded ? empty('error', 'No feasible whole-machine Somersloop allocation was found within the bounded search. Try more inventory or simpler recipe choices.') : incumbent;
}

function hasRecipeCycle(recipes: ProductionRecipe[]): boolean {
  const byProduct = new Map<string, number[]>();
  recipes.forEach((r, i) => r.outputs.forEach(p => byProduct.set(p.itemId, [...(byProduct.get(p.itemId) ?? []), i])));
  const visiting = new Set<number>(), done = new Set<number>();
  const walk = (i: number): boolean => {
    if (visiting.has(i)) return true;
    if (done.has(i)) return false;
    visiting.add(i);
    for (const input of recipes[i].inputs) for (const j of byProduct.get(input.itemId) ?? []) if (walk(j)) return true;
    visiting.delete(i); done.add(i); return false;
  };
  return recipes.some((_, i) => walk(i));
}
