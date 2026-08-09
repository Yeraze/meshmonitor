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
import { isBogusPosition } from '../../utils/nullIsland.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import type {
  EstimatedPositionInput,
  EstimatedPositionAnchorInput,
  RadiusMethod,
} from '../../db/repositories/index.js';

/** A single geometric constraint: node `nodeNum` is near positioned `anchor`. */
export interface PositionObservation {
  nodeNum: number;
  /**
   * The positioned node acting as the anchor. Carried so the estimate's
   * rationale can name it (#4609) — the solve itself only needs the lat/lon.
   */
  anchorNodeNum: number;
  anchorLat: number;
  anchorLon: number;
  /** Link SNR in dB (already converted). Higher → closer → higher weight. */
  snrDb?: number;
  /** Observation time in ms (for time-decay weighting). */
  timestamp: number;
  kind: 'traceroute' | 'neighbor';
}

/** An observation plus the weight it received in the solve (#4609). */
export interface WeightedObservation {
  observation: PositionObservation;
  weight: number;
}

export interface SolvedPosition {
  latitude: number;
  longitude: number;
  uncertaintyKm: number;
  observationCount: number;
  /**
   * Kish effective sample size. 1 means a lone anchor — or several so lopsided
   * in weight that they behave as one. Recorded so the UI can explain the
   * radius instead of just showing it (#4609).
   */
  nEff: number;
  /** Which branch of the uncertainty math produced `uncertaintyKm` (#4609). */
  radiusMethod: RadiusMethod;
  /**
   * Positive-weight observations with the weight each received, strongest
   * first. These are the anchors that actually moved the centroid.
   */
  usedObservations: WeightedObservation[];
}

export interface RecomputeResult {
  estimatedNodeCount: number;
  observationCount: number;
  anchorCount: number;
  /** Solved positions discarded because their uncertainty exceeded the
   *  configured maximum (issue #3271 follow-up). */
  rejectedNodeCount: number;
  durationMs: number;
}

// Time decay: observations lose half their weight every 24h.
const HALF_LIFE_MS = 24 * 60 * 60 * 1000;
const DECAY_CONSTANT = Math.LN2 / HALF_LIFE_MS;

// A single anchor can't triangulate — only tells us "within radio range".
// Exported so the rationale API can state the heuristic it came from (#4609)
// rather than hardcoding "5 km" a second time.
export const DEFAULT_SINGLE_ANCHOR_KM = 5;
// Floor so multi-anchor estimates never report absurd over-confidence.
const MIN_UNCERTAINTY_KM = 0.05;

// Upper bound on traceroutes pulled per source (defensive — lookback also caps).
const MAX_TRACEROUTES_PER_SOURCE = 100000;

/**
 * Cap on anchors persisted per node for the rationale view (#4609).
 *
 * A well-connected node in a busy mesh can accumulate thousands of observations
 * over the 7-day lookback; storing them all would grow the anchor table far
 * beyond the value it provides. We keep the highest-weighted anchors — the ones
 * that actually determined where the pin landed — and leave the true total on
 * `estimated_positions.observationCount`, so a consumer can always say
 * "showing N of M".
 */
