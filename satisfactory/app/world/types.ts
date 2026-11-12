/** World coordinates are Unreal centimetres: X/Y horizontal, Z elevation. */
export type WorldPoint = { x: number; y: number; z: number };
export type WorldEntity = WorldPoint & {
  id: string;
  className: string;
  name: string;
  kind: 'machine' | 'extractor' | 'storage' | 'generator' | 'splitter' | 'merger' | 'player' | 'vehicle' | 'other';
  yaw: number;
  recipeId?: string;
  clockPercent?: number;
  powerMW?: number;
  producing?: boolean;
  online?: boolean;
};
export type WorldLink = {
  id: string;
  kind: 'belt' | 'pipe' | 'rail';
  points: WorldPoint[];
  tier?: number;
};
export type WorldSnapshot = {
  version: 1;
  coordinateSystem: 'satisfactory-ue-cm';
  worldId: string;
  worldName: string;
  /** Monotonic across bridge restarts; Unix milliseconds are suitable. */
  sequence: number;
  observedAt: string;
  source: { kind: 'frm'; version?: string };
  entities: WorldEntity[];
  links: WorldLink[];
};
export type WorldMarker = WorldPoint & {
  id: string;
  kind: 'note' | 'machine' | 'area';
  label: string;
  rotation: number;
  recipeId?: string;
  clockPercent?: number;
  /** Planned area dimensions in centimetres; not verified machine footprints. */
  width?: number;
  height?: number;
};
export type WorldPlan = { version: 1; worldId: string | null; markers: WorldMarker[] };
export type SavedWorldPlan = { data: WorldPlan; revision: number; updatedAt: string | null; updatedBy: string | null };
export type WorldState = {
  status: 'not_connected' | 'waiting' | 'live' | 'stale';
  configured: boolean;
  snapshot: WorldSnapshot | null;
  lastReceivedAt: string | null;
};
export type WorldConnection = { configured: boolean; createdAt: string | null; worldId: string | null };
export const createEmptyWorldPlan = (): WorldPlan => ({ version: 1, worldId: null, markers: [] });
