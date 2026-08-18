/**
 * Geometry + color for the GNSS DOP overlay (#4729).
 *
 * Kept out of the component module so `GnssDopLayer.tsx` exports only its
 * component (react-refresh cannot fast-refresh a mixed module), and so the pure
 * math (step sizing, GDOP→color) is unit-testable without a map.
 *
 * GDOP — Geometric Dilution of Precision — measures how satellite geometry
 * amplifies ranging error into position error. Lower is better: ~1 is ideal,
 * ≲2 is good, ~4 is moderate, ≳6 is poor. It depends on WHERE and WHEN you are
 * (which satellites are above the horizon), not on terrain — so the overlay
 * recomputes as time changes, not as elevation does.
 */
import type { DopGridPoint } from '../../../services/api';

/**
 * User-controllable DOP overlay parameters (the panel's inputs). Distinct from
 * the wire request `DopGridParams` (which also carries the map-derived bbox +
 * stepDeg): this is only the part a person sets. `timeMs` is absolute epoch ms
 * — satellite geometry moves with time, so this is the key control the panel
 * adds over the Site Planner.
 */
export interface GnssDopUiParams {
  maskDeg: number;
  timeMs: number;
  constellations: string[];
}

/** What the layer reports back up after a fetch, for the panel's legend/notice. */
export interface GnssDopMeta {
  clamped: boolean;
  stepDeg: number;
  requestedStepDeg: number;
  cellCount: number;
  loading: boolean;
  error: string | null;
}

/** Server cap on grid cells (`MAX_GRID_CELLS` in gnssRoutes). We size our step
 *  to land under this so the server rarely has to coarsen (which loses us
 *  resolution and trips the `clamped` notice). */
export const DOP_MAX_CELLS = 2500;

/** Target cells per axis. `40*40 = 1600` stays comfortably under the 2500 cap
 *  even when both axes are near-full, while still giving a smooth heatmap. */
const TARGET_CELLS_PER_AXIS = 40;

/** Never ask for a grid finer than this. At high zoom the viewport is tiny and
 *  DOP barely varies across it, so a very fine grid is wasted server compute. */
const MIN_STEP_DEG = 0.02;

/** GDOP breakpoints for the color ramp. */
export const DOP_GOOD = 2;
export const DOP_MODERATE = 4;
export const DOP_POOR = 6;

/**
 * Step (degrees) for a bbox of the given spans, sized to stay near — but under
 * — the server's cell cap. Uses the larger span so the finer axis is never the
 * one that blows the budget, and clamps to a sensible minimum.
 */
export function computeDopStepDeg(latSpan: number, lonSpan: number): number {
  const span = Math.max(Math.abs(latSpan), Math.abs(lonSpan));
  if (!Number.isFinite(span) || span <= 0) return MIN_STEP_DEG;
  return Math.max(MIN_STEP_DEG, span / TARGET_CELLS_PER_AXIS);
}

/**
 * Rectangle bounds (Leaflet `[[south,west],[north,east]]`) for a grid cell
 * centered on its point, so the filled cells tile the map without gaps.
 */
export function dopCellBounds(
  lat: number,
  lon: number,
  stepDeg: number,
): [[number, number], [number, number]] {
  const h = stepDeg / 2;
  return [
    [lat - h, lon - h],
    [lat + h, lon + h],
  ];
}

/** Linear interpolation between two hex colors at t ∈ [0,1]. */
function lerpColor(a: [number, number, number], b: [number, number, number], t: number): string {
  const c = a.map((av, i) => Math.round(av + (b[i] - av) * t));
  return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

const GREEN: [number, number, number] = [0x2e, 0xcc, 0x40]; // good
const AMBER: [number, number, number] = [0xff, 0xc1, 0x07]; // moderate
const RED: [number, number, number] = [0xe7, 0x4c, 0x3c]; // poor

/**
 * Color for a GDOP value on a good→poor ramp: green at/below `DOP_GOOD`,
 * through amber at `DOP_MODERATE`, to red at/above `DOP_POOR`. A null GDOP
 * (no solution — too few satellites) is a neutral gray, deliberately distinct
 * from any point on the good/poor ramp so "unsolvable" never reads as "poor".
 */
export function gdopToColor(gdop: number | null): string {
  if (gdop == null || !Number.isFinite(gdop)) return '#9aa0a6';
  if (gdop <= DOP_GOOD) return lerpColor(GREEN, GREEN, 0);
  if (gdop >= DOP_POOR) return lerpColor(RED, RED, 0);
  if (gdop <= DOP_MODERATE) {
    return lerpColor(GREEN, AMBER, (gdop - DOP_GOOD) / (DOP_MODERATE - DOP_GOOD));
  }
  return lerpColor(AMBER, RED, (gdop - DOP_MODERATE) / (DOP_POOR - DOP_MODERATE));
}

/** Stable key for a cell, so React can diff the rendered rectangles. */
export function dopCellKey(p: DopGridPoint): string {
  return `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
}
