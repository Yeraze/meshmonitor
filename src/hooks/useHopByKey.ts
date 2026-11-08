import { useMemo } from 'react';
import { useHopCounts } from './useMapAnalysisData';
import { unifiedNodeKey, type IdentifiableNode } from '../utils/nodeIdentity';
import type { HopEntry } from '../services/analysisApi';

/**
 * Normalise a `nodeKey`: MeshCore public keys compare case-insensitively.
 * Keys are `mt:<nodeNum>` or `mc:<publicKey>`; the synthetic nodeNum MeshCore
 * rows carry is never used for identity.
 */
function normKey(key: string): string {
  return key.startsWith('mc:') ? `mc:${key.slice(3).toLowerCase()}` : key;
}

/** Map key for one node on one source. */
export function hopMapKey(sourceId: string | undefined, nodeKey: string): string {
  return `${sourceId ?? ''}|${normKey(nodeKey)}`;
}

/** Build the `${sourceId}|${nodeKey}` -> hops map from hop-count entries. */
export function buildHopByKey(entries: readonly HopEntry[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries ?? []) {
    // Entries from a server without MeshCore support carry no nodeKey.
    const key = e.nodeKey ?? `mt:${Number(e.nodeNum)}`;
    m.set(hopMapKey(e.sourceId, key), e.hops);
  }
  return m;
}

/** Hop count for a node (any protocol) via its canonical unified key. */
export function lookupHops(
  hopByKey: ReadonlyMap<string, number>,
  sourceId: string | undefined,
  node: IdentifiableNode,
): number | undefined {
  const key = unifiedNodeKey(node);
  return key === null ? undefined : hopByKey.get(hopMapKey(sourceId, key));
}

/**
 * Hop counts keyed `${sourceId}|${nodeKey}`, shared by every Map Analysis
 * surface (2D markers, 3D markers, inspector) so they cannot drift.
 */
export function useHopByKey(args: { enabled: boolean; sources: string[] }) {
  const hop = useHopCounts(args);
  const entries = (hop.data as { entries?: HopEntry[] } | undefined)?.entries;
  const hopByKey = useMemo(() => buildHopByKey(entries), [entries]);
  return { hopByKey, query: hop };
}
