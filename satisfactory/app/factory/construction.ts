import costData from './data/construction-costs.json';
import gameData from './data/satisfactory-1.2.json';
import { itemById, transportCapacity } from './engine';
import type { ProductionPlan, ProductionRequest } from './production';
import type { MaterialRate } from './types';

const costs: Record<string, MaterialRate[]> = costData.costs;
const sortMaterials = (values: Map<string, number>): MaterialRate[] => [...values].map(([itemId, rate]) => ({ itemId, rate })).sort((a, b) => (itemById[a.itemId]?.name || a.itemId).localeCompare(itemById[b.itemId]?.name || b.itemId));
function buildingMaterials(buildings: { machineId: string; count: number }[]): MaterialRate[] {
  const total = new Map<string, number>();
  for (const building of buildings) {
    const recipe = costs[building.machineId];
    if (!recipe) throw new Error(`Construction costs are unavailable for ${building.machineId}.`);
    for (const row of recipe) total.set(row.itemId, (total.get(row.itemId) || 0) + row.rate * building.count);
  }
  return sortMaterials(total);
}

/** Quantities to place the production buildings; rate means an item count here, not /minute. */
export function constructionMaterials(plan: ProductionPlan): MaterialRate[] {
  return buildingMaterials(plan.recipes.map(row => ({ machineId: row.machineId, count: row.machineCount })));
}
export function productionBoosts(plan: ProductionPlan) {
  return { powerShards: plan.recipes.reduce((sum, row) => sum + row.powerShards, 0), somersloops: plan.recipes.reduce((sum, row) => sum + (row.totalSomersloops ?? row.sloops * row.machineCount), 0) };
}

export type ExtractionOptions = { minerTier?: 1 | 2 | 3; purity?: 'impure' | 'normal' | 'pure'; clock?: number };
export type ExtractionRow = {
  itemId: string; rate: number; supported: boolean; reason?: string;
  machineId?: string; name?: string; purity?: 'impure' | 'normal' | 'pure';
  count: number; fullMachines: number; clock: number; lastClock: number; requestedClock: number;
  perMachineRate: number; clockLimited: boolean; dutyCycle: number;
  powerMW: number; powerMaxMW: number; powerShards: number;
  clockGroups?: { count: number; clock: number; dutyCycle: number; shardsPerMachine: number }[];
};
export type ExtractionPlan = { rows: ExtractionRow[]; materials: MaterialRate[]; count: number; powerMW: number; powerMaxMW: number; powerShards: number; complete: boolean };
const shards = (clock: number) => Math.max(0, Math.ceil((clock - 100) / 50 - 1e-9));

/** Assumes separate resource nodes with the selected purity. It does not invent map locations or well layouts. */
export function planExtraction(plan: ProductionPlan, request: ProductionRequest, options: ExtractionOptions = {}): ExtractionPlan {
  const minerTier = options.minerTier ?? 1, purity = options.purity ?? 'normal', requestedClock = options.clock ?? 100;
  if (![1, 2, 3].includes(minerTier) || !['impure', 'normal', 'pure'].includes(purity) || !Number.isFinite(requestedClock) || requestedClock < 1 || requestedClock > 250) throw new Error('Choose a valid miner tier, purity and extraction clock from 1 to 250%.');
  const powerMultiplier = request.settings?.powerMultiplier ?? 1;
  if (!Number.isFinite(powerMultiplier) || powerMultiplier < .25 || powerMultiplier > 5) throw new Error('Invalid extraction power multiplier.');
  const rows = plan.resources.filter(row => row.rate > 0).map((resource): ExtractionRow => {
    const item = itemById[resource.itemId];
    const machineId = item?.form === 'solid' ? `Desc_MinerMk${minerTier}_C` : resource.itemId === 'Desc_LiquidOil_C' ? 'Desc_OilPump_C' : resource.itemId === 'Desc_Water_C' ? 'Desc_WaterPump_C' : undefined;
    const extractor = gameData.extractors.find(row => row.id === machineId && row.resourceIds.includes(resource.itemId));
    const base: ExtractionRow = { ...resource, supported: false, count: 0, fullMachines: 0, clock: 0, lastClock: 0, requestedClock, perMachineRate: 0, clockLimited: false, dutyCycle: 1, powerMW: 0, powerMaxMW: 0, powerShards: 0 };
    if (!extractor) return { ...base, reason: resource.itemId === 'Desc_NitrogenGas_C' ? 'Nitrogen requires a resource-well plan: satellite purities and the shared pressurizer must be specified. Its buildings, materials and power are not included.' : 'No verified extractor model is available for this resource.' };
    const capacity = transportCapacity(item.form === 'solid' ? 'belt' : 'pipe', item.form === 'solid' ? request.beltTier ?? 3 : request.pipeTier ?? 1);
    if (capacity <= 0) throw new Error('Unknown extraction belt or pipe tier.');
    const baseRate = extractor.baseRate * (extractor.supportsPurity ? extractor.purityMultipliers[purity] : 1);
    // Each extractor has one material output; the selected outgoing line caps its clock.
    const clock = Math.min(requestedClock, capacity / baseRate * 100), perMachineRate = baseRate * clock / 100;
    const count = Math.max(1, Math.ceil(resource.rate / perMachineRate - 1e-9)), fullMachines = count - 1;
    const requiredLastClock = Math.min(clock, Math.max(0, (resource.rate - fullMachines * perMachineRate) / baseRate * 100));
    const lastClock = Math.max(1, requiredLastClock), dutyCycle = Math.min(1, requiredLastClock);
    const power = (value: number) => extractor.powerMW * Math.pow(value / 100, extractor.powerExponent) * powerMultiplier;
    return { ...base, supported: true, machineId: extractor.id, name: extractor.name, purity: extractor.supportsPurity ? purity : undefined,
      count, fullMachines, clock, lastClock, perMachineRate, clockLimited: clock < requestedClock - 1e-8, dutyCycle,
      powerMW: fullMachines * power(clock) + power(lastClock) * dutyCycle, powerMaxMW: fullMachines * power(clock) + power(lastClock), powerShards: fullMachines * shards(clock) + shards(lastClock) };
  });
  return extractionFromRows(rows);
}

/** Recompute material and power totals after a global clock allocation. */
export function extractionFromRows(rows: ExtractionRow[]): ExtractionPlan {
  const supported = rows.filter(row => row.supported);
  return { rows, materials: buildingMaterials(supported.map(row => ({ machineId: row.machineId!, count: row.count }))), count: supported.reduce((sum, row) => sum + row.count, 0), powerMW: supported.reduce((sum, row) => sum + row.powerMW, 0), powerMaxMW: supported.reduce((sum, row) => sum + row.powerMaxMW, 0), powerShards: supported.reduce((sum, row) => sum + row.powerShards, 0), complete: rows.every(row => row.supported) };
}
