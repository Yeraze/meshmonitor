/**
 * Shared node-search matching for the Map Analysis view (issue #3399).
 * Mirrors the filter idiom used by GeofenceNodeSelector: case-insensitive
 * substring match against long name, short name and the node id (decimal + hex).
 */

export interface SearchableNode {
  nodeNum: number;
  longName?: string | null;
  shortName?: string | null;
  nodeId?: string | null;
}

/** True when `term` is empty (no filter) or matches the node's names/ids. */
export function nodeMatchesSearch(node: SearchableNode, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  const num = Number(node.nodeNum);
  const hex = `!${(num >>> 0).toString(16)}`;
  const candidates = [
    node.longName ?? '',
    node.shortName ?? '',
    node.nodeId ?? '',
    hex,
    String(num),
  ];
  return candidates.some((c) => c.toLowerCase().includes(t));
}

/**
 * Build the set of node numbers visible under a search term. Returns null when
 * the term is empty so callers can treat "no filter" as "show everything"
 * without allocating a set.
 */
export function visibleNodeNumSet(
  nodes: SearchableNode[],
  term: string,
): Set<number> | null {
  if (!term.trim()) return null;
  const set = new Set<number>();
  for (const n of nodes) {
    if (nodeMatchesSearch(n, term)) set.add(Number(n.nodeNum));
  }
  return set;
}
