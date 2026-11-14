import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export * from './app/factory/production.ts'; export {catalog,recipeRates,machineById,transportCapacity} from './app/factory/engine.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { solveProductionPlan, validateProductionRequest, catalog, recipeRates, transportCapacity } = api;
const ids = { ore:'Desc_OreIron_C', ingot:'Desc_IronIngot_C', plate:'Desc_IronPlate_C', rod:'Desc_IronRod_C', screw:'Desc_IronScrew_C', reinforced:'Desc_IronPlateReinforced_C' };
const near = (actual, expected, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const rate = (list, itemId) => list.find(i => i.itemId === itemId)?.rate ?? 0;
const only = (...recipes) => catalog.recipes.filter(r => !recipes.includes(r.id)).map(r => r.id);
const solve = (itemId, output, extra = {}) => solveProductionPlan({ outputs:[{itemId,rate:output}], ...extra });
function conserved(plan) {
  assert.equal(plan.status, 'optimal', plan.message);
  for (const b of plan.balances) near(b.produced + b.external, b.consumed + b.requested + b.surplus, 0.001);
  for (const t of plan.transports) assert.ok(t.lines * t.capacity >= t.rate - 0.001);
  for (const r of plan.recipes) {
    const unit = recipeRates(r.recipeId, r.clock, undefined, r.sloops);
    assert.ok(r.machineCount >= r.exactMachines - 1e-6);
    assert.ok(r.clock >= 1 && r.clock <= 250 && r.lastClock >= 1 && r.lastClock <= r.clock);
    assert.ok(Number.isFinite(r.powerMW) && r.powerMW >= 0);
    for (const side of ['inputs','outputs']) for (const p of r[side]) near(p.rate, unit[side].find(i => i.itemId === p.itemId).rate * r.exactMachines, 0.001);
  }
}

test('60 iron plates/min expands all the way to 90 ore, 3 smelters, 3 constructors and 24 MW', () => {
  const p = solve(ids.plate, 60); conserved(p);
  near(rate(p.resources, ids.ore), 90);
  assert.equal(p.recipes.find(r => r.recipeId === 'Recipe_IngotIron_C').machineCount, 3);
  assert.equal(p.recipes.find(r => r.recipeId === 'Recipe_IronPlate_C').machineCount, 3);
  near(p.totals.powerMW, 24); assert.equal(p.totals.machines, 6);
});

test('reinforced plate benchmark retains intermediate sharing and realistic partial machines', () => {
  const p = solve(ids.reinforced, 5); conserved(p);
  near(rate(p.resources, ids.ore), 60);
  near(p.balances.find(b => b.itemId === ids.plate).consumed, 30);
  near(p.balances.find(b => b.itemId === ids.screw).consumed, 60);
  assert.equal(p.totals.machines, 8);
  const plates = p.recipes.find(r => r.recipeId === 'Recipe_IronPlate_C');
  assert.equal(plates.machineCount, 2); near(plates.lastClock, 50);
});

test('multiple outputs share upstream production without double counting', () => {
  const p = solveProductionPlan({outputs:[{itemId:ids.plate,rate:20},{itemId:ids.rod,rate:15}]}); conserved(p);
  near(rate(p.resources, ids.ore), 45);
  const smelt = p.recipes.find(r=>r.recipeId==='Recipe_IngotIron_C');
  near(smelt.exactMachines,1.5); assert.equal(smelt.machineCount,2);
});

test('maximize preserves output ratios and enforces supplied intermediate cap', () => {
  const p = solveProductionPlan({outputs:[{itemId:ids.plate,rate:1},{itemId:ids.rod,rate:1}],inputs:[{itemId:ids.ingot,rate:60}],mode:'maximize'}); conserved(p);
  near(rate(p.products,ids.plate),24); near(rate(p.products,ids.rod),24);
  near(rate(p.externalInputs,ids.ingot),60); assert.deepEqual(p.resources,[]);
});

test('zero and insufficient resource caps return infeasible rather than imaginary input', () => {
  for(const supply of [0,29.99]) assert.equal(solve(ids.plate,20,{inputs:[{itemId:ids.ore,rate:supply}],capInputs:true}).status,'infeasible');
  const p = solve(ids.plate,20,{inputs:[{itemId:ids.ore,rate:15}],capInputs:false}); conserved(p);
  near(rate(p.resources,ids.ore),15); near(rate(p.externalInputs,ids.ore),15);
  assert.equal(solve(ids.plate,1,{mode:'maximize'}).status,'unbounded');
  assert.equal(solve(ids.plate,1,{resourcePolicy:'closed'}).status,'infeasible');
});

test('a recipe override enforces Cast Screws and removes the rod step', () => {
  const cast = catalog.recipes.find(r => r.name === 'Alternate: Cast Screws');
  assert.ok(cast);
  const p = solve(ids.screw,50,{inputs:[{itemId:ids.ingot,rate:12.5}],recipeOverrides:{[ids.screw]:cast.id}}); conserved(p);
  assert.equal(p.recipes.length,1); assert.equal(p.recipes[0].recipeId,cast.id);
  near(rate(p.externalInputs,ids.ingot),12.5);
});

test('crude-oil byproduct is accounted for and cannot disappear', () => {
  const p = solve('Desc_Plastic_C',20,{excludedRecipes:only('Recipe_Plastic_C')}); conserved(p);
  near(rate(p.resources,'Desc_LiquidOil_C'),30);
  near(rate(p.surplus,'Desc_HeavyOilResidue_C'),10);
  assert.ok(p.warnings.some(s => s.includes('surplus')));
});

test('aluminium recycles 30 water and imports net 60 instead of dumping return flow', () => {
  const p = solve('Desc_AluminumIngot_C',60,{excludedRecipes:only('Recipe_AluminaSolution_C','Recipe_AluminumScrap_C','Recipe_IngotAluminum_C','Recipe_Silica_C')}); conserved(p);
  near(rate(p.resources,'Desc_Water_C'),60);
  near(rate(p.resources,'Desc_OreBauxite_C'),60);
  near(rate(p.resources,'Desc_Coal_C'),30);
  near(rate(p.resources,'Desc_RawQuartz_C'),30);
  const water = p.balances.find(b=>b.itemId==='Desc_Water_C'); near(water.produced,30); near(water.consumed,90); near(water.surplus,0);
  assert.ok(p.warnings.some(s=>s.includes('recycles')));
});

test('coupled recycled-plastic/rubber loop solves simultaneous balances with a fuel cap', () => {
  const plastic = 'Recipe_Alternate_Plastic_1_C', rubber = 'Recipe_Alternate_RecycledRubber_C';
  const p = solve('Desc_Plastic_C',60,{inputs:[{itemId:'Desc_LiquidFuel_C',rate:60}],allowedAlternates:[plastic,rubber],excludedRecipes:only(plastic,rubber)}); conserved(p);
  near(p.recipes.find(r=>r.recipeId===plastic).exactMachines,4/3);
  near(p.recipes.find(r=>r.recipeId===rubber).exactMachines,2/3);
  near(rate(p.externalInputs,'Desc_LiquidFuel_C'),60); assert.deepEqual(p.resources,[]);
});

test('selected belt tier caps individual machine clocks before calculating machine count', () => {
  const p = solve(ids.screw,100,{inputs:[{itemId:ids.rod,rate:25}],clock:250,beltTier:1}); conserved(p);
  const r = p.recipes[0]; near(r.clock,150); assert.equal(r.machineCount,2); near(r.lastClock,100); assert.equal(r.clockLimited,true);
  for(const port of recipeRates(r.recipeId,r.clock).outputs) assert.ok(port.rate <= transportCapacity('belt',1));
});

test('per-recipe clocks, Somersloops and real partial-machine power remain independent', () => {
  const p = solve(ids.plate,60,{recipeClocks:{Recipe_IronPlate_C:250},sloops:{Recipe_IronPlate_C:1}}); conserved(p);
  const plate = p.recipes.find(r=>r.recipeId==='Recipe_IronPlate_C');
  near(plate.exactMachines,0.6); near(plate.lastClock,150); assert.equal(plate.machineCount,1); assert.equal(plate.sloops,1); assert.equal(plate.powerShards,1);
  near(rate(p.resources,ids.ore),45); near(plate.powerMW,recipeRates('Recipe_IronPlate_C',150,undefined,1).powerMW);
});
test('automatic Somersloops can underclock to fit a slower output belt', () => {
  const p = solve(ids.screw, 50, { inputs: [{ itemId: ids.rod, rate: 12.5 }], capInputs: true, beltTier: 1, somersloopBudget: 1, excludedRecipes: only('Recipe_Screw_C') });
  conserved(p);
  assert.equal(p.totals.somersloops, 1);
  assert.equal(p.totals.machines, 1);
  near(p.recipes[0].clock, 75);
  near(p.recipes[0].lastClock, 62.5);
  near(rate(p.externalInputs, ids.rod), 6.25);
  near(rate(p.products, ids.screw), 50);
});

test('tiny outputs explicitly require intermittent operation below the minimum clock', () => {
  const p = solve(ids.plate,0.001); conserved(p);
  assert.ok(p.recipes.every(r=>r.lastClock===1 && r.dutyCycle<1));
  assert.ok(p.warnings.some(s=>s.includes('intermittent')));
});

test('invalid identifiers, non-finite values and unsupported settings fail before optimization', () => {
  for(const request of [
    {outputs:[]}, {outputs:[{itemId:'__proto__',rate:1}]}, {outputs:[{itemId:ids.plate,rate:Infinity}]},
    {outputs:[{itemId:ids.plate,rate:1}],clock:0}, {outputs:[{itemId:ids.plate,rate:1}],sloops:{Recipe_IronPlate_C:2}},
    {outputs:[{itemId:ids.plate,rate:1}],recipeOverrides:{[ids.plate]:'Recipe_IronRod_C'}},
  ]) { assert.equal(solveProductionPlan(request).status,'error'); assert.throws(()=>validateProductionRequest(request)); }
});

test('each optimization mode conserves a complex multi-output plan', () => {
  for(const optimization of ['resources','power','buildings']) {
    const p=solveProductionPlan({outputs:[{itemId:'Desc_Motor_C',rate:5},{itemId:'Desc_SteelPlateReinforced_C',rate:4}],optimization}); conserved(p);
    assert.ok(p.totals.machines>0 && p.totals.powerMW>0);
  }
});

test('selected output alternate is forced and never borrows a ghost rubber input', () => {
  const p=solve(ids.reinforced,5,{allowedAlternates:['Recipe_Alternate_AdheredIronPlate_C']}); conserved(p);
  assert.ok(p.recipes.some(r=>r.recipeId==='Recipe_Alternate_AdheredIronPlate_C'));
  assert.ok(!p.recipes.some(r=>r.recipeId==='Recipe_IronPlateReinforced_C'));
  const rubber=p.balances.find(b=>b.itemId==='Desc_Rubber_C');
  assert.ok(rubber && rubber.consumed>0); near(rubber.produced+rubber.external,rubber.consumed+rubber.surplus,1e-7);
});

test('maximize uses residual inputs for extra outputs after the shared-ratio stage', () => {
  const p=solveProductionPlan({outputs:[{itemId:ids.plate,rate:1},{itemId:'Desc_Wire_C',rate:1}],inputs:[{itemId:ids.ore,rate:60},{itemId:'Desc_OreCopper_C',rate:30}],mode:'maximize'}); conserved(p);
  near(p.multiplier,40); near(rate(p.products,ids.plate),40); near(rate(p.products,'Desc_Wire_C'),60);
  near(rate(p.externalInputs,'Desc_OreCopper_C'),30);
});

test('unbounded residual enrichment falls back to the bounded common ratio', () => {
  const p=solveProductionPlan({outputs:[{itemId:ids.plate,rate:1},{itemId:'Desc_Wire_C',rate:1}],inputs:[{itemId:ids.ore,rate:60}],mode:'maximize'}); conserved(p);
  near(rate(p.products,ids.plate),40); near(rate(p.products,'Desc_Wire_C'),40);
  assert.ok(p.warnings.some(w=>w.includes('Extra output is unbounded')));
});

test('minimum accepted output is normalized before solving and still conserves material', () => {
  const p=solve(ids.plate,0.000001); conserved(p);
  near(rate(p.resources,ids.ore),0.0000015,1e-10);
  near(p.balances.find(b=>b.itemId===ids.plate).produced,0.000001,1e-10);
  for (const line of p.transports) assert.ok(line.lines >= 1, `${line.itemId} needs a physical transport line even at a tiny rate`);
});

test('all-alternate converter network resolves a previously degenerate dark-matter target', () => {
  const p=solve('Desc_DarkMatter_C',1,{allowedAlternates:catalog.recipes.filter(r=>r.alternate).map(r=>r.id),allowedConverters:catalog.recipes.filter(r=>r.machineId==='Desc_Converter_C').map(r=>r.id)}); conserved(p);
  for(const b of p.balances) assert.ok(b.produced+b.external>=b.consumed+b.requested-1e-6);
});

