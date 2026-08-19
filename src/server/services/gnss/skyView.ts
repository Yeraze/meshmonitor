/**
 * GNSS sky-view + DOP compute (#4729, backend foundation).
 *
 * Pure, side-effect-free functions that turn a set of TLEs + an observer point
 * + an instant into the satellites currently above the horizon (per an
 * elevation mask) and the geometric dilution-of-precision (DOP) implied by
 * their sky geometry.
 *
 * No network, no database, no clock — everything is a function of the inputs,
 * so the whole module is trivially unit-testable against a fixed TLE fixture
 * and a fixed `Date`.
 *
 * Pipeline (validated against live CelesTrak GPS data):
 *   twoline2satrec -> propagate(date) -> eciToEcf(gstime) -> ecfToLookAngles
 * yields az/el (radians) + slant range (km) for each satellite relative to the
 * observer. A satellite counts as visible when its elevation >= the mask.
 *
 * DOP is derived from the visible satellites' line-of-sight unit vectors in the
 * local ENU frame: for each visible sat, design-matrix row `[-e, -n, -u, 1]`,
 * then `Q = (AᵀA)⁻¹`. GDOP/PDOP/HDOP/VDOP are square roots of sums of the
 * diagonal of `Q` (ENU order East, North, Up = indices 0, 1, 2). Fewer than 4
 * visible satellites (or a singular `AᵀA`) leaves DOP undefined -> `null`.
 */

import {
  twoline2satrec,
  propagate,
  gstime,
  eciToEcf,
  ecfToLookAngles,
} from 'satellite.js';
import { logger } from '../../../utils/logger.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** A parsed two-line element set (name + the two orbital data lines). */
export interface Tle {
  name: string;
  line1: string;
  line2: string;
}

/** Observer ground position. Latitude/longitude in degrees, altitude in km. */
export interface ObserverPoint {
  latDeg: number;
  lonDeg: number;
  altKm: number;
}

/** One satellite currently above the elevation mask, as seen from the observer. */
export interface SkyViewSatellite {
  name: string;
  /** Azimuth in degrees, normalized to [0, 360). */
  azDeg: number;
  /** Elevation in degrees, [mask, 90]. */
  elDeg: number;
  /** Slant range observer->satellite in km. */
  rangeKm: number;
}

/** Geometric dilution-of-precision factors (dimensionless, >= 1 for real geometry). */
export interface Dop {
  gdop: number;
  pdop: number;
  hdop: number;
  vdop: number;
}

export interface SkyViewResult {
  satellites: SkyViewSatellite[];
  dop: Dop | null;
  visibleCount: number;
}

export interface ComputeSkyViewInput {
  tles: Tle[];
  observer: ObserverPoint;
  date: Date;
  elevationMaskDeg: number;
}

/**
 * Invert a 4x4 matrix via Gauss-Jordan elimination with partial pivoting.
 * Returns `null` when the matrix is singular (or numerically so) — which is the
 * DOP "undefined geometry" signal for callers.
 */
export function invert4x4(m: number[][]): number[][] | null {
  const n = 4;
  // Augment [M | I].
  const a: number[][] = m.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col++) {
    // Partial pivot: pick the row with the largest magnitude in this column.
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null; // singular
    if (pivot !== col) {
      const tmp = a[col];
      a[col] = a[pivot];
      a[pivot] = tmp;
    }

    const pv = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= pv;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= factor * a[col][j];
    }
  }

  return a.map((row) => row.slice(n));
}

/**
 * Compute DOP from visible satellites' az/el (degrees). Returns `null` when
 * there are fewer than 4 satellites or the geometry matrix is singular.
 *
 * ENU convention: East, North, Up map to `Q` diagonal indices 0, 1, 2; the
 * clock/time term is index 3.
 */
export function computeDop(
  sats: Array<{ azDeg: number; elDeg: number }>
): Dop | null {
  if (sats.length < 4) return null;

  // AᵀA accumulated directly (each row contributes an outer product).
  const ata = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];

  for (const { azDeg, elDeg } of sats) {
    const el = elDeg * DEG2RAD;
    const az = azDeg * DEG2RAD;
    const e = Math.cos(el) * Math.sin(az);
    const north = Math.cos(el) * Math.cos(az);
    const up = Math.sin(el);
    const row = [-e, -north, -up, 1];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        ata[i][j] += row[i] * row[j];
      }
    }
  }

  const q = invert4x4(ata);
  if (!q) return null;

  const gdop = Math.sqrt(q[0][0] + q[1][1] + q[2][2] + q[3][3]);
  const pdop = Math.sqrt(q[0][0] + q[1][1] + q[2][2]);
  const hdop = Math.sqrt(q[0][0] + q[1][1]);
  const vdop = Math.sqrt(q[2][2]);

  if (![gdop, pdop, hdop, vdop].every(Number.isFinite)) return null;
  return { gdop, pdop, hdop, vdop };
}

/**
 * Compute the sky view (visible satellites + DOP) for a single observer point
 * and instant, given a set of TLEs.
 *
 * A malformed TLE, or a satellite whose SGP4 propagation errors out at this
 * instant (`propagate().position === false`), is skipped rather than aborting
 * the whole computation — one bad element never fails the request.
 */
export function computeSkyView(input: ComputeSkyViewInput): SkyViewResult {
  const { tles, observer, date, elevationMaskDeg } = input;

  const observerGd = {
    longitude: observer.lonDeg * DEG2RAD,
    latitude: observer.latDeg * DEG2RAD,
    height: observer.altKm,
  };
  const gmst = gstime(date);

  const satellites: SkyViewSatellite[] = [];

  for (const tle of tles) {
    let look;
    try {
      const satrec = twoline2satrec(tle.line1, tle.line2);
      const pv = propagate(satrec, date);
      // `position` is `false` when SGP4 fails (decayed/invalid element).
      if (!pv || !pv.position || typeof pv.position === 'boolean') continue;
      const ecf = eciToEcf(pv.position, gmst);
      look = ecfToLookAngles(observerGd, ecf);
    } catch (err) {
      logger.debug(`[GNSS] Skipping TLE "${tle.name}" — propagation failed:`, err);
      continue;
    }

    const elDeg = look.elevation * RAD2DEG;
    if (!Number.isFinite(elDeg) || elDeg < elevationMaskDeg) continue;

    let azDeg = look.azimuth * RAD2DEG;
    if (azDeg < 0) azDeg += 360;

    satellites.push({
      name: tle.name,
      azDeg,
      elDeg,
      rangeKm: look.rangeSat,
    });
  }

  const dop = computeDop(satellites);

  return {
    satellites,
    dop,
    visibleCount: satellites.length,
  };
}
