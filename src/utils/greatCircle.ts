/**
 * Great-circle geometry helpers for the Terrain Link Profile feature (#4111).
 * Kept pure and react-free (mirrors `measureDistance.ts`) so they are trivially
 * unit-testable and reusable by the server-side elevation service (Phase 2).
 *
 * Distance-only math (Haversine) already lives in `./distance` — reuse
 * `calculateDistance` from there rather than reimplementing it here. This file
 * only adds what does not exist yet: point *interpolation* along a great
 * circle, and Web-Mercator slippy-tile conversion.
 */

/** A simple lat/lng coordinate pair (degrees). */
export interface LatLng {
  lat: number;
  lng: number;
}

/** Maximum Web-Mercator latitude — beyond this the projection diverges. */
const MAX_MERCATOR_LAT = 85.0511;

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

function toDegrees(radians: number): number {
  return radians * (180 / Math.PI);
}

/**
 * Spherical-linear (great-circle) interpolation of `count` points from a→b,
 * inclusive of both endpoints (`count >= 2`). Operates in 3D unit-vector
 * space so it is antimeridian-safe by construction — there is no lng
 * wraparound branch to get wrong, the vectors are simply converted back to
 * [-180, 180] longitude with `atan2`.
 *
 * When `a` and `b` are coincident (or antipodal enough that the angular
 * distance rounds to ~0), `sin(angularDistance)` is ~0 and would divide by
 * zero in the standard slerp formula — guard that case and return `count`
 * copies of `a` instead of NaN. Callers are expected to reject identical
 * points upstream (see elevationService validation), but this function must
 * never produce NaN regardless.
 */
export function interpolateGreatCircle(a: LatLng, b: LatLng, count: number): LatLng[] {
  const latA = toRadians(a.lat);
  const lngA = toRadians(a.lng);
  const latB = toRadians(b.lat);
  const lngB = toRadians(b.lng);

  // Cartesian unit vectors on the sphere.
  const ax = Math.cos(latA) * Math.cos(lngA);
  const ay = Math.cos(latA) * Math.sin(lngA);
  const az = Math.sin(latA);

  const bx = Math.cos(latB) * Math.cos(lngB);
  const by = Math.cos(latB) * Math.sin(lngB);
  const bz = Math.sin(latB);

  // Angular distance between the two points via the haversine of the dot product.
  const dot = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz));
  const angularDistance = Math.acos(dot);
  const sinD = Math.sin(angularDistance);

  const points: LatLng[] = [];
  const denom = Math.max(count - 1, 1);

  for (let i = 0; i < count; i++) {
    const f = i / denom;

    let x: number, y: number, z: number;
    if (Math.abs(sinD) < 1e-10) {
      // a ≈ b (or antipodal edge case): no well-defined arc, hold at `a`.
      x = ax;
      y = ay;
      z = az;
    } else {
      const A = Math.sin((1 - f) * angularDistance) / sinD;
      const B = Math.sin(f * angularDistance) / sinD;
      x = A * ax + B * bx;
      y = A * ay + B * by;
      z = A * az + B * bz;
    }

    const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
    const lng = Math.atan2(y, x);
    points.push({ lat: toDegrees(lat), lng: toDegrees(lng) });
  }

  return points;
}

/** Clamp latitude to the Web-Mercator projectable range (±85.0511°). */
function clampMercatorLat(lat: number): number {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

/**
 * Web-Mercator slippy-map tile indices for a coordinate at zoom `z`.
 * Standard slippy-map formula: `n = 2^z`, `x = floor((lng+180)/360 * n)`,
 * `y = floor((1 - asinh(tan(latRad))/π)/2 * n)`. Latitude is clamped to
 * ±85.0511° before conversion (beyond that the projection diverges).
 */
export function lngLatToTile(lat: number, lng: number, z: number): { x: number; y: number } {
  const clampedLat = clampMercatorLat(lat);
  const n = Math.pow(2, z);
  const latRad = toRadians(clampedLat);

  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);

  return { x, y };
}

/**
 * Fractional pixel position of a coordinate within a `tileSize`-px slippy
 * tile at zoom `z`. Returns the tile indices alongside the integer pixel
 * offset `[0, tileSize)` within that tile.
 */
export function lngLatToTilePixel(
  lat: number,
  lng: number,
  z: number,
  tileSize: number
): { x: number; y: number; px: number; py: number } {
  const clampedLat = clampMercatorLat(lat);
  const n = Math.pow(2, z);
  const latRad = toRadians(clampedLat);

  const xFrac = ((lng + 180) / 360) * n;
  const yFrac = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;

  const x = Math.floor(xFrac);
  const y = Math.floor(yFrac);

  const px = Math.min(tileSize - 1, Math.floor((xFrac - x) * tileSize));
  const py = Math.min(tileSize - 1, Math.floor((yFrac - y) * tileSize));

  return { x, y, px, py };
}
