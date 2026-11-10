/**
 * Point-in-polygon over the typed arrays in {@link Admin1Data} (#6336).
 *
 * Inputs are integer coordinates (degrees x COORD_SCALE), so the answer does
 * not depend on platform float quirks. The finder may not import
 * `automation/geo.ts`, and the shared helpers take object arrays, so this is
 * its own small ray-cast.
 */

import { COORD_SCALE, type Admin1Data } from './codec.js';

/** Kilometres per degree of latitude (mean Earth radius 6371 km). */
const KM_PER_DEG = (6371 * Math.PI) / 180;
const KM_PER_UNIT = KM_PER_DEG / COORD_SCALE;

/** A point outside every polygon may take the nearest one within this distance. */
export const SUBDIVISION_FALLBACK_KM = 10;

/**
 * Even-odd ray cast over every ring of a feature. Holes and multipolygons come
 * out right because a dissolved feature's rings never overlap.
 */
export function pointInFeature(d: Admin1Data, f: number, x: number, y: number): boolean {
  const { coords, ringStart } = d;
  let inside = false;
  for (let r = d.featRing[f]; r < d.featRing[f + 1]; r++) {
    const s = ringStart[r];
    const e = ringStart[r + 1];
    if (e - s < 3) continue;
    let j = e - 1;
    for (let i = s; i < e; i++) {
      const xi = coords[i * 2];
      const yi = coords[i * 2 + 1];
      const xj = coords[j * 2];
      const yj = coords[j * 2 + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      j = i;
    }
  }
  return inside;
}

/** Shortest distance in km from the point to any edge of the feature. */
export function edgeDistanceKm(d: Admin1Data, f: number, x: number, y: number): number {
  const { coords, ringStart } = d;
  // Local equirectangular projection around the point: fine at 10 km.
  const ky = KM_PER_UNIT;
  const kx = KM_PER_UNIT * Math.cos((y / COORD_SCALE) * (Math.PI / 180));
  let best = Infinity;
  for (let r = d.featRing[f]; r < d.featRing[f + 1]; r++) {
    const s = ringStart[r];
    const e = ringStart[r + 1];
    let j = e - 1;
    for (let i = s; i < e; i++) {
      const ax = (coords[j * 2] - x) * kx;
      const ay = (coords[j * 2 + 1] - y) * ky;
      const bx = (coords[i * 2] - x) * kx;
      const by = (coords[i * 2 + 1] - y) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const dist = Math.sqrt(px * px + py * py);
      if (dist < best) best = dist;
      j = i;
    }
  }
  return best;
}

/** Order key for ties: the ISO 3166-2 code, or the country code for country-only areas. */
export function featureKey(d: Admin1Data, f: number): string {
  const feat = d.features[f];
  return feat.code ?? feat.cc;
}

/** Code-unit order, so no locale can change a tie-break. */
function keyLess(a: string, b: string): boolean {
  return a < b;
}

/**
 * Feature index holding the point, or -1.
 *
 * A point inside several features takes the lowest code. A point inside none
 * (a pier, a beach the simplified coastline cut off) takes the nearest
 * feature edge within `fallbackKm`, ties again to the lowest code.
 */
export function locateFeature(d: Admin1Data, x: number, y: number, fallbackKm: number): number {
  const n = d.features.length;
  const { bbox } = d;
  let hit = -1;
  for (let f = 0; f < n; f++) {
    const b = f * 4;
    if (x < bbox[b] || x > bbox[b + 2] || y < bbox[b + 1] || y > bbox[b + 3]) continue;
    if (!pointInFeature(d, f, x, y)) continue;
    if (hit === -1 || keyLess(featureKey(d, f), featureKey(d, hit))) hit = f;
  }
  if (hit !== -1 || fallbackKm <= 0) return hit;

  const marginY = Math.ceil(fallbackKm / KM_PER_UNIT);
  const cos = Math.cos((y / COORD_SCALE) * (Math.PI / 180));
  const marginX = Math.ceil(fallbackKm / (KM_PER_UNIT * Math.max(cos, 0.01)));
  let bestDist = Infinity;
  for (let f = 0; f < n; f++) {
    const b = f * 4;
    if (
      x < bbox[b] - marginX ||
      x > bbox[b + 2] + marginX ||
      y < bbox[b + 1] - marginY ||
      y > bbox[b + 3] + marginY
    ) {
      continue;
    }
    const dist = edgeDistanceKm(d, f, x, y);
    if (dist > fallbackKm) continue;
    if (dist < bestDist || (dist === bestDist && keyLess(featureKey(d, f), featureKey(d, hit)))) {
      bestDist = dist;
      hit = f;
    }
  }
  return hit;
}
