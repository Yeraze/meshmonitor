import { useMemo } from 'react';
import { useDashboardSources, type DashboardSource } from '../../hooks/useDashboardData';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import {
  categoriesForProtocols,
  sourceTypeProtocol,
  type NodeTypeCategory,
} from '../../utils/nodeTypeCategory';

/**
 * The node-type categories the Map Analysis filter/legend should expose, given
 * which protocol families are actually in scope (issue #3610).
 *
 * "In scope" = the sources currently selected in the Map Analysis source filter
 * (`config.sources`), or every enabled source when the selection is empty
 * ("all" semantics). A Meshtastic-only instance therefore sees only Meshtastic
 * role categories; MeshCore-only sees the MeshCore categories; a mixed instance
 * sees the union. While the source list is still loading we fall back to the
 * full category set so the control is never empty.
 */
export function useVisibleNodeTypeCategories(): NodeTypeCategory[] {
  const { config } = useMapAnalysisCtx();
  const { data: sources } = useDashboardSources();

  return useMemo(() => {
    const list: DashboardSource[] = sources ?? [];
    const inScope = list.filter((s) => {
      if (s.enabled === false) return false;
      if (config.sources.length === 0) return true;
      return config.sources.includes(s.id);
    });
    let meshcore = false;
    let meshtastic = false;
    for (const s of inScope) {
      if (sourceTypeProtocol(s.type) === 'meshcore') meshcore = true;
      else meshtastic = true;
    }
    return categoriesForProtocols({ meshcore, meshtastic });
  }, [sources, config.sources]);
}
