/**
 * Deterministic within-cell offset for obscured (low-precision) GPS node markers
 * on the Map Analysis map (issue #4016).
 *
 * Meshtastic's `precision_bits` snaps a reported position to a grid cell; the
 * true position could be anywhere inside that cell. Rendering the marker at the
 * dead-center of the cell implies precision the node never reported and stacks
 * same-cell nodes on one point. Instead we deterministically jitter each such
 * marker to a stable spot *within* its own cell — more honest, and it declutters
 * same-cell piles without a click.
 *
 * The cell-size math mirrors the accuracy-region rectangle drawn on the Dashboard
 * map (`DashboardMap.tsx`) and `formatPrecisionAccuracy` (`utils/distance.ts`),
 * so an offset marker always lands inside the drawn rectangle.
 */
import { djb2Hash } from './loraFrequency';

/** Meters per degree of latitude (matches DashboardMap / distance.ts). */
const METERS_PER_DEGREE = 111_111;

/**
 * Precision bits at/below which the accuracy cell is large enough (~180m+) that
 * centering is misleading and offsetting is worthwhile. At 18 bits the cell side
 * is `2^(32-18) * 1e-7 * 111111 ≈ 182m`.
 */
export const OBSCURED_PRECISION_MAX_BITS = 18;

/** Full accuracy-cell side length in meters for a given precision. */
export function precisionCellSizeMeters(bits: number): number {
  return Math.pow(2, 32 - bits) * 1e-7 * METERS_PER_DEGREE;
}

/** Full accuracy-cell side length in degrees of latitude. */
export function precisionCellSizeDegrees(bits: number): number {
  return Math.pow(2, 32 - bits) * 1e-7;
}

/**
 * Whether a node has a meaningful accuracy cell to draw a rectangle for: a
 * defined, non-full precision (1..31 bits) that isn't a user override. Broader
 * than {@link shouldOffsetForPrecision} — the marker is only *offset* for large
 * cells (≤18 bits), but the accuracy square is drawn for any imprecise fix.
 */
export function hasAccuracyCell(
  bits: number | null | undefined,
  isOverride: boolean | null | undefined,
): boolean {
  if (isOverride) return false;
  if (bits == null) return false;
  return bits > 0 && bits < 32;
}

/**
 * Whether a node's marker should be offset within its precision cell.
 * Only nodes with a *defined* low precision (1..MAX bits) qualify; nodes with a
 * user-overridden position, missing/zero precision, or fine GPS are left at their
 * exact reported point.
 */
export function shouldOffsetForPrecision(
  bits: number | null | undefined,
  isOverride: boolean | null | undefined,
): bits is number {
  if (isOverride) return false;
  if (bits == null) return false;
  return bits >= 1 && bits <= OBSCURED_PRECISION_MAX_BITS;
}

/**
 * Accuracy-region rectangle bounds `[[latMin, lngMin], [latMax, lngMax]]` for a
 * position at (lat, lng) with the given precision. The reported position is the
 * cell center; the rectangle spans ± half a cell. Mirrors the Dashboard map's
 * accuracy-region math so both maps draw the identical square.
 */
export function precisionCellBounds(
  lat: number,
  lng: number,
  bits: number,
): [[number, number], [number, number]] {
  const halfMeters = precisionCellSizeMeters(bits) / 2;
  const latOffset = halfMeters / METERS_PER_DEGREE;
  const metersPerDegreeLng = METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  const lngOffset = metersPerDegreeLng !== 0 ? halfMeters / metersPerDegreeLng : halfMeters / METERS_PER_DEGREE;
  return [
    [lat - latOffset, lng - lngOffset],
    [lat + latOffset, lng + lngOffset],
  ];
}

/**
 * Deterministically offset (lat, lng) to a stable point within the node's
 * accuracy cell. The offset is a pure function of `id`, so it is identical across
 * re-renders/polls (the marker never jumps). The result stays within
 * `± halfCell` of the input — i.e. inside the accuracy rectangle.
 */
export function offsetWithinPrecisionCell(
  lat: number,
  lng: number,
  bits: number,
  id: string,
): [number, number] {
  const sizeDeg = precisionCellSizeDegrees(bits);
  // Two independent fractions in [0,1) from one id.
  const fx = (djb2Hash(id) % 1_000_000) / 1_000_000;
  const fy = (djb2Hash(`${id}:y`) % 1_000_000) / 1_000_000;
  const latOffset = (fx - 0.5) * sizeDeg;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Longitude degrees shrink with latitude; guard the poles (cos→0).
  const lngSizeDeg = cosLat !== 0 ? sizeDeg / cosLat : sizeDeg;
  const lngOffset = (fy - 0.5) * lngSizeDeg;
  return [lat + latOffset, lng + lngOffset];
}

/**
 * Stable key identifying the accuracy cell a reported position falls in, used to
 * count how many nodes share a cell before deciding whether to offset (issue
 * #4155). Firmware snaps an obscured position to its cell, so same-cell nodes of
 * the same precision report identical coordinates and floor to identical grid
 * indices. `bits` is part of the key because a different precision means a
 * different cell size — i.e. a different cell — so two nodes only "share a cell"
 * when both their snapped position AND their precision match.
 */
export function precisionCellKey(lat: number, lng: number, bits: number): string {
  const size = precisionCellSizeDegrees(bits);
  const latIdx = Math.floor(lat / size);
  const lngIdx = Math.floor(lng / size);
  return `${bits}:${latIdx}:${lngIdx}`;
}
