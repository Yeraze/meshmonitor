/**
 * Obstruction / clearance analysis over an elevation profile for the Terrain
 * Link Profile tool (epic #4111, Phase 2, WP-A). Pure and react-free —
 * consumes the samples already fetched from `POST /api/elevation/profile`
 * (via `useElevationProfile`) and derives a chart-ready point series plus a
 * link verdict. No network IO here.
 *
 * See `docs/internal/dev-notes/LINK_PROFILE_TOOL_SPEC.md` §0/§2.2 for the
 * design rationale (terrain + AGL baseline, not node GPS altitude) and the
 * locked math walkthrough this file implements.
 */
import type { MeasurePoint } from './measureDistance';
import type { ElevationSample } from '../types/elevation';
import {
  fresnelRadiusMeters,
  earthBulgeMeters,
  DEFAULT_K_FACTOR,
  EARTH_RADIUS_M,
} from './linkBudget';

/** A picked endpoint for the Link Profile tool. `isNode=false` = arbitrary map point. */
export interface LinkEndpoint extends MeasurePoint {
  isNode: boolean;
  /** Source that reported the node endpoint, for per-source auto-frequency (#4111 P3). */
  sourceId?: string;
  /**
   * Every source that reported this node — newest-first, primary (`sourceId`)
   * first (#4111 P3 WP-2 follow-up). A unified-merged node's bare `sourceId`
   * is whichever source last reported it, which for a multi-source node is
   * frequently an MQTT bridge with no local radio (`radio: null`). Auto-
   * frequency detection must walk this full list to find a radio-reporting
   * source instead of giving up on the (possibly radio-less) primary.
   */
  sourceIds?: string[];
  /** Node number of the picked node endpoint (#4111 P3). */
  nodeNum?: number;
  /** True when the node endpoint is a MeshCore node (#4111 P3). */
  isMeshCore?: boolean;
  /**
   * The node's reported altitude in metres (effective value — position
   * overrides are folded in by the API). Used only to SEED the editable
   * antenna-AGL inputs via `aglFromNodeAltitude`; the profile math itself
   * stays DEM + AGL (see LINK_PROFILE_TOOL_SPEC.md §0/§2.2 — node altitude
   * never feeds the model directly because of the GPS-vs-DEM datum mismatch).
   */
  altitudeM?: number;
}

/**
 * Suggested antenna height AGL from a node's reported altitude and the DEM
 * ground elevation at its endpoint: `altitude - ground`, rounded. Returns
 * null (caller keeps the default) when either value is missing/non-finite or
 * the difference is below 0.5 m — a negative or near-zero difference is
 * indistinguishable from GPS/datum error and must not shrink the antenna
 * below the documented 2 m default.
 */
export function aglFromNodeAltitude(
  altitudeM: number | null | undefined,
  groundM: number | null | undefined,
): number | null {
  if (typeof altitudeM !== 'number' || !Number.isFinite(altitudeM)) return null;
  if (typeof groundM !== 'number' || !Number.isFinite(groundM)) return null;
  const agl = altitudeM - groundM;
  if (agl < 0.5) return null;
  return Math.round(agl);
}

// Client mirror of the backend `ProfileSample` (kept in `types/elevation.ts`
// as the single definition — re-exported here since most consumers of this
// module reach for the type via `linkProfile.ts`).
export type { ElevationSample };

export type LinkVerdict = 'clear' | 'marginal' | 'obstructed';

/**
 * Shared verdict copy/coloring, promoted from `LinkProfileDrawer.tsx`'s local
 * consts (#4111 P3 WP-1) so the map-path Polyline (a later work package) can
 * reuse the same values the drawer displays. The drawer keeps its own local
 * copies for now — a later package switches it to import these.
 */
export const VERDICT_LABEL: Record<LinkVerdict, string> = {
  clear: 'Clear',
  marginal: 'Marginal',
  obstructed: 'Obstructed',
};

export const VERDICT_COLOR: Record<LinkVerdict, string> = {
  clear: '#22c55e',
  marginal: '#f59e0b',
  obstructed: '#ef4444',
};

/** Fraction of the first Fresnel zone that must remain clear to call a link "clear" (not just "marginal"). */
export const DEFAULT_FRESNEL_CLEAR_THRESHOLD = 0.6;

export interface LinkProfileOptions {
  freqMhz: number;
  /** AGL antenna height in metres at endpoint A (start of the profile). */
  antennaHeightAglAM: number;
  /** AGL antenna height in metres at endpoint B (end of the profile). */
  antennaHeightAglBM: number;
  /** Earth-curvature refraction k-factor. Default 4/3. */
  kFactor?: number;
  /** Earth radius in metres. Default mean Earth radius. */
  earthRadiusM?: number;
  /** Minimum fraction of the first Fresnel zone that must be clear for `verdict:'clear'`. Default 0.6. */
  fresnelClearThreshold?: number;
}

