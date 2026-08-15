/**
 * Predictive RF coverage sweep (#4727).
 *
 * Walks outward from a transmitter along evenly spaced azimuths, sampling
 * terrain and asking `evaluateLink` where the link stops closing. The result is
 * one reach distance per azimuth — a star polygon the map can draw.
 *
 * **What "reach" means here, precisely.** Each radial reports the distance at
 * which the link FIRST fails, not the farthest point that happens to close.
 * Coverage is not monotonic: a hilltop 20 km out can be reachable while the
 * valley at 8 km is not. Reporting the farthest closing sample would draw a
 * polygon implying everything inside it works, which is a stronger claim than
 * the model supports. First-failure is the conservative reading, and
 * `reachablePocketsBeyond` flags the radials where something further out does
 * close — visible rather than silently discarded.
 *
 * **Server-side by design.** The DEM tiles and their LRU cache live here, and a
 * sweep re-reads the same tiles across adjacent azimuths; doing this in the
 * browser would refetch terrain per client. Bounded hard (radius, azimuths,
 * samples) so one request cannot turn into an unbounded terrain scan.
 *
 * Everything here inherits the modelling caveats in `propagation.ts`. This
 * predicts; it does not measure.
 */
import { destinationPoint, type LatLng } from '../../../utils/greatCircle.js';
import { resolveProvider } from '../elevationProvider.js';
import { evaluateLink, type LinkBudget, type TerrainSample } from './propagation.js';
import { logger } from '../../../utils/logger.js';

export interface CoverageParams {
  origin: LatLng;
  /** Antenna heights above ground, metres. */
  txHeightM: number;
  /** Assumed height of the receiving node — a peer radio, not a base station. */
  rxHeightM: number;
  frequencyHz: number;
  budget: LinkBudget;
  radiusKm: number;
  /** Number of radials. More is smoother and proportionally more expensive. */
  azimuthCount: number;
  /** Terrain samples per radial. */
  samplesPerRadial: number;
}

export interface RadialReach {
  bearingDeg: number;
  /** Distance at which the link first fails, km. Equals radiusKm if it never does. */
  reachKm: number;
  /** True when the link still closed at the maximum radius — reach is a floor, not a limit. */
  limitedByRadius: boolean;
  /** True when a sample beyond the first failure still closed. */
  reachablePocketsBeyond: boolean;
  /** True when terrain data was missing along this radial. */
  hasDataGaps: boolean;
}

export interface CoverageResult {
  origin: LatLng;
  radiusKm: number;
  generatedAt: number;
  model: 'fresnel-path-loss';
  radials: RadialReach[];
  /** Human-readable statements the UI must surface alongside the polygon. */
  assumptions: string[];
}

export const MAX_RADIUS_KM = 50;
export const MAX_AZIMUTHS = 180;
export const MAX_SAMPLES_PER_RADIAL = 256;

/**
 * Hard ceiling on terrain points per sweep.
 *
 * The per-axis caps alone allow 180 x 256 = 46,080 points, which is bounded but
 * far heavier than any useful sweep needs, and it leaves the real limit as an
 * emergent product of two numbers rather than a stated one. This is the stated
 * one: `azimuthCount * samplesPerRadial` is reduced to fit, so the array handed
 * to the elevation provider has a constant upper bound no combination of
 * request parameters can exceed.
 *
 * Added after CodeQL flagged `js/loop-bound-injection` — request values reached
 * the provider's iteration bound. They were already clamped, but through two
 * separate axes, which is neither obvious to an analyzer nor to a reader.
 */
export const MAX_TOTAL_SAMPLE_POINTS = 24_000;
export const DEFAULT_RADIUS_KM = 15;
export const DEFAULT_AZIMUTHS = 72;
export const DEFAULT_SAMPLES_PER_RADIAL = 96;

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function clampCoverageParams(raw: Partial<CoverageParams>): {
  radiusKm: number; azimuthCount: number; samplesPerRadial: number;
} {
  const radiusKm = clampInt(raw.radiusKm, 1, MAX_RADIUS_KM, DEFAULT_RADIUS_KM);
  const azimuthCount = clampInt(raw.azimuthCount, 8, MAX_AZIMUTHS, DEFAULT_AZIMUTHS);
  let samplesPerRadial = clampInt(raw.samplesPerRadial, 16, MAX_SAMPLES_PER_RADIAL, DEFAULT_SAMPLES_PER_RADIAL);

  // Trade resolution along each radial rather than dropping radials: a coarser
  // profile degrades the answer smoothly, whereas losing azimuths leaves gaps
  // in the polygon that look like real coverage holes.
  if (azimuthCount * samplesPerRadial > MAX_TOTAL_SAMPLE_POINTS) {
    samplesPerRadial = Math.max(16, Math.floor(MAX_TOTAL_SAMPLE_POINTS / azimuthCount));
  }

  return { radiusKm, azimuthCount, samplesPerRadial };
}

