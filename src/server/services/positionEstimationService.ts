/**
 * Position Estimation Service (global, batch, multilateration)
 *
 * Estimates positions for nodes without GPS by pooling geometric observations
 * across ALL Meshtastic sources (incl. MQTT) — see issue #3271. Runs as a
 * scheduled batch job (positionEstimationScheduler), not in realtime, so the
 * whole constraint set is solved at once.
 *
 * Observation sources (Meshtastic-only — MeshCore sources excluded):
 *  - Traceroutes: each segment A–X–B anchors intermediate X to its positioned
 *    path-neighbors, SNR-biased.
 *  - NeighborInfo: each direct-RF-range pair anchors the unpositioned side to
 *    the positioned side.
 *
 * Estimates are written to the GLOBAL `estimated_positions` table (one row per
 * physical nodeNum), so every source displays the same estimate.
 *
 * MQTT observations carry full weight (no down-weighting) — see plan §8.1.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { calculateDistance } from '../../utils/distance.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import type { EstimatedPositionInput } from '../../db/repositories/index.js';

/** A single geometric constraint: node `nodeNum` is near positioned `anchor`. */
export interface PositionObservation {
  nodeNum: number;
  anchorLat: number;
  anchorLon: number;
  /** Link SNR in dB (already converted). Higher → closer → higher weight. */
  snrDb?: number;
  /** Observation time in ms (for time-decay weighting). */
  timestamp: number;
  kind: 'traceroute' | 'neighbor';
}

export interface SolvedPosition {
  latitude: number;
  longitude: number;
  uncertaintyKm: number;
  observationCount: number;
}

export interface RecomputeResult {
  estimatedNodeCount: number;
  observationCount: number;
  anchorCount: number;
  durationMs: number;
}

// Time decay: observations lose half their weight every 24h.
const HALF_LIFE_MS = 24 * 60 * 60 * 1000;
const DECAY_CONSTANT = Math.LN2 / HALF_LIFE_MS;

// A single anchor can't triangulate — only tells us "within radio range".
const DEFAULT_SINGLE_ANCHOR_KM = 5;
// Floor so multi-anchor estimates never report absurd over-confidence.
const MIN_UNCERTAINTY_KM = 0.05;

// Upper bound on traceroutes pulled per source (defensive — lookback also caps).
const MAX_TRACEROUTES_PER_SOURCE = 100000;

function nodeNumToId(nodeNum: number): string {
  return `!${nodeNum.toString(16).padStart(8, '0')}`;
}

/**
 * Weight for a single observation = time-decay × SNR linear power.
 * SNR weighting mirrors the legacy estimator: 10^(snrDb/10) is relative signal
 * strength, so a stronger link pulls the estimate toward that anchor. Absent
 * SNR defaults to weight 1 (still time-decayed).
 */
export function observationWeight(obs: PositionObservation, now: number): number {
  const ageMs = Math.max(0, now - obs.timestamp);
  const timeDecay = Math.exp(-DECAY_CONSTANT * ageMs);
  const snrWeight = obs.snrDb !== undefined && Number.isFinite(obs.snrDb)
    ? Math.pow(10, obs.snrDb / 10)
    : 1;
  return timeDecay * snrWeight;
}

/**
 * Solve a node's position from its anchor observations via weighted centroid.
 *
 * For the 2-anchor case (one traceroute segment) this reduces exactly to the
 * legacy SNR-weighted midpoint. Pooling many observations from many directions
 * makes the centroid converge on the true location.
 *
 * Uncertainty: weighted RMS distance of anchors from the centroid, divided by
 * sqrt(effective sample size) — many converging observations → small radius;
 * few / spread-out observations → large radius. A lone anchor falls back to a
 * radio-range default.
 *
 * @returns null if there are no usable (positive-weight) observations.
 */
