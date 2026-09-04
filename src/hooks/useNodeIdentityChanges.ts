/**
 * useNodeIdentityChanges — candidate Meshtastic 2.8 node-number changes for
 * one source (issue #5032).
 *
 * 2.8 derives a node's number from its public key rather than its MAC, so an
 * upgraded node turns up as a brand-new node and its history is orphaned under
 * the old number. This hook fetches the server's read-only pairing report once
 * per source and indexes it two ways, so a node row or a detail panel can ask
 * "is this node one half of a handover?" without another request.
 *
 * The report is cheap but not free (one query plus a linear scan per source),
 * and the answer only changes when a node upgrades — hence the long
 * `staleTime`. No raw fetch: everything goes through ApiService.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';
import type { IdentityChangeDetection } from '../types/nodeIdentityChange';

export interface UseNodeIdentityChangesResult {
  /** Every detection for the source, newest handover first. */
  detections: IdentityChangeDetection[];
  /** Keyed by the NEW node's number — "this node used to be …". */
  bySuccessorNodeNum: Map<number, IdentityChangeDetection>;
  /** Keyed by the OLD node's number — "this node's traffic continues as …". */
  byPredecessorNodeNum: Map<number, IdentityChangeDetection>;
  isLoading: boolean;
  isError: boolean;
}

const EMPTY: IdentityChangeDetection[] = [];

/**
 * @param sourceId the source to inspect. The query stays disabled while falsy —
 *   detection is per-source by construction and has no cross-source mode.
 */
export function useNodeIdentityChanges(sourceId: string | null | undefined): UseNodeIdentityChangesResult {
  const query = useQuery({
    queryKey: ['nodeIdentityChanges', sourceId],
    queryFn: () => apiService.getNodeIdentityChanges(sourceId as string),
    enabled: Boolean(sourceId),
    // A firmware upgrade is a once-per-node event; refetching often buys
    // nothing and costs a full node scan per source.
    staleTime: 5 * 60_000,
    // A caller without nodes:read gets a 403 — retrying can't fix that.
    retry: false,
  });

  const detections = query.data?.detections ?? EMPTY;

  const { bySuccessorNodeNum, byPredecessorNodeNum } = useMemo(() => {
    const successors = new Map<number, IdentityChangeDetection>();
    const predecessors = new Map<number, IdentityChangeDetection>();
    for (const d of detections) {
      // One detection per successor by construction, so no collision here.
      successors.set(d.successor.nodeNum, d);
      // A predecessor could in principle be claimed by two successors; keep
      // the first (the list is ordered strongest/newest first).
      if (!predecessors.has(d.predecessor.nodeNum)) predecessors.set(d.predecessor.nodeNum, d);
    }
    return { bySuccessorNodeNum: successors, byPredecessorNodeNum: predecessors };
  }, [detections]);

  return {
    detections,
    bySuccessorNodeNum,
    byPredecessorNodeNum,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export default useNodeIdentityChanges;
