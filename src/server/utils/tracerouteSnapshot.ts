/**
 * The `traceroutes.routePositions` snapshot (#1862): where each node on a
 * traceroute stood when the run was recorded, so an old run still draws where
 * the nodes were then and not where they are now.
 *
 * ONE builder for every writer (the radio reply path in `meshtasticManager`
 * and MQTT ingest), so the two cannot disagree about what a snapshot holds.
 *
 * ## What goes in
 *
 * Every node on the run: both endpoints and every hop of `route` and
 * `routeBack`. For each, the node row on the run's OWN source is read and its
 * effective position is stored as `{ lat, lng, alt? }`, keyed by node number:
 *
 *  - a public position override when one is set (#2847), else the device GPS;
 *  - nothing when the node has no row or no position. Readers then fall back
 *    to the node's live position (`resolveSegmentPosition`).
 *
 * ## Privacy
 *
 * The snapshot is stored once and served to every reader of the row, so it
 * cannot hold anything that depends on who is looking.
 *
 * A PRIVATE position override (`positionOverrideIsPrivate`) is never stored.
 * Live, that position is shown only to a user with `nodes_private:read`
 * (`enhanceNodeForClient`), and no route that serves traceroute rows checks
 * that permission against the snapshot. Such a node is left out, and the
 * reader's live fallback applies the per-viewer mask. An override is a pin
 * the user set, so the live value is the same point unless the pin moved.
 *
 * Not covered here, and unchanged by this builder: a hop on a channel the
 * viewer has no `viewOnMap` right for. The row is gated on the TRACEROUTE's
 * channel (`maskTraceroutesByChannel`), not on each hop's.
 */
import type { DbNode } from '../../db/types.js';
import { getEffectiveDbNodePosition } from './nodeEnhancer.js';

export type RoutePositionSnapshot = Record<number, { lat: number; lng: number; alt?: number }>;

/** The node fields the snapshot reads. `DbNode` satisfies it. */
export type SnapshotNode = Pick<
  DbNode,
  | 'latitude' | 'longitude' | 'altitude'
  | 'positionOverrideEnabled' | 'latitudeOverride' | 'longitudeOverride' | 'altitudeOverride'
  | 'positionOverrideIsPrivate'
>;

/**
 * Build the snapshot for `nodeNums` (duplicates are fine). `getNode` reads one
 * node on the run's source. Returns the JSON string the column stores; a run
 * where no node has a position gives `'{}'`.
 */
export async function buildRoutePositionsSnapshot(
  nodeNums: Iterable<number>,
  getNode: (nodeNum: number) => Promise<SnapshotNode | null | undefined>,
): Promise<string> {
  const snapshot: RoutePositionSnapshot = {};
  for (const nodeNum of new Set(nodeNums)) {
    const node = await getNode(nodeNum);
    if (!node) continue;
    const eff = getEffectiveDbNodePosition(node);
    // SQLite hands booleans back as 1/0, PostgreSQL/MySQL as true/false.
    if (eff.isOverride && node.positionOverrideIsPrivate) continue;
    if (eff.latitude == null || eff.longitude == null) continue;
    snapshot[nodeNum] = {
      lat: eff.latitude,
      lng: eff.longitude,
      ...(eff.altitude != null ? { alt: eff.altitude } : {}),
    };
  }
  return JSON.stringify(snapshot);
}
