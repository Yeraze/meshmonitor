/**
 * Who may see what in a position-estimate rationale (#5900).
 *
 * Estimates are GLOBAL (#3271): one row per physical nodeNum, pooled from the
 * traceroutes and NeighborInfo of every Meshtastic source. The anchors behind
 * an estimate are positioned nodes, and each anchor row stores that node's
 * coordinates. So the rationale can carry a position the caller has no right
 * to: a node held only on a source they cannot read, a private position
 * override, a node on a channel they cannot view on the map, or a node marked
 * "Hide from Map".
 *
 * The rule: a non-admin sees an anchor only when some source they hold
 * `nodes:read` on has that node at the SAME coordinates (with the solver's
 * tolerance) and that row passes `buildPositionFilter` on its own source. In
 * other words, the rationale shows only positions the caller could already see.
 * Matching the coordinates matters: the estimator takes an anchor's position
 * from whichever source it read last, so a node that is visible on source B
 * may still carry a position that came from source A.
 *
 * The target node itself must exist on a source the caller can read, or the
 * route answers as if there were no estimate.
 *
 * Admins see every anchor.
 */
import type { User } from '../../types/auth.js';
import type { DbNode } from '../../db/types.js';
import { getEffectiveDbNodePosition } from './nodeEnhancer.js';
import { buildPositionFilter, loadNodesBySource } from './positionVisibility.js';
import { listPermittedSourceIds } from './sourceScopedAccess.js';
import { anchorPositionKey } from '../services/positionEstimationService.js';
import databaseService from '../../services/database.js';

/** Names for an anchor, from a row the caller may see. */
export interface AnchorLabel {
  longName: string | null;
  shortName: string | null;
}

export interface PositionEstimateAccess {
  /** False when the caller may not see the target node at all. */
  canSeeTarget: boolean;
  /**
   * The label for a visible anchor, or `null` when the caller may not see it.
   * A visible anchor with no name returns `{ longName: null, shortName: null }`.
   */
  anchorLabel(anchorNodeNum: number, anchorLat: number, anchorLon: number): AnchorLabel | null;
}

function labelOf(node: DbNode): AnchorLabel {
  return { longName: node.longName ?? null, shortName: node.shortName ?? null };
}

export async function loadPositionEstimateAccess(
  user: User | null | undefined,
  targetNodeNum: number,
): Promise<PositionEstimateAccess> {
  if (user?.isAdmin) {
    // Admins see every anchor; names come from any source that has one.
    const sources = await databaseService.sources.getAllSources();
    const nodesBySource = await loadNodesBySource(sources.map((s) => s.id));
    const labels = new Map<number, AnchorLabel>();
    for (const nodes of nodesBySource.values()) {
      for (const n of nodes) {
        const num = Number(n.nodeNum);
        if (!labels.get(num)?.longName && (n.longName || n.shortName)) labels.set(num, labelOf(n));
      }
    }
    return {
      canSeeTarget: true,
      anchorLabel: (anchorNodeNum) => labels.get(anchorNodeNum) ?? { longName: null, shortName: null },
    };
  }

  const readable = await listPermittedSourceIds(user, 'nodes', 'read');
  const sourceIds = readable === 'all' ? [] : readable;
  if (sourceIds.length === 0) {
    return { canSeeTarget: false, anchorLabel: () => null };
  }
  const nodesBySource = await loadNodesBySource(sourceIds);
  const visible = await buildPositionFilter(user, sourceIds, nodesBySource);

  let canSeeTarget = false;
  // `${nodeNum}:${positionKey}` -> label, for every visible positioned row.
  const visibleAnchors = new Map<string, AnchorLabel>();
  for (const [sourceId, nodes] of nodesBySource) {
    for (const n of nodes) {
      const num = Number(n.nodeNum);
      if (num === targetNodeNum) canSeeTarget = true;
      if (!visible({ sourceId, nodeNum: num })) continue;
      const eff = getEffectiveDbNodePosition(n);
      if (eff.latitude == null || eff.longitude == null) continue;
      const key = `${num}:${anchorPositionKey(eff.latitude, eff.longitude)}`;
      if (!visibleAnchors.get(key)?.longName) visibleAnchors.set(key, labelOf(n));
    }
  }

  return {
    canSeeTarget,
    anchorLabel: (anchorNodeNum, anchorLat, anchorLon) =>
      visibleAnchors.get(`${anchorNodeNum}:${anchorPositionKey(anchorLat, anchorLon)}`) ?? null,
  };
}
