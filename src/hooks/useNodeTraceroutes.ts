/**
 * useNodeTraceroutes (Traceroute Strip Interactivity epic, phase 2) —
 * traceroutes a node took part in, either as an endpoint or as an
 * intermediate hop, for the Node Details traceroute picker.
 *
 * One-shot query (the `useLinkQuality` shape), NOT the poll cache: the poll
 * ships a global 24h list keyed off /api/traceroutes/recent, while the
 * picker needs a node-scoped, participation-matched list that no poll
 * payload carries.
 *
 * `useResolvedSourceId()` rather than `useSource()`: MessagesTab can mount
 * outside a SourceProvider, where `sourceId` is null and the endpoint would
 * 400. The resolver falls back to the primary source, and `enabled` defers
 * the request until it lands.
 */
import { useQuery } from '@tanstack/react-query';
import apiService, { type TracerouteParticipationEntry } from '../services/api';
import { useResolvedSourceId } from './useResolvedSourceId';

// Amendment (post-validation, direct user request, SR_PHASE2_SPEC.md D14/S1):
// the picker's window now matches the Traceroute History dialog — the node's
// 50 most recent stored traceroutes, no time window. `hours` is left unset so
// the server applies no time filter.
const PARTICIPATION_LIMIT = 50;

export function useNodeTraceroutes(
  nodeNum: number | null,
  opts: { enabled?: boolean } = {},
) {
  const sourceId = useResolvedSourceId();
  return useQuery<TracerouteParticipationEntry[]>({
    queryKey: ['tracerouteParticipation', sourceId, nodeNum],
    queryFn: () => apiService.getTracerouteParticipation(nodeNum!, sourceId!, { limit: PARTICIPATION_LIMIT }),
    // sourceId/nodeNum are required by the endpoint — defer until both resolve.
    enabled: (opts.enabled ?? true) && nodeNum != null && !!sourceId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
