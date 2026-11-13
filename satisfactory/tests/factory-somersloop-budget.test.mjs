import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const bundle=await build({stdin:{contents:`export * from './app/factory/production.ts'; export {catalog,recipeRates} from './app/factory/engine.ts';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {solveProductionPlan,validateProductionRequest,catalog,recipeRates}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const near=(a,b,e=1e-5)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
const only=(...ids)=>catalog.recipes.filter(r=>!ids.includes(r.id)).map(r=>r.id);
function verify(plan,stock){
  assert.equal(plan.status,'optimal',plan.message);
  assert.ok(plan.totals.somersloops<=stock);
  let used=0;
  assert.equal(new Set(plan.recipes.map(r=>r.recipeId)).size,plan.recipes.length);
  for(const row of plan.recipes){
    let rowUsed=0, machines=0, power=0;
    for(const v of row.variants){
      assert.ok(Number.isInteger(v.machineCount)&&Number.isInteger(v.sloops));
      rowUsed+=v.machineCount*v.sloops; machines+=v.machineCount;power+=v.powerMW;
      const unit=recipeRates(row.recipeId,v.clock,undefined,v.sloops);
      for(const side of ['inputs','outputs']) for(const material of v[side]) near(material.rate,unit[side].find(p=>p.itemId===material.itemId).rate*v.exactMachines);
      if(v.sloops>0) assert.ok(v.clock<=100 && v.lastClock<=100);
    }
    near(row.totalSomersloops,rowUsed);near(row.machineCount,machines);near(row.powerMW,power);used+=rowUsed;
    for(const side of ['inputs','outputs'])for(const item of row[side])near(item.rate,row.variants.reduce((sum,v)=>sum+(v[side].find(i=>i.itemId===item.itemId)?.rate??0),0));
  }
  near(plan.totals.somersloops,used);
  for(const b of plan.balances)near(b.produced+b.external,b.consumed+b.requested+b.surplus,0.001);
}
test('one global Somersloop amplifies one of two constructors, not every machine in its recipe',()=>{
  const p=solveProductionPlan({outputs:[{itemId:'Desc_IronPlate_C',rate:60}],somersloopBudget:1});verify(p,1);
  near(p.resources.find(r=>r.itemId==='Desc_OreIron_C').rate,60);
  const plates=p.recipes.find(r=>r.recipeId==='Recipe_IronPlate_C');
  assert.equal(plates.variants.length,2);assert.equal(plates.totalSomersloops,1);assert.equal(plates.machineCount,2);
});
test('zero budget overrides manual boosts and reproduces the unamplified factory',()=>{
  const p=solveProductionPlan({outputs:[{itemId:'Desc_IronPlate_C',rate:60}],somersloopBudget:0,sloops:{Recipe_IronPlate_C:1}});verify(p,0);
  near(p.resources.find(r=>r.itemId==='Desc_OreIron_C').rate,90);assert.equal(p.totals.machines,6);
});
test('an odd three-item budget uses whole Manufacturer slots without fractional inventory',()=>{
  const recipe=catalog.recipes.find(r=>r.name==='Heavy Modular Frame'&&!r.alternate);assert.ok(recipe);
  const unit=recipeRates(recipe.id);
  const p=solveProductionPlan({outputs:[{itemId:recipe.products[0].itemId,rate:5}],inputs:unit.inputs.map(p=>({...p,rate:p.rate*10})),capInputs:true,excludedRecipes:only(recipe.id),somersloopBudget:3});verify(p,3);
  assert.ok(p.totals.somersloops>0);assert.equal(p.recipes[0].machineCount,2);
});
test('partial boosted machines consume a whole Somersloop and do not exceed tiny budgets',()=>{
  const p=solveProductionPlan({outputs:[{itemId:'Desc_IronPlate_C',rate:1}],somersloopBudget:1});verify(p,1);
  assert.equal(p.totals.somersloops,1);
  assert.ok(p.recipes.some(r=>r.variants.some(v=>v.sloops>0 && v.exactMachines<1)));
});
test('recycling under an automatic budget conserves both directions and fuel',()=>{
  const plastic='Recipe_Alternate_Plastic_1_C',rubber='Recipe_Alternate_RecycledRubber_C';
  const p=solveProductionPlan({outputs:[{itemId:'Desc_Plastic_C',rate:60}],inputs:[{itemId:'Desc_LiquidFuel_C',rate:60}],capInputs:true,allowedAlternates:[plastic,rubber],excludedRecipes:only(plastic,rubber),somersloopBudget:1});verify(p,1);
  assert.ok(p.warnings.some(w=>w.includes('recycles')));
});
test('port capacity removes impossible automatic amplification variants',()=>{
  const p=solveProductionPlan({outputs:[{itemId:'Desc_IronScrew_C',rate:80}],inputs:[{itemId:'Desc_IronRod_C',rate:20}],capInputs:true,excludedRecipes:only('Recipe_Screw_C'),beltTier:1,somersloopBudget:1});verify(p,1);
  assert.equal(p.totals.somersloops,0);assert.equal(p.totals.machines,2);
});
test('shard inventory starts automatic amplified groups at baseline clocks',()=>{
  const p=solveProductionPlan({outputs:[{itemId:'Desc_IronPlate_C',rate:60}],clock:250,powerShardBudget:0,somersloopBudget:1});verify(p,1);
  assert.equal(p.totals.powerShards,0);assert.ok(p.recipes.every(r=>r.variants.every(v=>v.clock<=100)));
});
test('maximum output with whole amplification stays within supplied material and boost stock',()=>{
  const p=solveProductionPlan({outputs:[{itemId:'Desc_IronPlate_C',rate:1}],inputs:[{itemId:'Desc_OreIron_C',rate:30}],mode:'maximize',somersloopBudget:2});verify(p,2);
  near(p.products[0].rate,60);near(p.externalInputs[0].rate,30);
});
test('invalid inventory values are rejected before allocation',()=>{
  for(const stock of [-1,0.5,Infinity,10001])assert.throws(()=>validateProductionRequest({outputs:[{itemId:'Desc_IronPlate_C',rate:1}],somersloopBudget:stock}));
});
test('complex budget search returns a bounded verified plan and preserves integer inventory',()=>{
  const start=performance.now();
  const p=solveProductionPlan({outputs:[{itemId:'Desc_Motor_C',rate:10},{itemId:'Desc_ModularFrameHeavy_C',rate:2}],somersloopBudget:5});
  verify(p,5);assert.ok(performance.now()-start<5000);
});
