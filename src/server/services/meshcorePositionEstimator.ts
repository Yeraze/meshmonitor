/**
 * MeshCore estimated positions (#6260 WP5), computed on read.
 *
 * Unlike Meshtastic (global batch job writing `estimated_positions`), a MeshCore
 * estimate is solved per source each time it is asked for and never stored:
 * the inputs (`meshcore_neighbors`, resolved `meshcore_hop_snr` links) are small
 * and the result depends on what the viewer may see. It reuses the shared
 * `solveNodePosition` and the same max-uncertainty setting.
 *
 * Read-only: no packets are sent.
 */
import databaseService from '../../services/database.js';
import { solveNodePosition, type SolverObservation } from './positionEstimationService.js';
import { readMaxUncertaintyKm } from './positionEstimationScheduler.js';
import { buildMeshCorePositionFilter, type MeshCoreVisibilityRow } from '../utils/positionVisibility.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import type { RadiusMethod } from '../../db/repositories/index.js';

/** Look-back for link observations (matches the Meshtastic default). */
export const MESHCORE_ESTIMATE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type MeshCoreObservationKind = 'neighbor' | 'trace';

export interface MeshCoreObservation extends SolverObservation {
  targetKey: string;
  anchorKey: string;
  kind: MeshCoreObservationKind;
}

export interface MeshCoreEstimate {
  publicKey: string;
  latitude: number;
  longitude: number;
  uncertaintyKm: number;
  uniqueAnchors: number;
  nEff: number;
  radiusMethod: RadiusMethod;
}

interface NodeLike {
  publicKey: string;
  latitude?: number | null;
  longitude?: number | null;
  positionOverrideEnabled?: boolean | null;
  latitudeOverride?: number | null;
  longitudeOverride?: number | null;
}

interface LinkEdge {
  a: string;
  b: string;
  snrDb?: number;
  timestamp: number;
  kind: MeshCoreObservationKind;
}

function usablePair(lat: number | null | undefined, lon: number | null | undefined): lat is number {
  return lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)
    && !isBogusPosition(lat, lon) && !(lat === 0 && lon === 0);
}

/**
 * Pure core. `edges` are undirected RF links (a heard b or b heard a); each
 * edge anchors an unpositioned end to a positioned one. `isVisible` is the
 * viewer's position-visibility check; an anchor that fails it is dropped, so a
 * hidden or private node cannot leak its location through an estimate.
 */
export function estimateFromEdges(
  nodes: NodeLike[],
  edges: LinkEdge[],
  isVisible: (publicKey: string) => boolean,
  maxUncertaintyKm: number,
  now: number,
): MeshCoreEstimate[] {
  const anchors = new Map<string, { lat: number; lon: number }>();
  const targets = new Set<string>();
  for (const n of nodes) {
    const key = n.publicKey.toLowerCase();
    const overridden = !!n.positionOverrideEnabled;
    if (overridden) {
      // An overridden node already has a position (its own, whatever the
      // viewer sees), so it is never a target. It anchors only if visible.
      if (usablePair(n.latitudeOverride, n.longitudeOverride) && isVisible(key)) {
        anchors.set(key, { lat: n.latitudeOverride, lon: n.longitudeOverride as number });
      }
    } else if (usablePair(n.latitude, n.longitude)) {
      if (isVisible(key)) anchors.set(key, { lat: n.latitude, lon: n.longitude as number });
    } else if (isVisible(key)) {
      targets.add(key);
    }
  }

  const byTarget = new Map<string, MeshCoreObservation[]>();
  const push = (target: string, anchor: string, e: LinkEdge) => {
    const pos = anchors.get(anchor);
    if (!targets.has(target) || !pos) return;
    const list = byTarget.get(target) ?? [];
    list.push({
      targetKey: target, anchorKey: anchor, anchorLat: pos.lat, anchorLon: pos.lon,
      snrDb: e.snrDb, timestamp: e.timestamp, kind: e.kind,
    });
    byTarget.set(target, list);
  };
  for (const e of edges) {
    const a = e.a.toLowerCase();
    const b = e.b.toLowerCase();
    if (a === b) continue;
    push(a, b, e);
    push(b, a, e);
  }

  const out: MeshCoreEstimate[] = [];
  for (const [publicKey, obs] of byTarget) {
    const solved = solveNodePosition(obs, now);
    if (!solved) continue;
    if (maxUncertaintyKm > 0 && solved.uncertaintyKm > maxUncertaintyKm) continue;
    out.push({
      publicKey,
      latitude: solved.latitude,
      longitude: solved.longitude,
      uncertaintyKm: solved.uncertaintyKm,
      uniqueAnchors: solved.uniqueAnchors,
      nEff: solved.nEff,
      radiusMethod: solved.radiusMethod,
    });
  }
  return out;
}

export async function estimateMeshCorePositions(
  sourceId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches buildMeshCorePositionFilter's req.user signature
  user: any,
  now: number = Date.now(),
): Promise<MeshCoreEstimate[]> {
  const since = now - MESHCORE_ESTIMATE_LOOKBACK_MS;
  const nodes = await databaseService.meshcore.getNodesBySource(sourceId);
  if (nodes.length === 0) return [];
  const [neighbors, hops, maxKm, filter] = await Promise.all([
    databaseService.meshcore.getNeighbors([sourceId], since),
    databaseService.meshcoreHopSnr.getResolvedLinks(sourceId, since),
    readMaxUncertaintyKm(),
    buildMeshCorePositionFilter(user, [sourceId], new Map([[sourceId, nodes]])),
  ]);

  const edges: LinkEdge[] = [];
  for (const n of neighbors) {
    edges.push({
      a: n.publicKey, b: n.neighborPublicKey,
      snrDb: n.snr != null && Number.isFinite(n.snr) ? n.snr : undefined,
      timestamp: Number(n.timestamp), kind: 'neighbor',
    });
  }
  for (const h of hops) {
    if (!h.senderPublicKey || !h.receiverPublicKey) continue;
    edges.push({
      a: h.senderPublicKey, b: h.receiverPublicKey,
      snrDb: Number.isFinite(h.snrQuarterDb) ? h.snrQuarterDb / 4 : undefined,
      timestamp: Number(h.timestamp), kind: 'trace',
    });
  }

  const visible = (publicKey: string) => filter({ sourceId, publicKey } satisfies MeshCoreVisibilityRow);
  return estimateFromEdges(nodes, edges, visible, maxKm, now);
}
