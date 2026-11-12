/** Rebuild a pinned, offline calculator dataset. Never silently follows a new game version. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://api.new.satisfactorytools.com/data/versions/stable-26281294.json';
const SOURCE_SHA256 = 'fddecaa07cdb77022f2e2d87c664617b8905882b10e4da43245638597240ee0c';
const sourceFile = process.argv[2];
const bytes = sourceFile ? await readFile(sourceFile) : new Uint8Array(await (await fetch(SOURCE_URL)).arrayBuffer());
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== SOURCE_SHA256) throw new Error(`Source changed: expected ${SOURCE_SHA256}, got ${digest}. Review a new release before updating the pin.`);
const { data, metadata } = JSON.parse(Buffer.from(bytes).toString('utf8'));
if (metadata.version !== '1.2.5.0' || metadata.buildId !== '26281294' || metadata.ficsmas) throw new Error('Unexpected source game version');
const rows = Object.values(data.recipes).filter(r => !r.inBuildGun && r.producedIn.length);
const machineIds = new Set(rows.flatMap(r => r.producedIn));
const machineById = Object.fromEntries([...machineIds].map(id => [id, data.buildings[id]]));
const items = Object.values(data.items).map(item => ({
  id: item.className, name: item.name, form: item.form,
  unit: item.form === 'solid' ? 'items' : 'm³',
  resource: data.resources.includes(item.className),
})).sort((a, b) => a.name.localeCompare(b.name, 'en'));
const machines = [...machineIds].map(id => {
  const m = machineById[id];
  return {
    id, name: m.name, powerMW: m.powerUsage, powerExponent: m.powerUsageExponent,
    manufacturingSpeed: m.manufacturingSpeed, canOverclock: m.canOverclock,
    minClockPercent: 1, maxClockPercent: m.canOverclock ? 250 : 100,
    sloopSlots: m.sloopSlots, sloopBoost: m.sloopBoost,
    footprintVerified: false,
  };
}).sort((a, b) => a.name.localeCompare(b.name, 'en'));
const recipes = rows.map(r => {
  if (r.producedIn.length !== 1) throw new Error(`Review multi-machine recipe ${r.className}`);
  const m = machineById[r.producedIn[0]];
  // The source exporter has ALREADY converted liquid/gas recipe quantities to cubic metres.
  const amount = a => ({ itemId: a.item, amount: a.amount });
  const variable = r.variablePowerDraw && m.powerUsage === 0;
  const min = variable ? r.variablePowerDrawConstant : m.powerUsage;
  const max = variable ? r.variablePowerDrawConstant + r.variablePowerDrawFactor : m.powerUsage;
  return {
    id: r.className, name: r.name, machineId: m.className, durationSeconds: r.time,
    ingredients: r.ingredients.map(amount), products: r.products.map(amount), alternate: r.alternate,
    powerMW: (min + max) / 2, powerMinMW: min, powerMaxMW: max,
  };
}).sort((a, b) => a.name.localeCompare(b.name, 'en'));
const beltIds = Array.from({length: 6}, (_, i) => `Desc_ConveyorBeltMk${i + 1}_C`);
const pipeIds = ['Desc_Pipeline_C', 'Desc_PipelineMK2_C'];
const transport = {
  belts: beltIds.map((id, i) => {
    const b = data.buildings[id];
    const rate = b.description.match(/up to (\d+)\s+resources per minute/);
    if (!rate) throw new Error(`Capacity not found for ${id}`);
    return { id, name: b.name, tier: i + 1, capacity: Number(rate[1]), unit: 'items/min' };
  }),
  pipes: pipeIds.map((id, i) => {
    const p = data.buildings[id];
    const rate = p.description.match(/Capacity:\s*(\d+)\s*m³/);
    if (!rate) throw new Error(`Capacity not found for ${id}`);
    return { id, name: p.name, tier: i + 1, capacity: Number(rate[1]), unit: 'm³/min' };
  }),
};
const extractors = ['Desc_MinerMk1_C', 'Desc_MinerMk2_C', 'Desc_MinerMk3_C', 'Desc_OilPump_C', 'Desc_WaterPump_C'].map(id => {
  const b = data.buildings[id];
  // Water Pump has no machine-readable extraction-rate fields in this export. Its shipped description states 120m³/min.
  const sourceRate = id === 'Desc_WaterPump_C' ? 120 : 60 * b.miningRatePerCycle / b.miningCycleLength / (id === 'Desc_OilPump_C' ? 1000 : 1);
  return { id, name: b.name, powerMW: b.powerUsage, powerExponent: b.powerUsageExponent, baseRate: sourceRate,
    unit: id.includes('Miner') ? 'items/min' : 'm³/min',
    resourceIds: id.includes('Miner') ? data.resources.filter(id => data.items[id].form === 'solid') : [id === 'Desc_OilPump_C' ? 'Desc_LiquidOil_C' : 'Desc_Water_C'],
    supportsPurity: id !== 'Desc_WaterPump_C', purityMultipliers: { impure: 0.5, normal: 1, pure: 2 },
  };
});
const normalized = {
  provenance: {
    gameVersion: metadata.version, steamBuildId: metadata.buildId, branch: metadata.branch,
    sourceName: 'Satisfactory Tools · game Docs export', sourceUrl: SOURCE_URL, sourceSha256: digest,
    importedAt: metadata.importedAt, verifiedAt: '2026-11-12',
    apiRepository: 'https://github.com/SatisfactoryTools/ToolsApi/tree/644ac72c9c5d98d62504e3adf49b5ff6361d8635',
    formulaSource: 'https://github.com/SatisfactoryTools/SFTools/blob/f214061425aff679ff6e545e4a0c2ff1333f7ff0/src/app/Model/Planner/Formulas.ts',
    license: 'MIT (Satisfactory Tools); game names and data belong to Coffee Stain Studios',
    ficsmas: false, recipeAmountUnits: 'items for solids; m³ for liquids and gases; per cycle',
    layout: 'Schematic only: physical building footprints and connector coordinates are not present in the source export.',
    exclusions: ['FICSMAS', 'Handcraft-only recipes', 'Equipment-workshop-only recipes', 'Build-gun recipes', 'Fluid head-lift and pressure simulation', 'Train/truck/drone routing'],
  },
  items, recipes, machines, transport, extractors,
};
const itemIds = new Set(items.map(i => i.id));
for (const r of recipes) {
  if (!(r.durationSeconds > 0)) throw new Error(`Invalid recipe time ${r.id}`);
  for (const a of [...r.ingredients, ...r.products]) {
    if (!itemIds.has(a.itemId) || !Number.isFinite(a.amount) || a.amount <= 0) throw new Error(`Invalid recipe quantity ${r.id}`);
  }
}
if (recipes.length !== 276 || machines.length !== 11 || items.length !== 175) throw new Error('Unexpected source coverage; review import');
const destination = new URL('../app/factory/data/satisfactory-1.2.json', import.meta.url);
await mkdir(new URL('../app/factory/data/', import.meta.url), { recursive: true });
await writeFile(destination, `${JSON.stringify(normalized)}\n`);
console.log(`${recipes.length} recipes, ${items.length} items, ${machines.length} production machines → ${fileURLToPath(destination)}`);
