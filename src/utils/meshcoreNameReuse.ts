/**
 * Pure MeshCore name-reuse and signature rules (P7a, #6254), shared by the
 * server Security findings and the client node-list filter so both use one
 * implementation. No server or DB imports here: the client bundles this file.
 */

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

export interface NameReuseGroup<N extends SecurityNode = SecurityNode> {
  /** The original's trimmed display name. */
  name: string;
  /** The key heard first (earliest `firstHeard`; null last; ties by key). */
  original: N;
  /** Every other key using the name, ordered the same way. */
  suspects: N[];
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