/** One chart-ready row for the profile. Elevations in metres, `distanceKm` for the X axis. */
export interface LinkProfilePoint {
  distanceKm: number;
  /** Raw DEM elevation for this sample; null when the DEM had no data. */
  terrain: number | null;
  /** terrain + earth-curvature bulge — what LOS clearance is judged against. Null when `terrain` is null. */
  effectiveTerrain: number | null;
  /** Straight line between the two antenna tops at this sample's distance. */
  los: number;
  /** los - first-Fresnel-zone radius (lower bound of the Fresnel ellipse). */
  fresnelLower: number;
  /** true when effectiveTerrain exceeds los at this sample (clearance < 0). Always false when terrain is null. */
  obstructed: boolean;
}

export interface LinkProfileAnalysis {
  points: LinkProfilePoint[];
  totalDistanceKm: number;
  verdict: LinkVerdict;
  /** Tightest interior (non-endpoint, non-null) sample by clearance ratio. Null if no usable interior samples. */
  worst: { distanceKm: number; clearanceM: number; clearanceRatio: number } | null;
  /** min(clearance / fresnelRadius) across interior samples, as a percent (may be negative). Infinity when `worst` is null. */
  fresnelClearancePct: number;
  /** ground(A) + AGL(A). */
  antennaTopAM: number;
  /** ground(B) + AGL(B). */
  antennaTopBM: number;
}

/**
 * Pure geometry/obstruction analysis over already-fetched elevation samples.
 * Antenna tops = terrain at each endpoint + AGL (node GPS altitude
 * intentionally not used — see spec §0.1). Earth curvature raises the
 * effective terrain height toward the straight LOS chord
 * (`effectiveTerrain = terrain + bulge`).
 *
 * Endpoints (first/last sample) and any sample with a null `elevation` are
 * excluded from the worst-case/verdict classification, but every input
 * sample still produces one output point (for continuous chart rendering).
 *
 * Classification (first match wins):
 *   'obstructed' — some interior sample has effectiveTerrain > los (clearance < 0)
 *   'marginal'   — LOS is clear everywhere, but min(clearance/fresnelRadius) < threshold
 *   'clear'      — min(clearance/fresnelRadius) >= threshold (or no interior samples at all)
 */
export function analyzeLinkProfile(
  samples: ElevationSample[],
  opts: LinkProfileOptions,
): LinkProfileAnalysis {
  const kFactor = opts.kFactor ?? DEFAULT_K_FACTOR;
  const earthRadiusM = opts.earthRadiusM ?? EARTH_RADIUS_M;
  const threshold = opts.fresnelClearThreshold ?? DEFAULT_FRESNEL_CLEAR_THRESHOLD;

  if (samples.length === 0) {
    return {
      points: [],
      totalDistanceKm: 0,
      verdict: 'clear',
      worst: null,
      fresnelClearancePct: Infinity,
      antennaTopAM: opts.antennaHeightAglAM,
      antennaTopBM: opts.antennaHeightAglBM,
    };
  }

  const total = samples[samples.length - 1].distance;
  const groundA = samples[0].elevation ?? 0;
  const groundB = samples[samples.length - 1].elevation ?? 0;
  const antennaTopA = groundA + opts.antennaHeightAglAM;
  const antennaTopB = groundB + opts.antennaHeightAglBM;

  const lastIndex = samples.length - 1;
  const points: LinkProfilePoint[] = [];
  let worst: { distanceKm: number; clearanceM: number; clearanceRatio: number } | null = null;
  let anyObstructed = false;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const d1 = sample.distance;
    const d2 = total - d1;
    const frac = total > 0 ? d1 / total : 0;

    const los = antennaTopA + (antennaTopB - antennaTopA) * frac;
    const bulge = earthBulgeMeters(d1, d2, kFactor, earthRadiusM);
    const terrain = sample.elevation;
    const effectiveTerrain = terrain === null ? null : terrain + bulge;
    const fresnelR = fresnelRadiusMeters(1, opts.freqMhz, d1, d2);
    const fresnelLower = los - fresnelR;

    const obstructed = effectiveTerrain !== null && effectiveTerrain > los;

    points.push({
      distanceKm: d1 / 1000,
      terrain,
      effectiveTerrain,
      los,
      fresnelLower,
      obstructed,
    });

    // Interior, non-null samples only feed the worst-case/verdict classification.
    const isInterior = i > 0 && i < lastIndex;
    if (isInterior && effectiveTerrain !== null) {
      const clearanceM = los - effectiveTerrain;
      const clearanceRatio = fresnelR > 0 ? clearanceM / fresnelR : Number.POSITIVE_INFINITY;
      if (clearanceM < 0) anyObstructed = true;
      if (worst === null || clearanceRatio < worst.clearanceRatio) {
        worst = { distanceKm: d1 / 1000, clearanceM, clearanceRatio };
      }
    }
  }

  let verdict: LinkVerdict;
  const fresnelClearancePct = worst ? worst.clearanceRatio * 100 : Infinity;
  if (worst === null) {
    verdict = 'clear';
  } else if (anyObstructed) {
    verdict = 'obstructed';
  } else if (worst.clearanceRatio < threshold) {
    verdict = 'marginal';
  } else {
    verdict = 'clear';
  }

  return {
    points,
    totalDistanceKm: total / 1000,
    verdict,
    worst,
    fresnelClearancePct,
    antennaTopAM: antennaTopA,
    antennaTopBM: antennaTopB,
  };
}
