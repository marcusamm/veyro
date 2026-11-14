import type { FactoryLayout, FactoryNode } from './types';
import { catalog, getNodePorts, machineById, recipeById } from './engine';

/** Keep a connection only when both of its saved endpoints still exist and match. */
export function retainCompatibleConnections(layout: FactoryLayout) {
 const nodes = new Map(layout.nodes.map(node => [node.id, node]));
 layout.edges = layout.edges.filter(edge => {
  const from = nodes.get(edge.from), to = nodes.get(edge.to);
  if (!from || !to) return false;
  const output = getNodePorts(from).find(port => port.id === edge.fromPort && port.direction === 'output');
  const input = getNodePorts(to).find(port => port.id === edge.toPort && port.direction === 'input');
  return output?.itemId === edge.itemId && input?.itemId === edge.itemId && output?.medium === edge.transport && input?.medium === edge.transport;
 });
}

export function changeProductionRecipe(layout: FactoryLayout, nodeId: string, recipeId: string) {
 const node = layout.nodes.find(node => node.id === nodeId), recipe = recipeById[recipeId];
 if (!node || node.kind !== 'machine' || !recipe) return;
 node.recipeId = recipeId;
 node.sloops = Math.min(node.sloops || 0, machineById[recipe.machineId]?.sloopSlots || 0);
 retainCompatibleConnections(layout);
}

/** Also supports upgrading an old manual supply without losing compatible belts. */
export function changeExtractorBuilding(layout: FactoryLayout, nodeId: string, extractorId: string) {
 const node = layout.nodes.find(node => node.id === nodeId);
 const extractor = catalog.extractors.find(building => building.id === extractorId);
 if (!node || !extractor || !['source', 'extractor'].includes(node.kind)) return;
 node.kind = 'extractor'; node.extractorId = extractor.id;
 if (!node.itemId || !extractor.resourceIds.includes(node.itemId)) node.itemId = extractor.resourceIds[0];
 node.clock = node.clock ?? 100;
 node.purity = extractor.supportsPurity ? node.purity ?? 'normal' : 'normal';
 delete node.rate; delete node.recipeId; delete node.sloops; delete node.filters;
 retainCompatibleConnections(layout);
}

export function changeNodeMaterial(layout: FactoryLayout, nodeId: string, itemId: string) {
 const node = layout.nodes.find(node => node.id === nodeId);
 if (!node || node.itemId === itemId) return;
 node.itemId = itemId;
 delete node.filters;
 retainCompatibleConnections(layout);
}

export function parseNumericDraft(raw: string, min: number, max: number, integer = false): number | null {
 if (!raw.trim()) return null;
 const value = Number(raw);
 return Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)) ? value : null;
}

export function nodeBounds(node: FactoryNode, width: number, height: number) {
 const sideways = node.rotation === 90 || node.rotation === 270;
 const halfWidth = (sideways ? height : width) / 2 + 3;
 const halfHeight = (sideways ? width : height) / 2 + 3;
 return { minX: node.x - halfWidth, maxX: node.x + halfWidth, minY: node.y - halfHeight, maxY: node.y + halfHeight };
}
