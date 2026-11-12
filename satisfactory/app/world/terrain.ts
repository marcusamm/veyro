// Bounds published with the base terrain selected by the pinned 1.2 game data.
// Image X follows world X; image Y follows world Y. All coordinates are UE cm.
export const WORLD_TERRAIN = {
  minX: -324698.16,
  minY: -375000,
  maxX: 425301.84,
  maxY: 375000,
  tilesAcross: 4,
  tileUrl: (x: number, y: number) => `/world-map/2/${x}/${y}.webp`,
};
