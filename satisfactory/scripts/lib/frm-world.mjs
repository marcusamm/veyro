/** Original adapter for FRM 1.5.5 / Satisfactory 1.2. See docs/world-map-setup.md. */
export const ENDPOINTS = Object.freeze({
  getFactory: 'machine', getExtractor: 'extractor', getGenerators: 'generator',
  getPlayer: 'player', getStorageInv: 'storage', getSplitterMerger: 'junction',
  getBelts: 'belt', getLifts: 'lift', getPipes: 'pipe',
});
export const DEFAULT_ENDPOINTS = Object.freeze(Object.keys(ENDPOINTS));
export const MAX_SNAPSHOT_BYTES = 8_000_000;

export class BridgeError extends Error {
  constructor(message) { super(message); this.name = 'BridgeError'; }
}
function fail(message) { throw new BridgeError(message); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object. Check FRM 1.5.5 compatibility.`);
  return value;
}
export function visibleText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} must contain 1–${max} visible characters.`);
  return value;
}
function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} is missing or outside its supported range. Check the FRM response schema.`);
  return value;
}
function point(value, label) {
  const source = object(value, label);
  return {
    x: number(source.x, `${label}.x`, -2_000_000, 2_000_000),
    y: number(source.y, `${label}.y`, -2_000_000, 2_000_000),
    z: number(source.z, `${label}.z`, -2_000_000, 2_000_000),
  };
}
function optionalNumber(target, key, value, label, min, max) {
  if (value !== undefined) target[key] = number(value, label, min, max);
}
function optionalBoolean(target, key, value, label) {
  if (value === undefined) return;
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  target[key] = value;
}
/** FRM compass bearing = (UE yaw + 450) % 360, not raw UE yaw. */
export function frmRotationToYaw(rotation) {
  const value = number(rotation, 'location.rotation', 0, 360);
  return ((value - 90) % 360 + 360) % 360;
}
function entity(source, endpoint) {
  const row = object(source, endpoint), className = visibleText(row.ClassName, `${endpoint}.ClassName`, 512);
  let kind = ENDPOINTS[endpoint];
  if (kind === 'junction') kind = /merger/i.test(className) ? 'merger' : /splitter/i.test(className) ? 'splitter' : 'other';
  const location = object(row.location, `${endpoint}.location`);
  const result = {
    id: visibleText(row.ID, `${endpoint}.ID`, 256), className,
    name: visibleText(row.Name || className, `${endpoint}.Name`, 160), kind,
    ...point(location, `${endpoint}.location`), yaw: frmRotationToYaw(location.rotation),
  };
  // RecipeClassName on extractors is the extracted item's class, not a recipe.
  if (row.RecipeClassName !== undefined && row.RecipeClassName !== '') {
    const recipe = visibleText(row.RecipeClassName, `${endpoint}.RecipeClassName`, 256);
    if (recipe.startsWith('Recipe_')) result.recipeId = recipe;
  }
  // Modern FRM source multiplies both properties by 100 before emitting them.
  optionalNumber(result, 'clockPercent', kind === 'generator' ? row.CurrentPotential : row.ManuSpeed, `${endpoint}.clock`, 0, 250);
  if (row.PowerInfo !== undefined) {
    const power = object(row.PowerInfo, `${endpoint}.PowerInfo`);
    // This is reported consumption, never inferred production/capacity/flow.
    optionalNumber(result, 'powerMW', power.PowerConsumed, `${endpoint}.PowerInfo.PowerConsumed`, 0, 1_000_000_000);
  }
  optionalBoolean(result, 'producing', row.IsProducing, `${endpoint}.IsProducing`);
  if (kind === 'player') optionalBoolean(result, 'online', row.Online, `${endpoint}.Online`);
  return result;
}
const distance2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
function link(source, endpoint) {
  const row = object(source, endpoint), className = visibleText(row.ClassName, `${endpoint}.ClassName`, 512);
  const id = visibleText(row.ID, `${endpoint}.ID`, 256), kind = endpoint === 'getPipes' ? 'pipe' : 'belt';
  // These are world-space connector positions in the verified modern source.
  const a = point(row.location0, `${endpoint}.location0`), b = point(row.location1, `${endpoint}.location1`);
  let points;
  if (endpoint === 'getLifts') points = [a, b];
  else {
    if (!Array.isArray(row.SplineData) || row.SplineData.length < 1 || row.SplineData.length > 4_998) fail(`${endpoint}.SplineData must contain 1–4,998 world-space points. Increase FRM's spline sample distance if necessary.`);
    points = row.SplineData.map(value => point(value, `${endpoint}.SplineData`));
    // FRM samples the spline but can omit its final endpoint. Add the actual
    // connectors, orienting them to the samples; do not guess their positions.
    const first = points[0], last = points.at(-1);
    const reverse = distance2(b, first) + distance2(a, last) < distance2(a, first) + distance2(b, last);
    const start = reverse ? b : a, end = reverse ? a : b;
    if (distance2(start, first) > 0.0001) points.unshift(start);
    if (distance2(end, last) > 0.0001) points.push(end);
    if (points.length < 2) points.push(end);
  }
  const result = { id, kind, points };
  const match = className.match(/(?:ConveyorBelt|ConveyorLift)(?:Mk)?([1-6])(?:_|$)/i);
  if (kind === 'belt' && match) result.tier = Number(match[1]);
  if (kind === 'pipe') {
    if (/^Build_Pipeline_C$/i.test(className)) result.tier = 1;
    else if (/Pipeline(?:Mk)?2(?:_|$)/i.test(className)) result.tier = 2;
  }
  return result;
}
/** No raw response object is spread or retained in the public snapshot. */
export function normalizeBatch(endpoint, response) {
  if (!Object.hasOwn(ENDPOINTS, endpoint)) fail('Unsupported FRM endpoint. Only the documented read-only map endpoints are allowed.');
  if (!Array.isArray(response) || response.length > 30_000) fail(`${endpoint} must return an array with no more than 30,000 rows. Check FRM 1.5.5 compatibility.`);
  const isLink = ['getBelts', 'getLifts', 'getPipes'].includes(endpoint);
  return { entities: isLink ? [] : response.map(value => entity(value, endpoint)), links: isLink ? response.map(value => link(value, endpoint)) : [] };
}
export function createSnapshot(batches, { worldId, worldName, sequence, observedAt }) {
  const entities = batches.flatMap(batch => batch.entities), links = batches.flatMap(batch => batch.links);
  if (entities.length > 30_000 || links.length > 30_000 || links.reduce((sum, row) => sum + row.points.length, 0) > 100_000) fail('World exceeds map limits (30,000 entities, 30,000 connections, 100,000 spline points). Increase FRM spline sample distance or narrow FRM_ENDPOINTS; no partial world was sent.');
  if (new Set(entities.map(row => row.id)).size !== entities.length || new Set(links.map(row => row.id)).size !== links.length) fail('FRM returned duplicate actor IDs. No partial or ambiguous world was sent.');
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER) fail('Invalid bridge sequence. Check the system clock.');
  const timestamp = new Date(observedAt);
  if (!Number.isFinite(timestamp.valueOf())) fail('Invalid observation time. Check the system clock.');
  // Deterministic ordering also avoids artificial churn when FRM reorders actors.
  entities.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  links.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const snapshot = {
    version: 1, coordinateSystem: 'satisfactory-ue-cm',
    worldId: visibleText(worldId, 'WORLD_ID', 128), worldName: visibleText(worldName, 'WORLD_NAME', 160),
    sequence, observedAt: timestamp.toISOString(), source: { kind: 'frm' }, entities, links,
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) fail('Normalized map exceeds the website’s 8 MB limit. Increase FRM spline sample distance or narrow FRM_ENDPOINTS; no partial world was sent.');
  return snapshot;
}
