import { extractorById, getNodePorts, itemById, machineById, recipeById, transportCapacity } from './engine';
import type { FactoryEdge, FactoryLayout, FactoryNode, NodeKind } from './types';
export { createEmptyFactoryLayout } from './types';
export class FactoryValidationError extends Error {
    constructor(message: string) { super(message); this.name = 'FactoryValidationError'; }
}
const fail = (message: string): never => { throw new FactoryValidationError(message); };
function record(value: unknown, context: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return fail(`${context} must be an object.`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return fail(`${context} must be a plain object.`);
    return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], context: string) { for (const key of Object.keys(value))
    if (!allowed.includes(key))
        fail(`${context}: unknown field ${key}.`); }
function text(value: unknown, context: string, max = 128): string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
    return fail(`${context} must be a non-empty string of at most ${max} characters.`); return value; }
function id(value: unknown, context: string): string { const v = text(value, context); if (!/^[A-Za-z0-9_.:-]+$/.test(v) || ['__proto__', 'constructor', 'prototype'].includes(v))
    return fail(`${context} is not a valid identifier.`); return v; }
function num(value: unknown, context: string, min: number, max: number): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    return fail(`${context} must be a finite number between ${min} and ${max}.`); return value; }
function knownItem(value: unknown, context: string): string { const v = id(value, context); if (!Object.hasOwn(itemById, v))
    fail(`${context} is not in the Satisfactory 1.2 catalog.`); return v; }
