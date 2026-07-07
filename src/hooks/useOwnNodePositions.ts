/**
 * Hook that resolves each source's own (local) node position for the polar grid
 * overlay on the Map Analysis view (#3971).
 *
 * It reuses the same cross-source data the Map Analysis markers already fetch
 * (`useDashboardUnifiedData`) plus each source's status (`useSourceStatuses`,
 * which carries the local `nodeNum`), so no extra network round-trips are added
 * beyond what TanStack Query already caches for the canvas.
 */
import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
  useSourceStatuses,
} from './useDashboardData';
import { getOwnNodePositions, type OwnNodePosition } from '../utils/ownNodePositions';

/**
 * @param activeSourceIds  sources to resolve own-node positions for. An empty
 *                         array means "all configured sources" (Map Analysis's
 *                         `config.sources` uses the same empty = all convention).
 */
export function useOwnNodePositions(activeSourceIds: string[]): OwnNodePosition[] {
  const { data: sources = [] } = useDashboardSources();
  const allSourceIds = (sources as Array<{ id: string }>).map((s) => s.id);

  // Full source objects so the merge keys nodes by nodeNum across sources.
  const { nodes } = useDashboardUnifiedData(sources, allSourceIds.length > 0);
  const statuses = useSourceStatuses(allSourceIds);

  return useMemo(() => {
    const ids = activeSourceIds.length > 0 ? activeSourceIds : allSourceIds;
    const localNumBySource = new Map<string, number | null | undefined>();
    for (const id of ids) {
      const status = statuses.get(id);
      localNumBySource.set(id, (status as { nodeNum?: number } | null)?.nodeNum ?? null);
    }
    return getOwnNodePositions(nodes as Parameters<typeof getOwnNodePositions>[0], localNumBySource);
    // `statuses` is a fresh Map each render; key its contents instead so we don't
    // recompute on every poll when nothing relevant changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, activeSourceIds.join(','), allSourceIds.join(','), statusKey(statuses)]);
}

/** Stable signature of the local nodeNum per source so useMemo can dedupe. */
function statusKey(statuses: Map<string, { nodeNum?: number } | null>): string {
  const parts: string[] = [];
  for (const [id, s] of statuses) parts.push(`${id}:${s?.nodeNum ?? ''}`);
  return parts.join('|');
}