export function solveNodePosition(observations: PositionObservation[], now: number): SolvedPosition | null {
  if (observations.length === 0) return null;

  const used: Array<{ obs: PositionObservation; w: number }> = [];
  let wSum = 0;
  let w2Sum = 0;
  let wLat = 0;
  let wLon = 0;

  for (const obs of observations) {
    const w = observationWeight(obs, now);
    if (!(w > 0) || !Number.isFinite(w)) continue;
    used.push({ obs, w });
    wSum += w;
    w2Sum += w * w;
    wLat += obs.anchorLat * w;
    wLon += obs.anchorLon * w;
  }

  if (used.length === 0 || wSum <= 0) return null;

  const latitude = wLat / wSum;
  const longitude = wLon / wSum;

  // Kish effective sample size — robust to skewed weights.
  const nEff = (wSum * wSum) / w2Sum;

  let weightedDist2 = 0;
  for (const { obs, w } of used) {
    const d = calculateDistance(latitude, longitude, obs.anchorLat, obs.anchorLon);
    weightedDist2 += w * d * d;
  }
  const rmsKm = Math.sqrt(weightedDist2 / wSum);

  let uncertaintyKm: number;
  if (nEff <= 1) {
    uncertaintyKm = DEFAULT_SINGLE_ANCHOR_KM;
  } else {
    uncertaintyKm = Math.max(MIN_UNCERTAINTY_KM, rmsKm / Math.sqrt(nEff));
  }

  return { latitude, longitude, uncertaintyKm, observationCount: observations.length };
}

/** Safely JSON-parse an array of numbers; returns [] on any problem. */
function parseNumberArray(json: string | null | undefined): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

/** A traceroute row reduced to what the estimator needs. */
export interface TracerouteForEstimation {
  fromNodeNum: number;
  toNodeNum: number;
  route: string | null;
  routeBack: string | null;
  snrTowards: string | null;
  snrBack: string | null;
  timestamp: number;
}

/** A neighbor row reduced to what the estimator needs. */
export interface NeighborForEstimation {
  nodeNum: number;
  neighborNodeNum: number;
  snr: number | null;
  timestamp: number;
}

/**
 * Emit observations for the intermediate hops of one directional path.
 * Mirrors the legacy SNR index mapping: for path index i, snr[i-1] is the link
 * to the previous hop and snr[i] the link to the next hop (raw → ÷4 for dB).
 */
function addPathObservations(
  path: number[],
  snrRaw: number[],
  timestamp: number,
  anchors: Map<number, { lat: number; lon: number }>,
  out: Map<number, PositionObservation[]>,
): void {
  for (let i = 1; i < path.length - 1; i++) {
    const nodeNum = path[i];
    // Skip nodes that already have a real position — they're anchors, not targets.
    if (anchors.has(nodeNum)) continue;

    const prev = anchors.get(path[i - 1]);
    const next = anchors.get(path[i + 1]);
    const snrPrevRaw = snrRaw[i - 1];
    const snrNextRaw = snrRaw[i];

    const list = out.get(nodeNum) ?? [];
    if (prev) {
      list.push({
        nodeNum,
        anchorLat: prev.lat,
        anchorLon: prev.lon,
        snrDb: typeof snrPrevRaw === 'number' ? snrPrevRaw / 4 : undefined,
        timestamp,
        kind: 'traceroute',
      });
    }
    if (next) {
      list.push({
        nodeNum,
        anchorLat: next.lat,
        anchorLon: next.lon,
        snrDb: typeof snrNextRaw === 'number' ? snrNextRaw / 4 : undefined,
        timestamp,
        kind: 'traceroute',
      });
    }
    if (list.length > 0) out.set(nodeNum, list);
  }
}

/**
 * Build the per-node observation set from raw traceroute + neighbor rows and a
 * map of anchor (positioned) nodes. Pure — no DB access.
 */
export function buildObservations(
  traceroutes: TracerouteForEstimation[],
  neighbors: NeighborForEstimation[],
  anchors: Map<number, { lat: number; lon: number }>,
): Map<number, PositionObservation[]> {
  const out = new Map<number, PositionObservation[]>();

  for (const tr of traceroutes) {
    const route = parseNumberArray(tr.route);
    const forwardPath = [tr.fromNodeNum, ...route, tr.toNodeNum];
    addPathObservations(forwardPath, parseNumberArray(tr.snrTowards), tr.timestamp, anchors, out);

    const routeBack = parseNumberArray(tr.routeBack);
    if (routeBack.length > 0) {
      const returnPath = [tr.toNodeNum, ...routeBack, tr.fromNodeNum];
      addPathObservations(returnPath, parseNumberArray(tr.snrBack), tr.timestamp, anchors, out);
    }
  }

  for (const nb of neighbors) {
    // NeighborInfo snr is already in dB. Either side may be the unpositioned target.
    const nodeAnchor = anchors.get(nb.nodeNum);
    const neighborAnchor = anchors.get(nb.neighborNodeNum);
    const snrDb = nb.snr != null && Number.isFinite(nb.snr) ? nb.snr : undefined;

    if (neighborAnchor && !nodeAnchor) {
      const list = out.get(nb.nodeNum) ?? [];
      list.push({
        nodeNum: nb.nodeNum,
        anchorLat: neighborAnchor.lat,
        anchorLon: neighborAnchor.lon,
        snrDb,
        timestamp: nb.timestamp,
        kind: 'neighbor',
      });
      out.set(nb.nodeNum, list);
    }
    if (nodeAnchor && !neighborAnchor) {
      const list = out.get(nb.neighborNodeNum) ?? [];
      list.push({
        nodeNum: nb.neighborNodeNum,
        anchorLat: nodeAnchor.lat,
        anchorLon: nodeAnchor.lon,
        snrDb,
        timestamp: nb.timestamp,
        kind: 'neighbor',
      });
      out.set(nb.neighborNodeNum, list);
    }
  }

  return out;
}