const nodeKinds: NodeKind[] = ['machine', 'extractor', 'source', 'sink', 'splitter', 'merger', 'smart-splitter'];
/** Validates and copies an untrusted saved/imported layout. No unknown fields survive. */
export function validateFactoryLayout(input: unknown): FactoryLayout {
    const data = record(input, 'Layout');
    keys(data, ['version', 'name', 'nodes', 'edges', 'settings'], 'Layout');
    if (data.version !== 1)
        fail('Unsupported factory layout version.');
    const name = text(data.name, 'Layout name', 100), settings = record(data.settings, 'Settings');
    keys(settings, ['recipeMultiplier', 'powerMultiplier'], 'Settings');
    const recipeMultiplier = num(settings.recipeMultiplier, 'Recipe Cost multiplier', 0.25, 2), powerMultiplier = num(settings.powerMultiplier, 'Power multiplier', 0.25, 5);
    if (!Array.isArray(data.nodes) || data.nodes.length > 250)
        fail('A layout may contain at most 250 nodes.');
    if (!Array.isArray(data.edges) || data.edges.length > 500)
        fail('A layout may contain at most 500 connections.');
    const nodeIds = new Set<string>();
    const nodes = (data.nodes as unknown[]).map((value, index): FactoryNode => {
        const raw = record(value, `Node ${index + 1}`);
        keys(raw, ['id', 'kind', 'label', 'x', 'y', 'rotation', 'recipeId', 'clock', 'itemId', 'rate', 'sloops', 'filters', 'extractorId', 'purity'], `Node ${index + 1}`);
        const nodeId = id(raw.id, 'Node ID');
        if (nodeIds.has(nodeId))
            fail('Node IDs must be unique.');
        nodeIds.add(nodeId);
        if (!nodeKinds.includes(raw.kind as NodeKind))
            fail(`Node ${nodeId} has an unsupported kind.`);
        const kind = raw.kind as NodeKind, rotation = num(raw.rotation, 'Rotation', 0, 270);
        if (![0, 90, 180, 270].includes(rotation))
            fail('Rotation must be 0, 90, 180 or 270.');
        const node: FactoryNode = { id: nodeId, kind, x: num(raw.x, 'X position', -10000, 10000), y: num(raw.y, 'Y position', -10000, 10000), rotation: rotation as FactoryNode['rotation'] };
        if (raw.label !== undefined)
            node.label = text(raw.label, 'Node label', 80);
        if (kind === 'machine') {
            const recipeId = id(raw.recipeId, 'Recipe ID');
            if (!Object.hasOwn(recipeById, recipeId))
                fail(`Unknown recipe ${recipeId}.`);
            node.recipeId = recipeId;
            node.clock = Math.round(num(raw.clock === undefined ? 100 : raw.clock, 'Clock speed', 1, 250) * 10000) / 10000;
            const slots = machineById[recipeById[recipeId].machineId].sloopSlots ?? 0, sloops = num(raw.sloops === undefined ? 0 : raw.sloops, 'Somersloops', 0, slots);
            if (!Number.isInteger(sloops))
                fail('Somersloops must be a whole number.');
            node.sloops = sloops;
            if (raw.itemId !== undefined || raw.rate !== undefined || raw.filters !== undefined)
                fail('Machine materials and rates are defined by its recipe.');
            if (raw.extractorId !== undefined || raw.purity !== undefined)
                fail('Only extractors have an extractor type and resource purity.');
        }
        else if (kind === 'extractor') {
            const extractorId = id(raw.extractorId, 'Extractor type');
            if (!Object.hasOwn(extractorById, extractorId))
                fail(`Unknown extractor ${extractorId}.`);
            const extractor = extractorById[extractorId];
            node.extractorId = extractorId;
            node.itemId = knownItem(raw.itemId, 'Extractor resource');
            if (!extractor.resourceIds.includes(node.itemId))
                fail('This extractor cannot produce the selected resource.');
            const purity = raw.purity === undefined ? 'normal' : raw.purity;
            if (purity !== 'impure' && purity !== 'normal' && purity !== 'pure')
                fail('Resource purity must be impure, normal or pure.');
            if (!extractor.supportsPurity && purity !== 'normal')
                fail('Water extractors do not have resource purity.');
            node.purity = purity as FactoryNode['purity'];
            node.clock = Math.round(num(raw.clock === undefined ? 100 : raw.clock, 'Clock speed', 1, 250) * 10000) / 10000;
            if (raw.recipeId !== undefined || raw.rate !== undefined || raw.sloops !== undefined || raw.filters !== undefined)
                fail('Extractor rates are defined by their type, resource purity and clock speed.');
        }
        else {
            node.itemId = knownItem(raw.itemId, 'Node item');
            if (raw.recipeId !== undefined || raw.clock !== undefined || raw.sloops !== undefined)
                fail('Recipes and Somersloops belong to production machines; clock speed belongs to production machines and extractors.');
            if (raw.extractorId !== undefined || raw.purity !== undefined)
                fail('Only extractors have an extractor type and resource purity.');
            if (kind === 'source' || kind === 'sink')
                node.rate = num(raw.rate === undefined ? 60 : raw.rate, 'Source or destination rate', 0, 1000000);
            else {
                if (raw.rate !== undefined)
                    fail('Splitter and merger rates are determined by their connections.');
                if (itemById[node.itemId].form !== 'solid')
                    fail('Conveyor splitters and mergers only handle solid items. Connect liquids with pipes directly.');
            }
            if (raw.filters !== undefined) {
                if (kind !== 'smart-splitter')
                    fail('Only smart splitters have filters.');
                const filters = record(raw.filters, 'Smart splitter filters');
                keys(filters, ['out:0', 'out:1', 'out:2'], 'Smart splitter filters');
                node.filters = {};
                for (const [port, filter] of Object.entries(filters)) {
                    if (filter === 'any' || filter === 'none')
                        node.filters[port] = filter;
                    else
                        node.filters[port] = knownItem(filter, 'Smart splitter filter');
                }
            }
        }
        return node;
    });
    const nodeById = new Map(nodes.map(n => [n.id, n])), edgeIds = new Set<string>(), usedPorts = new Set<string>();
    const edges = (data.edges as unknown[]).map((value, index): FactoryEdge => {
        const raw = record(value, `Connection ${index + 1}`);
        keys(raw, ['id', 'from', 'to', 'fromPort', 'toPort', 'itemId', 'transport', 'tier'], `Connection ${index + 1}`);
        const edgeId = id(raw.id, 'Connection ID');
        if (edgeIds.has(edgeId))
            fail('Connection IDs must be unique.');
        edgeIds.add(edgeId);
        const from = id(raw.from, 'Source node ID'), to = id(raw.to, 'Destination node ID'), source = nodeById.get(from), destination = nodeById.get(to);
        if (!source || !destination)
            return fail('Every connection must refer to existing nodes.');
        const fromPort = id(raw.fromPort, 'Source port'), toPort = id(raw.toPort, 'Destination port'), itemId = knownItem(raw.itemId, 'Connection item');
        const sourcePort = getNodePorts(source).find(p => p.id === fromPort && p.direction === 'output'), targetPort = getNodePorts(destination).find(p => p.id === toPort && p.direction === 'input');
        if (!sourcePort || !targetPort)
            fail('A connection must run from an output port to an input port.');
        if (sourcePort!.itemId !== itemId || targetPort!.itemId !== itemId)
            fail('Both ports and the connection must carry the same item. Mixed-item belts are not supported.');
        if (raw.transport !== 'belt' && raw.transport !== 'pipe')
            fail('Connection transport must be belt or pipe.');
        const transport = raw.transport as 'belt' | 'pipe';
        if (sourcePort!.medium !== transport || targetPort!.medium !== transport)
            fail('Solids need belts; liquids and gases need pipes.');
        const tier = num(raw.tier, 'Transport tier', 1, 6);
        if (!Number.isInteger(tier) || !transportCapacity(transport, tier))
            fail('Unsupported belt or pipe tier.');
        for (const key of [`${from}/${fromPort}`, `${to}/${toPort}`]) {
            if (usedPorts.has(key))
                fail('Each port can have only one connection. Add a splitter or merger to branch a belt.');
            usedPorts.add(key);
        }
        return { id: edgeId, from, to, fromPort, toPort, itemId, transport, tier };
    });
    return { version: 1, name, nodes, edges, settings: { recipeMultiplier, powerMultiplier } };
}
