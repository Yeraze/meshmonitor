import type { LatLngBoundsLiteral } from 'leaflet';

/**
 * Latitude where the Web Mercator tile pyramid ends (atan(sinh(π)) in
 * degrees). Clamping to this exact edge, rather than a round ±85, makes the
 * world-fill zoom below match the tiles' real extent.
 */
export const MERCATOR_MAX_LAT = 85.0511287798066;

/**
 * One copy of the world (#5556). Every `BaseMap` is held inside it
 * (`maxBounds` + `maxBoundsViscosity: 1`) and its raster tiles do not wrap,
 * so a zoomed-out map can no longer show a second world copy that has tiles
 * but no markers.
 */
export const WORLD_BOUNDS: LatLngBoundsLiteral = [
  [-MERCATOR_MAX_LAT, -180],
  [MERCATOR_MAX_LAT, 180],
];