export const MAX_STORED_ANCHORS_PER_NODE = 20;

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
 * Effective-sample-size guard (issue #3616): with skewed SNR weights one strong
 * anchor can dominate, collapsing the centroid onto it while the weak/far anchors
 * contribute almost nothing to the weighted RMS — yielding a tiny, falsely
 * confident radius for what is effectively a single observation. The weight model
 * itself is correct (higher SNR → higher weight → pulled toward that anchor); the
 * fix is purely on uncertainty. We blend the radio-range default toward the
 * statistical radius using the Kish effective sample size `nEff`: at `nEff = 1`
 * (a lone — or weight-dominated — anchor) uncertainty is the full radio-range
 * default; it reaches the pure statistical estimate only once `nEff >= 2` (a
 * genuinely balanced multi-anchor solve). This does not change balanced
 * multi-anchor estimates, only the degenerate near-single cases.
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

  // A solve that lands on Null Island is not a position (#4432 follow-up).
  // buildObservations already drops bogus anchors, so this is the second line of
  // defence: legitimate anchors placed symmetrically about (0, 0) can still
  // average onto it. Returning null means "no usable estimate", which is exactly
  // what a Gulf-of-Guinea centroid is — better than storing a row that later gets
  // substituted onto the node as though it were a fix.
  if (isBogusPosition(latitude, longitude)) return null;

  // Kish effective sample size — robust to skewed weights.
  const nEff = (wSum * wSum) / w2Sum;

  let weightedDist2 = 0;
  for (const { obs, w } of used) {
    const d = calculateDistance(latitude, longitude, obs.anchorLat, obs.anchorLon);
    weightedDist2 += w * d * d;
  }
  const rmsKm = Math.sqrt(weightedDist2 / wSum);

  // Statistical radius: weighted-RMS spread shrunk by sqrt(effective N). Only
  // trustworthy once we genuinely have multiple balanced observations.
  const statisticalKm = Math.max(MIN_UNCERTAINTY_KM, rmsKm / Math.sqrt(Math.max(nEff, 1)));

  // Blend factor from 0 (nEff = 1, effectively a single observation) to 1
  // (nEff >= 2, a balanced multi-anchor solve). This closes issue #3616: a
  // strong anchor that dominates the weights (nEff barely above 1) no longer
  // skips the radio-range default and report a spuriously tight radius.
  const confidence = Math.min(1, Math.max(0, nEff - 1));
  // Both terms are already >= MIN_UNCERTAINTY_KM (statisticalKm is floored and
  // DEFAULT_SINGLE_ANCHOR_KM is far above it), so the outer Math.max is a
  // belt-and-braces guard rather than a branch the radius can actually take.
  const uncertaintyKm = Math.max(
    MIN_UNCERTAINTY_KM,
    DEFAULT_SINGLE_ANCHOR_KM * (1 - confidence) + statisticalKm * confidence,
  );

  // Name the branch that produced the radius (#4609), so the UI can say
  // "lone anchor, 5 km default" rather than presenting a guess and a solve as
  // if they were the same kind of answer.
  const radiusMethod: RadiusMethod =
    confidence <= 0 ? 'single_anchor'
      : confidence >= 1 ? 'convergence'
        : 'blended';

  const usedObservations: WeightedObservation[] = used
    .map(({ obs, w }) => ({ observation: obs, weight: w }))
    .sort((a, b) => b.weight - a.weight);

  return {
    latitude,
    longitude,
    uncertaintyKm,
    observationCount: observations.length,
    nEff,
    radiusMethod,
    usedObservations,
  };
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
        anchorNodeNum: path[i - 1],
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
        anchorNodeNum: path[i + 1],
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

  // Drop anchors that are not real positions before they can constrain anything
  // (#4432 follow-up). A Null Island or otherwise invalid anchor drags the
  // weighted centroid toward (0, 0) and produces an estimate in the Gulf of
  // Guinea — which then gets substituted onto the node as if it were a fix.
  // Filtered into a new map rather than deleting from the caller's: this
  // function is otherwise free of side effects and callers reuse the map.
  const usableAnchors = new Map<number, { lat: number; lon: number }>();
  for (const [nodeNum, a] of anchors) {
    if (!isBogusPosition(a.lat, a.lon)) usableAnchors.set(nodeNum, a);
  }

  for (const tr of traceroutes) {
    const route = parseNumberArray(tr.route);
    const forwardPath = [tr.fromNodeNum, ...route, tr.toNodeNum];
    addPathObservations(forwardPath, parseNumberArray(tr.snrTowards), tr.timestamp, usableAnchors, out);

    const routeBack = parseNumberArray(tr.routeBack);
    if (routeBack.length > 0) {
      const returnPath = [tr.toNodeNum, ...routeBack, tr.fromNodeNum];
      addPathObservations(returnPath, parseNumberArray(tr.snrBack), tr.timestamp, usableAnchors, out);
    }
  }

  for (const nb of neighbors) {
    // NeighborInfo snr is already in dB. Either side may be the unpositioned target.
    const nodeAnchor = usableAnchors.get(nb.nodeNum);
    const neighborAnchor = usableAnchors.get(nb.neighborNodeNum);
    const snrDb = nb.snr != null && Number.isFinite(nb.snr) ? nb.snr : undefined;

    if (neighborAnchor && !nodeAnchor) {
      const list = out.get(nb.nodeNum) ?? [];
      list.push({
        nodeNum: nb.nodeNum,
        anchorNodeNum: nb.neighborNodeNum,
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
        anchorNodeNum: nb.nodeNum,
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
  async recomputeAll(opts: { lookbackMs: number; maxUncertaintyKm?: number | null }): Promise<RecomputeResult> {
    const start = Date.now();
    const now = start;
    const cutoff = now - opts.lookbackMs;
    // 0 / null / negative ⇒ no limit (store every solvable estimate).
    const maxUncertaintyKm =
      opts.maxUncertaintyKm != null && opts.maxUncertaintyKm > 0 ? opts.maxUncertaintyKm : null;

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
    // Anchors backing the estimates written this run (#4609), capped per node.
    const anchorInputs: EstimatedPositionAnchorInput[] = [];
    // Nodes solved but rejected for exceeding maxUncertaintyKm. Their existing
    // estimates (if any) are deleted below so a now-too-uncertain node doesn't
    // keep a stale, oversized circle on the map.
    const rejectedNodeNums: number[] = [];
    for (const [nodeNum, observations] of obsByNode) {
      observationCount += observations.length;
      const solved = solveNodePosition(observations, now);
      if (!solved) continue;
      if (maxUncertaintyKm != null && solved.uncertaintyKm > maxUncertaintyKm) {
        rejectedNodeNums.push(nodeNum);
        continue;
      }
      inputs.push({
        nodeNum,
        nodeId: nodeNumToId(nodeNum),
        latitude: solved.latitude,
        longitude: solved.longitude,
        uncertaintyKm: solved.uncertaintyKm,
        observationCount: solved.observationCount,
        updatedAt: now,
        nEff: solved.nEff,
        radiusMethod: solved.radiusMethod,
      });

      // usedObservations is already sorted strongest-first, so slicing keeps the
      // anchors that actually determined the pin.
      for (const { observation, weight } of solved.usedObservations.slice(0, MAX_STORED_ANCHORS_PER_NODE)) {
        anchorInputs.push({
          nodeNum,
          anchorNodeNum: observation.anchorNodeNum,
          anchorNodeId: nodeNumToId(observation.anchorNodeNum),
          anchorLat: observation.anchorLat,
          anchorLon: observation.anchorLon,
          kind: observation.kind,
          snrDb: observation.snrDb ?? null,
          observedAt: observation.timestamp,
          weight,
          createdAt: now,
        });
      }
    }

    await databaseService.upsertEstimatedPositionsAsync(inputs);
    // Replace anchors for exactly the nodes we just wrote. Passing the node list
    // separately clears stale rows for a node that solved with no usable anchor.
    await databaseService.replaceEstimatedPositionAnchorsAsync(
      inputs.map((i) => i.nodeNum),
      anchorInputs,
    );

    // Clear estimates that are no longer valid: a node that gained a real
    // position (now an anchor), or one whose fresh estimate is too uncertain
    // to keep under the configured maximum. The repository cascades the
    // matching anchor rows.
    const anchorNodeNums = [...anchors.keys()];
    await databaseService.deleteEstimatedPositionsByNodeNumsAsync([...anchorNodeNums, ...rejectedNodeNums]);

    const durationMs = Date.now() - start;
    logger.debug(
      `📍 Position estimation: ${inputs.length} node(s) estimated from ${observationCount} observation(s) ` +
      `across ${meshtasticSourceIds.length} source(s), ${anchors.size} anchor(s)` +
      (rejectedNodeNums.length ? `, ${rejectedNodeNums.length} rejected (>${maxUncertaintyKm}km)` : '') +
      `, in ${durationMs}ms`
    );

    return {
      estimatedNodeCount: inputs.length,
      observationCount,
      anchorCount: anchors.size,
      rejectedNodeCount: rejectedNodeNums.length,
      durationMs,
    };
  }
}

export const positionEstimationService = new PositionEstimationService();
