import catalog from '../factory/data/satisfactory-1.2.json';
import { PlanValidationError } from '../lib/plan-validation';
import type { WorldEntity, WorldLink, WorldMarker, WorldPlan, WorldPoint, WorldSnapshot } from './types';

export const MAX_WORLD_BYTES = 8_000_000;
export const MAX_PLAN_BYTES = 1_000_000;
const recipes = new Set(catalog.recipes.map(recipe => recipe.id));
const entityKinds = new Set(['machine', 'extractor', 'storage', 'generator', 'splitter', 'merger', 'player', 'vehicle', 'other']);
const invalid = (message: string): never => { throw new PlanValidationError(message); };
function object(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(`${label} must be an object.`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) invalid(`${label} contains unsupported fields.`);
  return result;
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return invalid(`${label} must contain 1–${max} visible characters.`);
  return value;
}
function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return invalid(`${label} is outside its supported range.`);
  return value;
}
function point(value: Record<string, unknown>): WorldPoint {
  return { x: number(value.x, 'X coordinate', -2_000_000, 2_000_000), y: number(value.y, 'Y coordinate', -2_000_000, 2_000_000), z: number(value.z, 'Elevation', -2_000_000, 2_000_000) };
}
function rotation(value: unknown): number { return number(value, 'Rotation', 0, 359.999999999); }
function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') return invalid(`${label} must be true or false.`);
  return value;
}
export function validateRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) return invalid('Invalid revision.');
  return value;
}
function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid(`${label} must contain no more than ${max} entries.`);
  return value;
}
function uniqueIds(values: { id: string }[], label: string) {
  if (new Set(values.map(value => value.id)).size !== values.length) invalid(`${label} contain duplicate IDs.`);
}

export function validateWorldSnapshot(value: unknown, now = Date.now()): WorldSnapshot {
  const data = object(value, 'World snapshot', ['version', 'coordinateSystem', 'worldId', 'worldName', 'sequence', 'observedAt', 'source', 'entities', 'links']);
  if (data.version !== 1 || data.coordinateSystem !== 'satisfactory-ue-cm') invalid('Use world snapshot version 1 with satisfactory-ue-cm coordinates.');
  const observedAt = text(data.observedAt, 'Observation timestamp', 40), observed = Date.parse(observedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(observedAt) || !Number.isFinite(observed) || observed > now + 30_000 || observed < now - 600_000) invalid('Snapshot time must be within the last 10 minutes and no more than 30 seconds ahead. Check the bridge clock.');
  const source = object(data.source, 'Source', ['kind', 'version']);
  if (source.kind !== 'frm') invalid('Only the Ficsit Remote Monitoring source is supported.');
  const entities = array(data.entities, 'World entities', 30_000).map(value => {
    const entity = object(value, 'World entity', ['id', 'className', 'name', 'kind', 'x', 'y', 'z', 'yaw', 'recipeId', 'clockPercent', 'powerMW', 'producing', 'online']);
    if (!entityKinds.has(String(entity.kind))) invalid('Unsupported world entity kind.');
    return {
      id: text(entity.id, 'Entity ID', 256), className: text(entity.className, 'Building class', 512), name: text(entity.name, 'Entity name', 160), kind: entity.kind as WorldEntity['kind'],
      ...point(entity), yaw: rotation(entity.yaw),
      ...(entity.recipeId === undefined ? {} : { recipeId: text(entity.recipeId, 'Recipe ID', 256) }),
      ...(entity.clockPercent === undefined ? {} : { clockPercent: number(entity.clockPercent, 'Clock speed', 0, 250) }),
      ...(entity.powerMW === undefined ? {} : { powerMW: number(entity.powerMW, 'Power', 0, 1_000_000_000) }),
      ...(entity.producing === undefined ? {} : { producing: optionalBoolean(entity.producing, 'Production state') }),
      ...(entity.online === undefined ? {} : { online: optionalBoolean(entity.online, 'Online state') }),
    } as WorldEntity;
  });
  let totalPoints = 0;
  const links = array(data.links, 'World connections', 30_000).map(value => {
    const link = object(value, 'World connection', ['id', 'kind', 'points', 'tier']);
    if (!['belt', 'pipe', 'rail'].includes(String(link.kind))) invalid('Unsupported connection kind.');
    const points = array(link.points, 'Connection points', 5_000).map(value => point(object(value, 'Connection point', ['x', 'y', 'z'])));
    totalPoints += points.length;
    if (points.length < 2 || totalPoints > 100_000) invalid('Connections require 2–5,000 points each, with no more than 100,000 points in total.');
    const tier = link.tier === undefined ? undefined : number(link.tier, 'Transport tier', 1, link.kind === 'pipe' ? 2 : 6);
    if (tier !== undefined && (!Number.isInteger(tier) || link.kind === 'rail')) invalid('Invalid transport tier.');
    return { id: text(link.id, 'Connection ID', 256), kind: link.kind as WorldLink['kind'], points, ...(tier === undefined ? {} : { tier }) };
  });
  uniqueIds(entities, 'World entities'); uniqueIds(links, 'World connections');
  return {
    version: 1, coordinateSystem: 'satisfactory-ue-cm', worldId: text(data.worldId, 'World ID', 128), worldName: text(data.worldName, 'World name', 160), sequence: validateRevision(data.sequence), observedAt: new Date(observed).toISOString(),
    source: { kind: 'frm', ...(source.version === undefined ? {} : { version: text(source.version, 'Source version', 80) }) }, entities, links,
  };
}

export function validateWorldPlan(value: unknown): WorldPlan {
  const data = object(value, 'World plan', ['version', 'worldId', 'markers']);
  if (data.version !== 1) invalid('Use world plan version 1.');
  const markers = array(data.markers, 'Planned markers', 2_000).map(value => {
    const marker = object(value, 'Planned marker', ['id', 'kind', 'label', 'x', 'y', 'z', 'rotation', 'recipeId', 'clockPercent', 'width', 'height']);
    if (!['note', 'machine', 'area'].includes(String(marker.kind))) invalid('Unsupported marker kind.');
    const result: WorldMarker = { id: text(marker.id, 'Marker ID', 256), kind: marker.kind as WorldMarker['kind'], label: text(marker.label, 'Marker label', 300), ...point(marker), rotation: rotation(marker.rotation) };
    if (marker.kind === 'machine') {
      const recipeId = text(marker.recipeId, 'Planned recipe', 256);
      if (!recipes.has(recipeId)) invalid('Choose a supported production recipe.');
      result.recipeId = recipeId; result.clockPercent = number(marker.clockPercent, 'Clock speed', 1, 250);
    } else if (marker.recipeId !== undefined || marker.clockPercent !== undefined) invalid('Only planned machines have recipes and clock speeds.');
    if (marker.kind === 'area') {
      result.width = number(marker.width, 'Area width', 100, 200_000); result.height = number(marker.height, 'Area height', 100, 200_000);
    } else if (marker.width !== undefined || marker.height !== undefined) invalid('Only planned areas have dimensions.');
    return result;
  });
  uniqueIds(markers, 'Planned markers');
  return { version: 1, worldId: data.worldId === null ? null : text(data.worldId, 'World ID', 128), markers };
}

export async function readWorldJson(request: Request, limit = MAX_WORLD_BYTES): Promise<unknown> {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) invalid('Send JSON.');
  if (Number(request.headers.get('content-length')) > limit) invalid('Request is too large.');
  const reader = request.body?.getReader(); if (!reader) return invalid('Request is empty.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) { await reader.cancel(); invalid('Request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return invalid('Invalid JSON.'); }
}
