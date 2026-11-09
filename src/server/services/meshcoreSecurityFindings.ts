/**
 * MeshCore Security findings (P7a, #6254, shared piece S4).
 *
 * Pure functions over a node list, plus one loader that reads a source's
 * `meshcore_nodes` rows. Everything here is a DB read: nothing is sent over RF.
 *
 *  - path-hash collisions: repeaters / room servers whose routing hash (the
 *    first N bytes of the key, see `hopByteForKey`) matches, so a path through
 *    that hash is ambiguous;
 *  - signature failures: nodes whose latest checked advert failed Ed25519
 *    verification (`advertSignatureVerified === false`; null = never checked);
 *  - name reuse: one display name on several keys. Display only, no alert.
 */
import { hopByteForKey } from '../../utils/meshcorePath.js';
import { findNameReuse, nameReuseSuspectKeys, type SecurityNode, type NameReuseGroup } from '../../utils/meshcoreNameReuse.js';
import databaseService from '../../services/database.js';

export type { SecurityNode, NameReuseGroup };
export { findNameReuse, nameReuseSuspectKeys };

export type PathHashWidth = 1 | 2 | 3;

export interface PathHashCollisionGroup<N extends SecurityNode = SecurityNode> {
  /** Lowercase hex routing hash (2 / 4 / 6 chars). */
  hash: string;
  /** Two or more nodes, sorted by key. */
  nodes: N[];
}

const ROUTING_ADV_TYPES = new Set([2, 3]); // Repeater, Room Server

/**
 * Group routing nodes (advType 2/3 only) by hash at `width` bytes and keep the
 * groups of two or more. `heardSinceMs` drops nodes not heard since then, so a
 * long-dead repeater does not collide with a live one.
 */
export function findPathHashCollisions<N extends SecurityNode>(
  nodes: readonly N[],
  width: PathHashWidth,
  opts: { heardSinceMs?: number } = {},
): PathHashCollisionGroup<N>[] {
  const byHash = new Map<string, Map<string, N>>();
  for (const n of nodes) {
    if (!n.publicKey || n.publicKey.length < width * 2) continue;
    if (n.advType == null || !ROUTING_ADV_TYPES.has(n.advType)) continue;
    if (opts.heardSinceMs != null && !(typeof n.lastHeard === 'number' && n.lastHeard >= opts.heardSinceMs)) continue;
    const hash = hopByteForKey(n.publicKey, width);
    let group = byHash.get(hash);
    if (!group) byHash.set(hash, (group = new Map()));
    group.set(n.publicKey.toLowerCase(), n); // a duplicate row for one key is not a collision
  }
  const out: PathHashCollisionGroup<N>[] = [];
  for (const [hash, group] of byHash) {
    if (group.size < 2) continue;
    out.push({
      hash,
      nodes: [...group.values()].sort((a, b) => a.publicKey.toLowerCase().localeCompare(b.publicKey.toLowerCase())),
    });
  }
  return out.sort((a, b) => a.hash.localeCompare(b.hash));
}

/** Number of colliding groups at each hash width (1, 2 and 3 bytes). */
export function collisionCountsByWidth(
  nodes: readonly SecurityNode[],
  opts: { heardSinceMs?: number } = {},
): Record<PathHashWidth, number> {
  return {
    1: findPathHashCollisions(nodes, 1, opts).length,
    2: findPathHashCollisions(nodes, 2, opts).length,
    3: findPathHashCollisions(nodes, 3, opts).length,
  };
}

/** Nodes whose latest checked advert failed verification. Null (unchecked) never counts. */
export function listSignatureFailures<N extends SecurityNode>(nodes: readonly N[]): N[] {
  return nodes.filter((n) => n.advertSignatureVerified === false || n.advertSignatureVerified === 0);
}

/** Load one source's nodes for the findings. */
export async function loadMeshcoreSecurityNodes(sourceId: string) {
  return databaseService.meshcore.getNodesBySource(sourceId);
}
