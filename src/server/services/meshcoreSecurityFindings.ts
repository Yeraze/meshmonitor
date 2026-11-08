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
import databaseService from '../../services/database.js';

/** The node fields the findings need. A `DbMeshCoreNode` satisfies this. */
export interface SecurityNode {
  publicKey: string;
  name?: string | null;
  advType?: number | null;
  /** Epoch ms. */
  lastHeard?: number | null;
  /** Epoch ms. */
  firstHeard?: number | null;
  advertSignatureVerified?: boolean | number | null;
}

export type PathHashWidth = 1 | 2 | 3;

export interface PathHashCollisionGroup<N extends SecurityNode = SecurityNode> {
  /** Lowercase hex routing hash (2 / 4 / 6 chars). */
  hash: string;
  /** Two or more nodes, sorted by key. */
  nodes: N[];
}

export interface NameReuseGroup<N extends SecurityNode = SecurityNode> {
  /** The original's trimmed display name. */
  name: string;
  /** The key heard first (earliest `firstHeard`; null last; ties by key). */
  original: N;
  /** Every other key using the name, ordered the same way. */
  suspects: N[];
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

function normalizeName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

function heardFirstOrder(a: SecurityNode, b: SecurityNode): number {
  const fa = typeof a.firstHeard === 'number' ? a.firstHeard : Number.POSITIVE_INFINITY;
  const fb = typeof b.firstHeard === 'number' ? b.firstHeard : Number.POSITIVE_INFINITY;
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a.publicKey.toLowerCase().localeCompare(b.publicKey.toLowerCase());
}

/**
 * Names used by more than one key. Trimmed and case-insensitive; empty names
 * are ignored. The key heard first is the original, the rest are suspects.
 */
export function findNameReuse<N extends SecurityNode>(nodes: readonly N[]): NameReuseGroup<N>[] {
  const byName = new Map<string, Map<string, N>>();
  for (const n of nodes) {
    const norm = normalizeName(n.name);
    if (!norm || !n.publicKey) continue;
    let group = byName.get(norm);
    if (!group) byName.set(norm, (group = new Map()));
    group.set(n.publicKey.toLowerCase(), n);
  }
  const out: NameReuseGroup<N>[] = [];
  for (const group of byName.values()) {
    if (group.size < 2) continue;
    const sorted = [...group.values()].sort(heardFirstOrder);
    const [original, ...suspects] = sorted;
    out.push({ name: (original.name ?? '').trim(), original, suspects });
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** Lowercase keys of every suspect, for the shared "flagged" filter. */
export function nameReuseSuspectKeys(groups: readonly NameReuseGroup[]): Set<string> {
  const keys = new Set<string>();
  for (const g of groups) for (const s of g.suspects) keys.add(s.publicKey.toLowerCase());
  return keys;
}

/** Load one source's nodes for the findings. */
export async function loadMeshcoreSecurityNodes(sourceId: string) {
  return databaseService.meshcore.getNodesBySource(sourceId);
}
