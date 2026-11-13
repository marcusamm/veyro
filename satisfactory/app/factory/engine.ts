import data from './data/satisfactory-1.2.json';
import type { FactoryCatalog, FactoryLayout, FactoryNode, FactorySettings, FactoryCalculation, MaterialRate, NodePort, FactoryIssue } from './types';
export const catalog = data as FactoryCatalog;
export const itemById = Object.fromEntries(catalog.items.map(item => [item.id, item]));
export const recipeById = Object.fromEntries(catalog.recipes.map(recipe => [recipe.id, recipe]));
export const machineById = Object.fromEntries(catalog.machines.map(machine => [machine.id, machine]));
const EPS = 1e-8;
const defaults = { recipeMultiplier: 1, powerMultiplier: 1 };
const clean = (value: number) => Math.abs(value) < EPS ? 0 : value;
export function transportCapacity(transport: 'belt' | 'pipe', tier: number): number { return (transport === 'belt' ? catalog.transport.belts : catalog.transport.pipes).find(t => t.tier === tier)?.capacity ?? 0; }
export function recipeRates(recipeId: string, clock = 100, settings: FactorySettings = defaults, sloops = 0) {
    const recipe = Object.hasOwn(recipeById, recipeId) ? recipeById[recipeId] : undefined;
    if (!recipe)
        throw Error('Unknown recipe.');
    if (!Number.isFinite(settings.recipeMultiplier) || settings.recipeMultiplier < 0.25 || settings.recipeMultiplier > 2 || !Number.isFinite(settings.powerMultiplier) || settings.powerMultiplier < 0.25 || settings.powerMultiplier > 5)
        throw Error('Recipe Cost must be 0.25–2× and Power must be 0.25–5×.');
    const machine = machineById[recipe.machineId];
    if (!Number.isFinite(clock) || clock < 1 || clock > 250)
        throw Error('Clock speed must be 1–250%.');
    clock = Math.round(clock * 10000) / 10000;
    if (!Number.isInteger(sloops) || sloops < 0 || sloops > (machine.sloopSlots ?? 0))
        throw Error('Invalid number of Somersloops.');
    const amplification = 1 + (machine.sloopBoost ?? 0) * sloops;
    const cycles = 60 / recipe.durationSeconds * (machine.manufacturingSpeed ?? 1) * clock / 100;
    const powerFactor = Math.pow(clock / 100, machine.powerExponent ?? 1.321929) * amplification ** 2 * settings.powerMultiplier;
    // Recipe-cost settings round each game-data ingredient amount before its
    // per-minute rate is calculated. Fluids are stored as m³ here but the game
    // rounds their raw litre amounts, so their minimum is 0.001 m³, not 1 m³.
    const adjustedAmount = (itemId: string, amount: number) => {
        const rawUnits = itemById[itemId]?.form === 'solid' ? 1 : 1000;
        return Math.max(1, Math.round(amount * rawUnits * settings.recipeMultiplier)) / rawUnits;
    };
    return { inputs: recipe.ingredients.map(i => ({ itemId: i.itemId, rate: adjustedAmount(i.itemId, i.amount) * cycles })), outputs: recipe.products.map(i => ({ itemId: i.itemId, rate: i.amount * cycles * amplification })), powerMW: (recipe.powerMW ?? machine.powerMW) * powerFactor, powerMinMW: (recipe.powerMinMW ?? recipe.powerMW ?? machine.powerMW) * powerFactor, powerMaxMW: (recipe.powerMaxMW ?? recipe.powerMW ?? machine.powerMW) * powerFactor };
}
export function targetPlan(recipeId: string, itemId: string, rate: number, clock = 100, settings: FactorySettings = defaults, sloops = 0) {
    if (!Number.isFinite(rate) || rate <= 0)
        throw Error('Target output must be positive.');
    const unit = recipeRates(recipeId, clock, settings, sloops), product = unit.outputs.find(p => p.itemId === itemId);
    clock = Math.round(clock * 10000) / 10000;
    if (!product)
        throw Error('This recipe does not produce that item.');
    const exactMachines = rate / product.rate, machineCount = Math.max(1, Math.ceil(exactMachines - 1e-10)), fraction = exactMachines - (machineCount - 1), lastClock = Math.round(Math.min(clock, Math.max(1, clock * fraction)) * 10000) / 10000;
    const whole = Math.max(0, machineCount - 1), last = recipeRates(recipeId, lastClock, settings, sloops);
    const combine = (list: MaterialRate[], lastList: MaterialRate[]) => list.map((value, index) => ({ itemId: value.itemId, rate: value.rate * whole + lastList[index].rate }));
    const achievedRate = product.rate * whole + last.outputs.find(p => p.itemId === itemId)!.rate;
    return { machineCount, exactMachines, lastClock, requestedRate: rate, achievedRate, minimumClockLimited: clock * fraction < 1 - EPS, inputs: combine(unit.inputs, last.inputs), outputs: combine(unit.outputs, last.outputs), powerMW: whole * unit.powerMW + last.powerMW, powerMinMW: whole * unit.powerMinMW + last.powerMinMW, powerMaxMW: whole * unit.powerMaxMW + last.powerMaxMW };
}
export function getNodeSize(node: FactoryNode): {
    width: number;
    length: number;
} {
    if (node.kind !== 'machine')
        return { width: node.kind === 'source' || node.kind === 'sink' ? 12 : 8, length: 8 };
    const r = recipeById[node.recipeId ?? ''];
    const count = r ? Math.max(r.ingredients.length, r.products.length) : 1;
    // Display units are schematic. Source data does not provide real footprints.
    return { width: 20, length: Math.max(12, count * 4) };
}
export function getNodePorts(node: FactoryNode): NodePort[] {
    const medium = (id: string) => itemById[id]?.form === 'solid' ? 'belt' as const : 'pipe' as const;
    if (node.kind === 'machine') {
        const recipe = recipeById[node.recipeId ?? ''];
        if (!recipe)
            return [];
        return [...recipe.ingredients.map(i => ({ id: 'in:' + i.itemId, direction: 'input' as const, itemId: i.itemId, medium: medium(i.itemId) })), ...recipe.products.map(i => ({ id: 'out:' + i.itemId, direction: 'output' as const, itemId: i.itemId, medium: medium(i.itemId) }))];
    }
    const itemId = node.itemId ?? '', port = (id: string, direction: 'input' | 'output'): NodePort => ({ id, direction, itemId, medium: medium(itemId) });
    if (node.kind === 'source')
        return [port('out:0', 'output')];
    if (node.kind === 'sink')
        return [port('in:0', 'input')];
    if (node.kind === 'merger')
        return [port('in:0', 'input'), port('in:1', 'input'), port('in:2', 'input'), port('out:0', 'output')];
    return [port('in:0', 'input'), port('out:0', 'output'), port('out:1', 'output'), port('out:2', 'output')];
}
// Two-phase simplex, using Bland-style stable tie breaking. This solves the
// steady-state constraints; no transport travel time or fluid pressure is implied.
class CalculationBudget {
    work = 0;
    spend(work: number) { this.work += work; if (this.work > 256000000)
        throw Error('This layout exceeds the calculation work limit. Split it into smaller connected production paths. Nominal recipe rates remain available.'); }
}
class LinearProgram {
    m: number;
    n: number;
    B: number[];
    N: number[];
    D: Float64Array[];
    constructor(A: number[][], b: number[], c: number[], private budget: CalculationBudget) {
        budget.spend((b.length + 2) * (c.length + 2));
        this.m = b.length;
        this.n = c.length;
        this.B = Array(this.m);
        this.N = Array(this.n + 1);
        this.D = Array.from({ length: this.m + 2 }, () => new Float64Array(this.n + 2));
        for (let i = 0; i < this.m; i++) {
            for (let j = 0; j < this.n; j++)
                this.D[i][j] = A[i][j] || 0;
            this.B[i] = this.n + i;
            this.D[i][this.n] = -1;
            this.D[i][this.n + 1] = b[i];
        }
        for (let j = 0; j < this.n; j++) {
            this.N[j] = j;
            this.D[this.m][j] = -c[j];
        }
        this.N[this.n] = -1;
        this.D[this.m + 1][this.n] = 1;
    }
    pivot(r: number, s: number) { this.budget.spend((this.m + 2) * (this.n + 2)); const inv = 1 / this.D[r][s]; for (let i = 0; i < this.m + 2; i++)
        if (i !== r) {
            const coefficient = this.D[i][s] * inv;
            if (Math.abs(coefficient) < 1e-15)
                continue;
            for (let j = 0; j < this.n + 2; j++)
                if (j !== s)
                    this.D[i][j] -= this.D[r][j] * coefficient;
        } for (let j = 0; j < this.n + 2; j++)
        if (j !== s)
            this.D[r][j] *= inv; for (let i = 0; i < this.m + 2; i++)
        if (i !== r)
            this.D[i][s] *= -inv; this.D[r][s] = inv; [this.B[r], this.N[s]] = [this.N[s], this.B[r]]; }
    simplex(phase: number): boolean { const x = phase === 1 ? this.m + 1 : this.m; for (let iterations = 0; iterations < 20000; iterations++) {
        let s = -1;
        for (let j = 0; j <= this.n; j++) {
            if (phase === 2 && this.N[j] === -1)
                continue;
            if (s === -1 || this.D[x][j] < this.D[x][s] - EPS || (Math.abs(this.D[x][j] - this.D[x][s]) <= EPS && this.N[j] < this.N[s]))
                s = j;
        }
        if (s < 0 || this.D[x][s] >= -EPS)
            return true;
        let r = -1;
        for (let i = 0; i < this.m; i++) {
            if (this.D[i][s] <= EPS)
                continue;
            if (r === -1 || this.D[i][this.n + 1] / this.D[i][s] < this.D[r][this.n + 1] / this.D[r][s] - EPS || (Math.abs(this.D[i][this.n + 1] / this.D[i][s] - this.D[r][this.n + 1] / this.D[r][s]) <= EPS && this.B[i] < this.B[r]))
                r = i;
        }
        if (r === -1)
            return false;
        this.pivot(r, s);
    } throw Error('Calculation did not converge. Simplify the layout.'); }
    solve(): number[] | null { let r = 0; for (let i = 1; i < this.m; i++)
        if (this.D[i][this.n + 1] < this.D[r][this.n + 1])
            r = i; if (this.m && this.D[r][this.n + 1] < -EPS) {
        this.pivot(r, this.n);
        if (!this.simplex(1) || this.D[this.m + 1][this.n + 1] < -EPS || Math.abs(this.D[this.m + 1][this.n + 1]) > EPS)
            return null;
        const artificial = this.B.indexOf(-1);
        if (artificial !== -1) {
            let s = 0;
            for (let j = 1; j <= this.n; j++)
                if (this.D[artificial][j] < this.D[artificial][s] - EPS || (Math.abs(this.D[artificial][j] - this.D[artificial][s]) <= EPS && this.N[j] < this.N[s]))
                    s = j;
            if (Math.abs(this.D[artificial][s]) > EPS)
                this.pivot(artificial, s);
        }
    } if (!this.simplex(2))
        return null; const solution = Array(this.n).fill(0); for (let i = 0; i < this.m; i++)
        if (this.B[i] < this.n)
            solution[this.B[i]] = clean(this.D[i][this.n + 1]); return solution; }
}
function topological(layout: FactoryLayout): string[] | null { const counts = new Map(layout.nodes.map(n => [n.id, 0])), next = new Map(layout.nodes.map(n => [n.id, [] as string[]])); for (const e of layout.edges) {
    counts.set(e.to, (counts.get(e.to) ?? 0) + 1);
    next.get(e.from)?.push(e.to);
} const queue = layout.nodes.filter(n => counts.get(n.id) === 0).map(n => n.id), ordered: string[] = []; for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    ordered.push(id);
    for (const child of next.get(id) ?? []) {
        counts.set(child, counts.get(child)! - 1);
        if (counts.get(child) === 0)
            queue.push(child);
    }
} return ordered.length === layout.nodes.length ? ordered : null; }
const sum = (values: MaterialRate[]) => { const totals: Record<string, number> = {}; for (const v of values)
    totals[v.itemId] = (totals[v.itemId] ?? 0) + v.rate; return Object.entries(totals).map(([itemId, rate]) => ({ itemId, rate: clean(rate) })); };