class PositionEstimationService {
  /**
   * Recompute all global estimated positions from data within the lookback
   * window. Pools every Meshtastic source (MeshCore excluded). Bulk-upserts
   * results and clears estimates for nodes that now have real positions.
   */
  async recomputeAll(opts: { lookbackMs: number }): Promise<RecomputeResult> {
    const start = Date.now();
    const now = start;
    const cutoff = now - opts.lookbackMs;

    // Meshtastic-only sources (exclude MeshCore).
    const allSources = await databaseService.sources.getAllSources();
    const meshtasticSourceIds = allSources
      .filter((s) => s.type !== 'meshcore')
      .map((s) => s.id);

    // Anchors: every node with a real (effective) position, across all sources.
    const anchors = new Map<number, { lat: number; lon: number }>();
    for (const sourceId of meshtasticSourceIds) {
      const nodes = await databaseService.nodes.getAllNodes(sourceId);
      for (const node of nodes) {
        const eff = getEffectiveDbNodePosition(node);
        if (eff.latitude != null && eff.longitude != null) {
          anchors.set(Number(node.nodeNum), { lat: eff.latitude, lon: eff.longitude });
        }
      }
    }

    // Gather traceroutes + neighbor rows within the lookback window.
    const traceroutes: TracerouteForEstimation[] = [];
    const neighbors: NeighborForEstimation[] = [];
    for (const sourceId of meshtasticSourceIds) {
      const trs = await databaseService.traceroutes.getAllTraceroutes(MAX_TRACEROUTES_PER_SOURCE, sourceId);
      for (const tr of trs) {
        if (tr.timestamp >= cutoff && tr.route) {
          traceroutes.push({
            fromNodeNum: Number(tr.fromNodeNum),
            toNodeNum: Number(tr.toNodeNum),
            route: tr.route,
            routeBack: tr.routeBack,
            snrTowards: tr.snrTowards,
            snrBack: tr.snrBack,
            timestamp: tr.timestamp,
          });
        }
      }

      const nbs = await databaseService.neighbors.getAllNeighborInfo(sourceId);
      for (const nb of nbs) {
        if (nb.timestamp >= cutoff) {
          neighbors.push({
            nodeNum: Number(nb.nodeNum),
            neighborNodeNum: Number(nb.neighborNodeNum),
            snr: nb.snr ?? null,
            timestamp: nb.timestamp,
          });
        }
      }
    }

    const obsByNode = buildObservations(traceroutes, neighbors, anchors);

    let observationCount = 0;
    const inputs: EstimatedPositionInput[] = [];
    for (const [nodeNum, observations] of obsByNode) {
      observationCount += observations.length;
      const solved = solveNodePosition(observations, now);
      if (!solved) continue;
      inputs.push({
        nodeNum,
        nodeId: nodeNumToId(nodeNum),
        latitude: solved.latitude,
        longitude: solved.longitude,
        uncertaintyKm: solved.uncertaintyKm,
        observationCount: solved.observationCount,
        updatedAt: now,
      });
    }

    await databaseService.upsertEstimatedPositionsAsync(inputs);

    // A node that gained a real position should not also carry an estimate.
    const anchorNodeNums = [...anchors.keys()];
    await databaseService.deleteEstimatedPositionsByNodeNumsAsync(anchorNodeNums);

    const durationMs = Date.now() - start;
    logger.info(
      `📍 Position estimation: ${inputs.length} node(s) estimated from ${observationCount} observation(s) ` +
      `across ${meshtasticSourceIds.length} source(s), ${anchors.size} anchor(s), in ${durationMs}ms`
    );

    return {
      estimatedNodeCount: inputs.length,
      observationCount,
      anchorCount: anchors.size,
      durationMs,
    };
  }
}

export const positionEstimationService = new PositionEstimationService();