/**
 * The caveats that must travel with the numbers.
 *
 * Returned in the payload rather than hard-coded in the component so they
 * cannot drift apart from the model that produced them, and so any future
 * consumer of this API inherits them too.
 */
export function modelAssumptions(params: Pick<CoverageParams, 'rxHeightM' | 'txHeightM'>): string[] {
  return [
    'Predicted from terrain elevation only — this is a model, not measured coverage.',
    'Accounts for free-space loss, earth curvature and terrain diffraction.',
    'Does NOT account for buildings, foliage, multipath, or local interference.',
    `Assumes a ${params.txHeightM} m transmit antenna and a ${params.rxHeightM} m receiving antenna.`,
    'Real-world range routinely differs from this by tens of dB in both directions.',
  ];
}

/**
 * Evaluate one radial, returning where the link first fails.
 *
 * Walks outward evaluating the link to each successive sample. Cost is
 * quadratic in `samples.length` because each endpoint re-walks the profile
 * from the origin; that is why `samplesPerRadial` is bounded well below the
 * elevation service's own limit.
 */
export function analyseRadial(
  samples: TerrainSample[],
  params: Pick<CoverageParams, 'frequencyHz' | 'txHeightM' | 'rxHeightM' | 'budget'>,
  bearingDeg: number,
  radiusKm: number,
): RadialReach {
  const inputs = {
    frequencyHz: params.frequencyHz,
    txHeightM: params.txHeightM,
    rxHeightM: params.rxHeightM,
  };

  let firstFailureKm: number | null = null;
  let pocketsBeyond = false;
  let hasDataGaps = false;

  // Start at index 2: a single-segment profile has no interior terrain to
  // obstruct it, so it always closes and tells us nothing.
  for (let end = 2; end < samples.length; end++) {
    const slice = samples.slice(0, end + 1);
    const result = evaluateLink(slice, inputs, params.budget);
    if (result.hasDataGaps) hasDataGaps = true;

    if (!result.closes) {
      if (firstFailureKm === null) firstFailureKm = slice[end].distance / 1000;
    } else if (firstFailureKm !== null) {
      // Something closed beyond the first failure — a reachable pocket.
      pocketsBeyond = true;
    }
  }

  return {
    bearingDeg,
    reachKm: firstFailureKm ?? radiusKm,
    limitedByRadius: firstFailureKm === null,
    reachablePocketsBeyond: pocketsBeyond,
    hasDataGaps,
  };
}

/**
 * Run a full sweep.
 *
 * All radial points are sampled in ONE provider call so the tile grouping in
 * `TerrariumTileProvider.sample` sees the whole set at once — adjacent
 * azimuths share tiles heavily, and per-radial calls would refetch or at best
 * re-look-up each of them.
 */
export async function computeCoverage(
  params: CoverageParams,
  sourceUrl: string | undefined,
): Promise<CoverageResult> {
  const { radiusKm, azimuthCount, samplesPerRadial } = clampCoverageParams(params);
  const radiusM = radiusKm * 1000;

  // Build every radial's points up front.
  const perRadialPoints: LatLng[][] = [];
  for (let a = 0; a < azimuthCount; a++) {
    const bearing = (360 * a) / azimuthCount;
    const pts: LatLng[] = [];
    for (let i = 0; i < samplesPerRadial; i++) {
      const d = (radiusM * i) / (samplesPerRadial - 1);
      pts.push(i === 0 ? params.origin : destinationPoint(params.origin, bearing, d));
    }
    perRadialPoints.push(pts);
  }

  const flat = perRadialPoints.flat();
  let elevations: (number | null)[];
  try {
    elevations = await resolveProvider(sourceUrl).sample(flat);
  } catch (e) {
    // `sample()` is documented never to throw, but a provider-resolution
    // failure would. Degrade to "no terrain data" rather than failing the
    // request: the caller still gets a free-space-only answer, flagged.
    logger.warn(`[Coverage] elevation sampling failed: ${e instanceof Error ? e.message : e}`);
    elevations = new Array(flat.length).fill(null);
  }

  const radials: RadialReach[] = perRadialPoints.map((pts, a) => {
    const base = a * samplesPerRadial;
    const samples: TerrainSample[] = pts.map((_, i) => ({
      distance: (radiusM * i) / (samplesPerRadial - 1),
      elevation: elevations[base + i] ?? null,
    }));
    return analyseRadial(samples, params, (360 * a) / azimuthCount, radiusKm);
  });

  return {
    origin: params.origin,
    radiusKm,
    generatedAt: Date.now(),
    model: 'fresnel-path-loss',
    radials,
    assumptions: modelAssumptions(params),
  };
}