export function calculateFactory(layout: FactoryLayout): FactoryCalculation {
    const result: FactoryCalculation = { nodes: {}, edges: {}, totals: { powerMW: 0, actualPowerMW: 0, inputs: [], outputs: [] }, issues: [], supported: true };
    const issue = (code: string, message: string, extra: Partial<FactoryIssue> = {}) => result.issues.push({ code, message, ...extra });
    for (const node of layout.nodes) {
        const rates = node.kind === 'machine' ? recipeRates(node.recipeId!, node.clock ?? 100, layout.settings, node.sloops ?? 0) : { inputs: node.kind === 'sink' ? [{ itemId: node.itemId!, rate: node.rate ?? 60 }] : [], outputs: node.kind === 'source' ? [{ itemId: node.itemId!, rate: node.rate ?? 60 }] : [], powerMW: 0, powerMinMW: 0, powerMaxMW: 0 };
        result.nodes[node.id] = { ...rates, utilization: 0, actualInputs: [], actualOutputs: [], actualPowerMW: 0, status: 'idle', issues: [] };
        result.totals.powerMW += rates.powerMW;
    }
    for (const edge of layout.edges)
        result.edges[edge.id] = { rate: 0, capacity: transportCapacity(edge.transport, edge.tier), saturation: 0 };
    const order = topological(layout);
    if (!order) {
        result.supported = false;
        issue('cycle', 'This layout contains a recycling loop. Recipe rates remain available, but network flow is not calculated for loops.');
        for (const n of Object.values(result.nodes))
            n.status = 'unsupported';
        return result;
    }
    if (!layout.nodes.length)
        return result;
    // Combined junctions retain a feasible mass-conserving steady-state solution.
    // Tick-level round-robin schedules and buffer transients are not simulated.
    const connected = new Map(layout.nodes.map(n => [n.id, [] as string[]]));
    for (const edge of layout.edges) {
        connected.get(edge.from)?.push(edge.to);
        connected.get(edge.to)?.push(edge.from);
    }
    const visited = new Set<string>(), components: string[][] = [];
    for (const start of layout.nodes) {
        if (visited.has(start.id))
            continue;
        const queue = [start.id], component: string[] = [];
        let split = false, merge = false;
        for (let i = 0; i < queue.length; i++) {
            const id = queue[i];
            if (visited.has(id))
                continue;
            visited.add(id);
            component.push(id);
            const kind = layout.nodes.find(n => n.id === id)!.kind;
            split ||= kind === 'splitter' || kind === 'smart-splitter';
            merge ||= kind === 'merger';
            for (const neighbour of connected.get(id) ?? [])
                if (!visited.has(neighbour))
                    queue.push(neighbour);
        }
        components.push(component);
        if (split && merge)
            issue('junction-allocation', 'Calculated steady-state allocation: when splitters and mergers compete, branch allocations may differ from in-game round-robin scheduling. Item totals and transport capacities remain conserved.');
    }
    if (components.length > 1) {
        // Separate production islands are independent LPs. This avoids one large
        // dense matrix for hundreds of unrelated machines and reduces worker time.
        result.issues = [];
        result.totals = { powerMW: 0, actualPowerMW: 0, inputs: [], outputs: [] };
        for (const component of components) {
            const ids = new Set(component), part = calculateFactory({ ...layout, nodes: layout.nodes.filter(n => ids.has(n.id)), edges: layout.edges.filter(e => ids.has(e.from)) });
            Object.assign(result.nodes, part.nodes);
            Object.assign(result.edges, part.edges);
            result.issues.push(...part.issues);
            result.supported &&= part.supported;
            result.totals.powerMW += part.totals.powerMW;
            result.totals.actualPowerMW += part.totals.actualPowerMW;
            result.totals.inputs.push(...part.totals.inputs);
            result.totals.outputs.push(...part.totals.outputs);
        }
        result.totals.inputs = sum(result.totals.inputs);
        result.totals.outputs = sum(result.totals.outputs);
        return result;
    }
    const machines = layout.nodes.filter(n => n.kind === 'machine'), machineIndex = new Map(machines.map((n, i) => [n.id, layout.edges.length + i])), edgeIndex = new Map(layout.edges.map((e, i) => [e.id, i])), size = layout.edges.length + machines.length;
    const A: number[][] = [], b: number[] = [], row = () => Array(size).fill(0) as number[], add = (r: number[], rhs: number) => { A.push(r); b.push(rhs); }, equality = (r: number[], rhs = 0) => { add(r, rhs); add(r.map(v => -v), -rhs); };
    const incoming = (id: string) => layout.edges.filter(e => e.to === id), outgoing = (id: string) => layout.edges.filter(e => e.from === id);
    for (const edge of layout.edges) {
        const r = row();
        r[edgeIndex.get(edge.id)!] = 1;
        add(r, transportCapacity(edge.transport, edge.tier));
    }
    for (const node of layout.nodes) {
        const ins = incoming(node.id), outs = outgoing(node.id), rates = result.nodes[node.id];
        if (node.kind === 'machine') {
            const variable = machineIndex.get(node.id)!;
            const upper = row();
            upper[variable] = 1;
            add(upper, 1);
            for (const input of rates.inputs) {
                const r = row();
                for (const edge of ins.filter(e => e.itemId === input.itemId))
                    r[edgeIndex.get(edge.id)!] += 1;
                r[variable] = -input.rate;
                equality(r);
            }
            for (const output of rates.outputs) {
                const r = row();
                for (const edge of outs.filter(e => e.itemId === output.itemId))
                    r[edgeIndex.get(edge.id)!] += 1;
                r[variable] = -output.rate;
                equality(r);
            }
        }
        else if (node.kind === 'source' || node.kind === 'sink') {
            const r = row();
            for (const e of node.kind === 'source' ? outs : ins)
                r[edgeIndex.get(e.id)!] = 1;
            add(r, node.rate ?? 60);
        }
        else {
            const r = row();
            for (const e of ins)
                r[edgeIndex.get(e.id)!] += 1;
            for (const e of outs)
                r[edgeIndex.get(e.id)!] -= 1;
            equality(r);
            if (node.kind === 'smart-splitter')
                for (const edge of outs) {
                    const filter = node.filters?.[edge.fromPort] ?? 'any';
                    if (filter === 'none' || (filter !== 'any' && filter !== edge.itemId)) {
                        const zero = row();
                        zero[edgeIndex.get(edge.id)!] = 1;
                        add(zero, 0);
                    }
                }
        }
    }
    if (!size) {
        for (const node of layout.nodes)
            issue('disconnected', 'Connect this node to a complete production path.', { nodeId: node.id });
        return result;
    }
    const budget = new CalculationBudget();
    const solve = (objective: number[], extraA: number[][] = [], extraB: number[] = []) => (new LinearProgram([...A, ...extraA], [...b, ...extraB], objective, budget)).solve();
    try {
        // Upstream-first max-min allocation gives splitters equal output rates and
        // mergers equal input rates until a branch is limited, then redistributes.
        // This is a steady-state single-material model, not a tick-level simulation.
        for (const id of order) {
            const node = layout.nodes.find(n => n.id === id)!;
            if (!['splitter', 'smart-splitter', 'merger'].includes(node.kind))
                continue;
            let remaining = (node.kind === 'merger' ? incoming(id) : outgoing(id)).filter(e => node.kind !== 'smart-splitter' || !node.filters?.[e.fromPort] || node.filters[e.fromPort] === 'any' || node.filters[e.fromPort] === e.itemId).map(e => edgeIndex.get(e.id)!);
            if (remaining.length < 2)
                continue;
            while (remaining.length) {
                const extended = A.map(r => [...r, 0]);
                const rhs = [...b];
                for (const index of remaining) {
                    const r = Array(size + 1).fill(0);
                    r[index] = -1;
                    r[size] = 1;
                    extended.push(r);
                    rhs.push(0);
                }
                const c = Array(size + 1).fill(0);
                c[size] = 1;
                const shared = new LinearProgram(extended, rhs, c, budget).solve();
                if (!shared)
                    throw Error('Splitter allocation could not be solved.');
                const level = Math.max(0, shared[size]);
                for (const index of remaining) {
                    const r = row();
                    r[index] = -1;
                    add(r, -level + EPS * 4);
                }
                const blocked: number[] = [];
                for (const index of remaining) {
                    const objective = row();
                    objective[index] = 1;
                    const check = solve(objective);
                    if (!check || check[index] <= level + 1e-5)
                        blocked.push(index);
                }
                if (!blocked.length)
                    break;
                remaining = remaining.filter(i => !blocked.includes(i));
            }
        }
        const objective = row();
        for (const node of layout.nodes)
            if (node.kind === 'sink')
                for (const edge of incoming(node.id))
                    objective[edgeIndex.get(edge.id)!] = 1 / Math.max(node.rate ?? 60, 1);
        const solved = solve(objective);
        if (!solved)
            throw Error('The layout could not be solved.');
        for (const edge of layout.edges) {
            const rate = Math.max(0, clean(solved[edgeIndex.get(edge.id)!]));
            const edgeResult = result.edges[edge.id];
            edgeResult.rate = rate;
            edgeResult.saturation = edgeResult.capacity ? rate / edgeResult.capacity : 0;
            if (edgeResult.saturation > 1 - 1e-6)
                issue('transport-limit', `${edge.transport === 'belt' ? 'Belt' : 'Pipe'} Mk.${edge.tier} is at capacity.`, { edgeId: edge.id });
        }
        for (const node of layout.nodes) {
            const n = result.nodes[node.id];
            n.actualInputs = sum(incoming(node.id).map(e => ({ itemId: e.itemId, rate: result.edges[e.id].rate })));
            n.actualOutputs = sum(outgoing(node.id).map(e => ({ itemId: e.itemId, rate: result.edges[e.id].rate })));
            n.utilization = node.kind === 'machine' ? Math.min(1, Math.max(0, solved[machineIndex.get(node.id)!])) : node.kind === 'source' ? n.actualOutputs.reduce((a, x) => a + x.rate, 0) / Math.max(node.rate ?? 60, EPS) : node.kind === 'sink' ? n.actualInputs.reduce((a, x) => a + x.rate, 0) / Math.max(node.rate ?? 60, EPS) : (n.actualInputs.some(x => x.rate > EPS) ? 1 : 0);
            n.actualPowerMW = n.powerMW * n.utilization;
            n.status = n.utilization <= 1e-6 ? 'idle' : n.utilization < 1 - 1e-6 ? 'limited' : 'running';
            result.totals.actualPowerMW += n.actualPowerMW;
            if (node.kind === 'source')
                result.totals.inputs.push(...n.actualOutputs);
            if (node.kind === 'sink')
                result.totals.outputs.push(...n.actualInputs);
            if (node.kind === 'machine' && n.utilization < 1 - 1e-6) {
                const text = 'Limited by inputs, connected output capacity, or downstream demand.';
                n.issues.push(text);
                issue('machine-limited', text, { nodeId: node.id });
            }
        }
        result.totals.inputs = sum(result.totals.inputs);
        result.totals.outputs = sum(result.totals.outputs);
    }
    catch (error) {
        result.supported = false;
        issue('calculation', error instanceof Error ? error.message : 'Calculation unavailable.');
        for (const n of Object.values(result.nodes))
            n.status = 'unsupported';
    }
    return result;
}
