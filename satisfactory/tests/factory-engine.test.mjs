import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ stdin: { contents: `export * from './app/factory/engine.ts'; export * from './app/factory/validation.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { recipeRates, extractorRates, extractorById, getNodePorts, targetPlan, calculateFactory, validateFactoryLayout, createEmptyFactoryLayout, catalog, machineById, transportCapacity } = api;
const ironOre = 'Desc_OreIron_C', iron = 'Desc_IronIngot_C', plate = 'Desc_IronPlate_C', screw = 'Desc_IronScrew_C';
const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const node = (id, kind, extra = {}) => ({ id, kind, x: 0, y: 0, rotation: 0, ...extra });
const source = (id, itemId, rate) => node(id, 'source', { itemId, rate });
const sink = (id, itemId, rate) => node(id, 'sink', { itemId, rate });
const machine = (id, recipeId, clock = 100) => node(id, 'machine', { recipeId, clock });
const extractor = (id, extractorId = 'Desc_MinerMk1_C', itemId = ironOre, clock = 100, purity = 'normal') => node(id, 'extractor', { extractorId, itemId, clock, purity });
const edge = (id, from, to, itemId, fromPort = 'out:0', toPort = 'in:0', tier = 1, transport = 'belt') => ({ id, from, to, itemId, fromPort, toPort, tier, transport });
const layout = (nodes, edges) => validateFactoryLayout({ ...createEmptyFactoryLayout(), nodes, edges });
const run = (nodes, edges) => calculateFactory(layout(nodes, edges));
const smelt = (supply = 30, clock = 100, tier = 1) => run([source('ore', ironOre, supply), machine('smelter', 'Recipe_IngotIron_C', clock), sink('iron', iron, 1000)], [edge('a', 'ore', 'smelter', ironOre, 'out:0', `in:${ironOre}`, tier), edge('b', 'smelter', 'iron', iron, `out:${iron}`, 'in:0', tier)]);
function assertConservation(data, result) {
    assert.equal(result.supported, true, JSON.stringify(result.issues));
    for (const e of data.edges) {
        const n = result.edges[e.id];
        assert.ok(n.rate >= 0);
        assert.ok(n.rate <= n.capacity + 1e-5);
    }
    for (const n of data.nodes) {
        const r = result.nodes[n.id];
        assert.ok(Number.isFinite(r.utilization));
        if (n.kind === 'machine') {
            for (const p of r.inputs)
                near(r.actualInputs.find(x => x.itemId === p.itemId)?.rate ?? 0, p.rate * r.utilization);
            for (const p of r.outputs)
                near(r.actualOutputs.find(x => x.itemId === p.itemId)?.rate ?? 0, p.rate * r.utilization);
        }
        else if (n.kind.includes('splitter') || n.kind === 'merger')
            near(r.actualInputs.reduce((s, p) => s + p.rate, 0), r.actualOutputs.reduce((s, p) => s + p.rate, 0));
    }
}
test('pinned 1.2 recipes, belt and pipe capacities retain source units', () => {
    assert.equal(catalog.provenance.gameVersion, '1.2.5.0');
    const basic = recipeRates('Recipe_IngotIron_C');
    near(basic.inputs[0].rate, 30);
    near(basic.outputs[0].rate, 30);
    near(basic.powerMW, 4);
    const plates = recipeRates('Recipe_IronPlate_C');
    near(plates.inputs[0].rate, 30);
    near(plates.outputs[0].rate, 20);
    const rods = recipeRates('Recipe_IronRod_C');
    near(rods.inputs[0].rate, 15);
    near(rods.outputs[0].rate, 15);
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(t => transportCapacity('belt', t)), [60, 120, 270, 480, 780, 1200]);
    assert.deepEqual([1, 2].map(t => transportCapacity('pipe', t)), [300, 600]);
    const alumina = recipeRates('Recipe_AluminaSolution_C');
    near(alumina.inputs.find(x => x.itemId === 'Desc_Water_C').rate, 180);
    near(alumina.outputs.find(x => x.itemId === 'Desc_AluminaSolution_C').rate, 120);
});
test('clock, recipe-cost, power setting and Somersloops use independent game formulas', () => {
    const normal = recipeRates('Recipe_IronPlate_C'), high = recipeRates('Recipe_IronPlate_C', 250, { recipeMultiplier: 2, powerMultiplier: 0.5 }, 1);
    near(high.inputs[0].rate, normal.inputs[0].rate * 2.5 * 2);
    near(high.outputs[0].rate, normal.outputs[0].rate * 2.5 * 2);
    near(high.powerMW, 4 * Math.pow(2.5, machineById.Desc_ConstructorMk1_C.powerExponent) * 4 * 0.5);
    near(recipeRates('Recipe_IronPlate_C', 1).outputs[0].rate, 0.2);
    assert.throws(() => recipeRates('Recipe_IronPlate_C', 0));
    assert.throws(() => recipeRates('Recipe_IronPlate_C', 251));
    assert.throws(() => recipeRates('Recipe_IronPlate_C', 100, undefined, 2));
    assert.throws(() => recipeRates('Recipe_IronPlate_C', 100, { recipeMultiplier: NaN, powerMultiplier: 1 }));
});
test('target planner computes integer machines and accurately underclocks last machine', () => {
    const p = targetPlan('Recipe_IngotIron_C', iron, 45);
    assert.equal(p.machineCount, 2);
    near(p.exactMachines, 1.5);
    near(p.lastClock, 50);
    near(p.outputs[0].rate, 45);
    near(p.powerMW, 4 + 4 * Math.pow(0.5, 1.321929));
    assert.equal(p.minimumClockLimited, false);
    const tiny = targetPlan('Recipe_IngotIron_C', iron, 0.000000001);
    assert.equal(tiny.machineCount, 1);
    assert.equal(tiny.minimumClockLimited, true);
    near(tiny.achievedRate, 0.3);
    assert.ok(tiny.achievedRate > tiny.requestedRate);
});
test('recipe cost rounds solid items per cycle and fluid raw litres before calculating per-minute demand', () => {
    const plates = recipeRates('Recipe_IronPlate_C', 100, { recipeMultiplier: 0.5, powerMultiplier: 1 });
    // 3 ingots per cycle × 0.5 rounds to 2, with 10 cycles/min.
    near(plates.inputs[0].rate, 20);
    near(plates.outputs[0].rate, 20);
    const rocket = recipeRates('Recipe_RocketFuel_C', 100, { recipeMultiplier: 0.333333, powerMultiplier: 1 });
    const normal = recipeRates('Recipe_RocketFuel_C');
    // One m³ nitric acid is 1000 raw litres: 333.333 rounds to 333 litres.
    near(rocket.inputs.find(i=>i.itemId==='Desc_NitricAcid_C').rate, normal.inputs.find(i=>i.itemId==='Desc_NitricAcid_C').rate * 0.333);
});
test('target planner rounds fractional clocks upward instead of missing requested output', () => {
    const target = 10.000001;
    const plan = targetPlan('Recipe_IngotIron_C', iron, target);
    assert.ok(plan.achievedRate >= target);
    assert.ok(plan.achievedRate - target < 0.000031);
    assert.throws(() => targetPlan('Recipe_IngotIron_C', iron, Number.MAX_VALUE), /too large/);
});
test('all miner tiers, purities and clocks retain extraction and power formulas', () => {
    for (const [id, baseRate, power] of [['Desc_MinerMk1_C', 60, 5], ['Desc_MinerMk2_C', 120, 15], ['Desc_MinerMk3_C', 240, 45]]) {
        for (const [purity, multiplier] of [['impure', 0.5], ['normal', 1], ['pure', 2]]) {
            for (const clock of [1, 100, 250]) {
                const rates = extractorRates(id, ironOre, clock, purity, { recipeMultiplier: 2, powerMultiplier: 0.5 });
                near(rates.outputs[0].rate, baseRate * multiplier * clock / 100);
                near(rates.powerMW, power * Math.pow(clock / 100, extractorById[id].powerExponent) * 0.5);
                assert.deepEqual(rates.inputs, []);
            }
        }
    }
    near(extractorRates('Desc_MinerMk3_C', ironOre, 250, 'pure').outputs[0].rate, 1200);
    assert.throws(() => extractorRates('Desc_MinerMk1_C', 'Desc_Water_C'), /resource/);
    assert.throws(() => extractorRates('missing', ironOre), /Unknown/);
    assert.throws(() => extractorRates('Desc_MinerMk1_C', ironOre, 251), /Clock/);
    assert.throws(() => extractorRates('Desc_MinerMk1_C', ironOre, 100, 'rich'), /purity/);
});
test('oil and water extraction use cubic metres and correct pipe ports', () => {
    near(extractorRates('Desc_OilPump_C', 'Desc_LiquidOil_C', 250, 'pure').outputs[0].rate, 600);
    near(extractorRates('Desc_WaterPump_C', 'Desc_Water_C', 250).outputs[0].rate, 300);
    assert.throws(() => extractorRates('Desc_WaterPump_C', 'Desc_Water_C', 100, 'pure'), /purity/);
    assert.deepEqual(getNodePorts(extractor('water', 'Desc_WaterPump_C', 'Desc_Water_C')), [{ id: 'out:0', direction: 'output', itemId: 'Desc_Water_C', medium: 'pipe' }]);
});
test('changing miner tiers changes network supply while belts still limit throughput', () => {
    for (const [id, expected, power] of [['Desc_MinerMk1_C', 60, 5], ['Desc_MinerMk2_C', 120, 15], ['Desc_MinerMk3_C', 240, 45]]) {
        const data = layout([extractor('miner', id), sink('store', ironOre, 1200)], [edge('belt', 'miner', 'store', ironOre, 'out:0', 'in:0', 3)]);
        const result = calculateFactory(data);
        assertConservation(data, result);
        near(result.edges.belt.rate, expected);
        near(result.totals.powerMW, power);
        near(result.totals.actualPowerMW, power);
        near(result.totals.inputs[0].rate, expected);
        const limited = calculateFactory({ ...data, edges: data.edges.map(e => ({ ...e, tier: 1 })) });
        near(limited.edges.belt.rate, 60);
        near(limited.nodes.miner.utilization, 60 / expected);
        near(limited.nodes.miner.actualPowerMW, power * 60 / expected);
    }
});
test('extractor connects through machines and round-trips without losing the selected tier', () => {
    const data = layout([extractor('miner', 'Desc_MinerMk2_C', ironOre, 50, 'impure'), machine('smelt', 'Recipe_IngotIron_C'), sink('out', iron, 30)], [edge('ore', 'miner', 'smelt', ironOre, 'out:0', `in:${ironOre}`), edge('iron', 'smelt', 'out', iron, `out:${iron}`)]);
    const saved = validateFactoryLayout(JSON.parse(JSON.stringify(data)));
    assert.equal(saved.nodes[0].extractorId, 'Desc_MinerMk2_C');
    assert.equal(saved.nodes[0].purity, 'impure');
    const result = calculateFactory(saved);
    near(result.edges.ore.rate, 30);
    near(result.edges.iron.rate, 30);
    near(result.totals.powerMW, 4 + 15 * Math.pow(0.5, extractorById.Desc_MinerMk2_C.powerExponent));
});
test('iron chain runs at exact nominal and supply-limited rates', () => {
    for (const [supply, expected] of [[30, 30], [15, 15], [0, 0]]) {
        const r = smelt(supply);
        assert.equal(r.supported, true);
        near(r.edges.a.rate, expected);
        near(r.edges.b.rate, expected);
        near(r.nodes.smelter.utilization, expected / 30);
        assert.ok(Number.isFinite(r.nodes.ore.utilization));
    }
});
test('belt bottleneck caps an overclocked machine', () => { const r = smelt(75, 250); near(r.edges.a.rate, 60); near(r.edges.b.rate, 60); near(r.nodes.smelter.utilization, 0.8); assert.ok(r.issues.some(i => i.code === 'transport-limit')); });
test('splitter distributes fairly then redistributes blocked demand', () => {
    for (const [supply, demands, expected] of [[90, [100, 100, 100], [30, 30, 30]], [90, [10, 100, 100], [10, 40, 40]], [240, [1000, 1000, 1000], [60, 90, 90]]]) {
        const nodes = [source('a', iron, supply), node('split', 'splitter', { itemId: iron }), ...demands.map((d, i) => sink(`s${i}`, iron, d))], edges = [edge('feed', 'a', 'split', iron, 'out:0', 'in:0', 3), ...demands.map((_, i) => edge(`e${i}`, 'split', `s${i}`, iron, `out:${i}`, 'in:0', i === 0 ? 1 : 2))];
        const data = layout(nodes, edges), result = calculateFactory(data);
        assertConservation(data, result);
        expected.forEach((value, i) => near(result.edges[`e${i}`].rate, value));
    }
});
test('merger takes equal input shares and redistributes supply shortages', () => {
    for (const [rates, expected] of [[[100, 100, 100], [20, 20, 20]], [[10, 100, 100], [10, 25, 25]]]) {
        const data = layout([...rates.map((r, i) => source(`s${i}`, iron, r)), node('merge', 'merger', { itemId: iron }), sink('out', iron, 60)], [...rates.map((_, i) => edge(`e${i}`, `s${i}`, 'merge', iron, 'out:0', `in:${i}`, 2)), edge('out', 'merge', 'out', iron)]);
        const result = calculateFactory(data);
        assertConservation(data, result);
        expected.forEach((v, i) => near(result.edges[`e${i}`].rate, v));
    }
});
test('combined split and merge preserves exact totals and clearly labels scheduling approximation', () => {
    const data = layout([source('a', iron, 100), source('b', iron, 100), node('split', 'splitter', { itemId: iron }), node('merge', 'merger', { itemId: iron }), sink('small', iron, 40), sink('large', iron, 100)], [edge('a', 'a', 'split', iron, 'out:0', 'in:0', 2), edge('b', 'b', 'merge', iron, 'out:0', 'in:1', 2), edge('branch', 'split', 'merge', iron, 'out:1', 'in:0', 2), edge('small', 'split', 'small', iron, 'out:0', 'in:0', 2), edge('large', 'merge', 'large', iron, 'out:0', 'in:0', 2)]);
    const result = calculateFactory(data);
    assertConservation(data, result);
    near(result.edges.small.rate, 40);
    near(result.edges.large.rate, 100);
    assert.ok(result.issues.some(i => i.code === 'junction-allocation'));
});
test('multiple ingredients throttle together without excess material consumption', () => {
    const data = layout([source('plates', plate, 30), source('screws', screw, 30), machine('assembler', 'Recipe_IronPlateReinforced_C'), sink('output', 'Desc_IronPlateReinforced_C', 5)], [edge('p', 'plates', 'assembler', plate, 'out:0', `in:${plate}`), edge('s', 'screws', 'assembler', screw, 'out:0', `in:${screw}`), edge('o', 'assembler', 'output', 'Desc_IronPlateReinforced_C', 'out:Desc_IronPlateReinforced_C')]);
    const result = calculateFactory(data);
    assertConservation(data, result);
    near(result.edges.p.rate, 15);
    near(result.edges.s.rate, 30);
    near(result.edges.o.rate, 2.5);
});
test('fluid outputs and solid byproducts are both required for continuous operation', () => {
    const data = layout([source('bauxite', 'Desc_OreBauxite_C', 120), source('water', 'Desc_Water_C', 180), machine('refinery', 'Recipe_AluminaSolution_C'), sink('solution', 'Desc_AluminaSolution_C', 120), sink('silica', 'Desc_Silica_C', 50)], [edge('b', 'bauxite', 'refinery', 'Desc_OreBauxite_C', 'out:0', 'in:Desc_OreBauxite_C', 2), edge('w', 'water', 'refinery', 'Desc_Water_C', 'out:0', 'in:Desc_Water_C', 1, 'pipe'), edge('a', 'refinery', 'solution', 'Desc_AluminaSolution_C', 'out:Desc_AluminaSolution_C', 'in:0', 1, 'pipe'), edge('s', 'refinery', 'silica', 'Desc_Silica_C', 'out:Desc_Silica_C')]);
    const result = calculateFactory(data);
    assertConservation(data, result);
    near(result.edges.w.rate, 180);
    near(result.edges.a.rate, 120);
    near(result.edges.s.rate, 50);
    const blocked = calculateFactory({ ...data, edges: data.edges.filter(e => e.id !== 's') });
    near(blocked.nodes.refinery.utilization, 0);
});
test('smart filters block non-matching ports without creating or losing items', () => {
    const data = layout([source('in', iron, 60), node('split', 'smart-splitter', { itemId: iron, filters: { 'out:0': 'none', 'out:1': iron } }), sink('a', iron, 60), sink('b', iron, 60)], [edge('feed', 'in', 'split', iron), edge('a', 'split', 'a', iron), edge('b', 'split', 'b', iron, 'out:1')]);
    const r = calculateFactory(data);
    assertConservation(data, r);
    near(r.edges.a.rate, 0);
    near(r.edges.b.rate, 60);
});
test('recycling cycles return explicit unsupported status, not invented rates', () => {
    const data = layout([node('a', 'splitter', { itemId: iron }), node('b', 'merger', { itemId: iron })], [edge('a', 'a', 'b', iron), edge('b', 'b', 'a', iron)]), r = calculateFactory(data);
    assert.equal(r.supported, false);
    assert.ok(r.issues.some(i => i.code === 'cycle'));
    assert.equal(r.edges.a.rate, 0);
});
test('a recycling loop does not disable independent production paths', () => {
    const data = layout([node('a', 'splitter', { itemId: iron }), node('b', 'merger', { itemId: iron }), source('ore', ironOre, 30), machine('smelt', 'Recipe_IngotIron_C'), sink('out', iron, 30)], [edge('a', 'a', 'b', iron), edge('b', 'b', 'a', iron), edge('supply', 'ore', 'smelt', ironOre, 'out:0', `in:${ironOre}`), edge('production', 'smelt', 'out', iron, `out:${iron}`)]);
    const result = calculateFactory(data);
    assert.equal(result.supported, false);
    assert.equal(result.nodes.a.status, 'unsupported');
    assert.equal(result.nodes.smelt.status, 'running');
    near(result.edges.production.rate, 30);
    near(result.totals.outputs[0].rate, 30);
    near(result.totals.actualPowerMW, 4);
});
test('validation rejects invalid or unsafe imported factory values', () => {
    const valid = layout([source('in', ironOre, 30), machine('m', 'Recipe_IngotIron_C')], [edge('x', 'in', 'm', ironOre, 'out:0', `in:${ironOre}`)]);
    const bad = change => { const data = structuredClone(valid); change(data); assert.throws(() => validateFactoryLayout(data), { name: 'FactoryValidationError' }); };
    bad(d => d.nodes[0].x = NaN);
    bad(d => d.nodes[0].rate = Infinity);
    bad(d => d.nodes[1].clock = 0);
    bad(d => d.nodes[1].recipeId = 'not-a-recipe');
    bad(d => d.nodes[0].id = '__proto__');
    bad(d => d.nodes.push(d.nodes[0]));
    bad(d => d.nodes[1].sloops = 999);
    bad(d => d.settings.recipeMultiplier = 0);
    bad(d => d.settings.powerMultiplier = 6);
    bad(d => d.secret = 'private');
    bad(d => d.edges[0].transport = 'pipe');
    bad(d => d.edges[0].itemId = iron);
    bad(d => d.edges[0].fromPort = 'in:0');
    bad(d => d.edges[0].tier = 7);
    bad(d => d.edges.push({ ...d.edges[0], id: 'other' }));
    bad(d => d.nodes = Array.from({ length: 251 }, (_, i) => source(`n${i}`, iron, 1)));
    assert.throws(() => validateFactoryLayout(null));
    assert.throws(() => validateFactoryLayout({ ...createEmptyFactoryLayout(), nodes: [node('smart', 'smart-splitter', { itemId: iron, filters: { 'out:0': 'overflow' } })] }));
    assert.throws(() => validateFactoryLayout({ ...createEmptyFactoryLayout(), nodes: [node('split', 'splitter', { itemId: 'Desc_Water_C' })] }));
});
test('medium branching layout computes off-thread-compatible serializable results within work budget', () => {
    const nodes = [], edges = [];
    for (let i = 0; i < 20; i++) {
        nodes.push(source(`a${i}`, iron, 120), node(`d${i}`, 'splitter', { itemId: iron }), sink(`b${i}`, iron, 60), sink(`c${i}`, iron, 60));
        edges.push(edge(`a${i}`, `a${i}`, `d${i}`, iron, 'out:0', 'in:0', 2), edge(`b${i}`, `d${i}`, `b${i}`, iron), edge(`c${i}`, `d${i}`, `c${i}`, iron, 'out:1'));
    }
    const data = layout(nodes, edges), result = calculateFactory(data);
    assertConservation(data, result);
    near(result.totals.outputs[0].rate, 2400);
    assert.doesNotThrow(() => JSON.stringify(result));
});

test('ore-to-ingot-to-rod-to-screw chain applies connected recipe ratios end to end', () => {
 const rod='Desc_IronRod_C';
 const data=layout([source('ore',ironOre,30),machine('smelt','Recipe_IngotIron_C'),machine('rod','Recipe_IronRod_C'),machine('screw','Recipe_Screw_C'),sink('output',screw,40)],[edge('a','ore','smelt',ironOre,'out:0',`in:${ironOre}`),edge('b','smelt','rod',iron,`out:${iron}`,`in:${iron}`),edge('c','rod','screw',rod,`out:${rod}`,`in:${rod}`),edge('d','screw','output',screw,`out:${screw}`)]);
 const r=calculateFactory(data);assertConservation(data,r);near(r.edges.a.rate,10);near(r.edges.b.rate,10);near(r.edges.c.rate,10);near(r.edges.d.rate,40);near(r.nodes.smelt.utilization,1/3);near(r.nodes.rod.utilization,2/3);near(r.nodes.screw.utilization,1);
});
