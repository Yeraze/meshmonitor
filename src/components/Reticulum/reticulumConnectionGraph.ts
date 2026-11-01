/**
 * reticulumConnectionGraph — pure path-table → node-graph builder for the
 * Reticulum Map page's position-free "Connections" view (#6119).
 *
 * Most Reticulum clients never share a location, so the Locations map shows
 * only a handful of peers. The Connections view instead draws topology from
 * the `reticulum_paths` table: the local instance at the centre, a direct
 * edge to every destination reachable with a null `viaHash`, and a relay edge
 * through the via/next hop for every other destination.
 *
 * IMPORTANT (#6119): a path's `viaHash` is a next-hop/transport identity hash
 * that may NOT resolve to a known destination row. When it doesn't, we still
 * draw a relay node for it — one per unique `viaHash` — labelled by its
 * truncated hash. `nodeForViaHash` therefore never requires a destination row.
 *
 * This module is intentionally free of React/DOM so the graph shape (the part
 * the issue asks to test) can be unit-tested as a plain function. Visual
 * layout (radial positioning) lives in `ReticulumConnectionsGraph.tsx`.
 */
import type { ReticulumDestinationRow, ReticulumPathRow } from '../../types/reticulum';

export type ReticulumGraphNodeKind = 'local' | 'destination' | 'relay';

/** Stable node id for the local instance at the centre of the graph. */
export const LOCAL_NODE_ID = 'local';

export interface ReticulumGraphNode {
  /** Stable key: 'local' | `dest:${hash}` | `relay:${hash}`. */
  id: string;
  kind: ReticulumGraphNodeKind;
  /** Destination/relay hash; null only for the local node. */
  hash: string | null;
  /** Display name when known, else a truncated hash (local uses `localLabel`). */
  label: string;
  /**
   * The resolved destination row when this node maps to a known destination —
   * the click target for "open destination details". Null for the local node
   * and for a relay whose `viaHash` doesn't resolve to a known destination.
   */
  destination: ReticulumDestinationRow | null;
}

export interface ReticulumGraphEdge {
  /** Stable key `${from}->${to}`. */
  id: string;
  from: string;
  to: string;
  /** 'direct' = local reaches the destination directly (null viaHash);
   *  'relay'  = a leg of a path routed through a relay/next hop. */
  kind: 'direct' | 'relay';
}

export interface ReticulumConnectionGraph {
  nodes: ReticulumGraphNode[];
  edges: ReticulumGraphEdge[];
}

export interface BuildConnectionGraphOptions {
  /** Label for the centre node (the local instance). */
  localLabel: string;
}

/** Truncate a long hash for display (matches `ReticulumMap`'s `shortHash`). */
export function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

function destNodeId(hash: string): string {
  return `dest:${hash}`;
}

function relayNodeId(hash: string): string {
  return `relay:${hash}`;
}

/**
 * Build the Connections topology graph from a source's path table.
 *
 * Deterministic: nodes come out local-first, then destination/relay nodes in
 * first-seen order across `paths`; edges in first-seen order. Duplicate nodes
 * (same id) and duplicate edges (same from→to) are collapsed. An empty
 * `paths` list yields an empty graph (no local node) so the view can show its
 * own empty state rather than a lone centre dot.
 */
export function buildReticulumConnectionGraph(
  paths: ReticulumPathRow[],
  destinations: ReticulumDestinationRow[],
  options: BuildConnectionGraphOptions,
): ReticulumConnectionGraph {
  if (paths.length === 0) {
    return { nodes: [], edges: [] };
  }

  const destByHash = new Map<string, ReticulumDestinationRow>();
  for (const d of destinations) {
    destByHash.set(d.destinationHash, d);
  }

  const labelFor = (hash: string): string => {
    const name = destByHash.get(hash)?.displayName;
    return name && name.length > 0 ? name : shortHash(hash);
  };

  const nodes: ReticulumGraphNode[] = [{
    id: LOCAL_NODE_ID,
    kind: 'local',
    hash: null,
    label: options.localLabel,
    destination: null,
  }];
  const nodeIndex = new Map<string, number>([[LOCAL_NODE_ID, 0]]);
  const edges: ReticulumGraphEdge[] = [];
  const edgeSeen = new Set<string>();

  const ensureNode = (node: ReticulumGraphNode): void => {
    if (!nodeIndex.has(node.id)) {
      nodeIndex.set(node.id, nodes.length);
      nodes.push(node);
    }
  };

  const addEdge = (from: string, to: string, kind: ReticulumGraphEdge['kind']): void => {
    const id = `${from}->${to}`;
    if (edgeSeen.has(id)) return;
    edgeSeen.add(id);
    edges.push({ id, from, to, kind });
  };

  for (const p of paths) {
    const destId = destNodeId(p.destinationHash);
    ensureNode({
      id: destId,
      kind: 'destination',
      hash: p.destinationHash,
      label: labelFor(p.destinationHash),
      destination: destByHash.get(p.destinationHash) ?? null,
    });

    if (!p.viaHash) {
      // Directly reachable (zero-hop) — a direct edge from the centre.
      addEdge(LOCAL_NODE_ID, destId, 'direct');
      continue;
    }

    // Routed through a relay/next hop. The via hash may be a transport
    // identity that resolves to no known destination — we still draw a relay
    // node for it, labelled by its truncated hash (#6119).
    const relayId = relayNodeId(p.viaHash);
    ensureNode({
      id: relayId,
      kind: 'relay',
      hash: p.viaHash,
      label: labelFor(p.viaHash),
      destination: destByHash.get(p.viaHash) ?? null,
    });
    addEdge(LOCAL_NODE_ID, relayId, 'relay');
    addEdge(relayId, destId, 'relay');
  }

  return { nodes, edges };
}
