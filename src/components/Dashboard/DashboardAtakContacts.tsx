/**
 * DashboardAtakContacts — renders ATAK contact markers on the Dashboard map
 * (ATAK/CoT Phase 2, issue #3691).
 *
 * Reuses `AtakContactsLayer` from `map/layers/AtakContactsLayer` to keep
 * marker visuals identical across map surfaces. When `sourceId` is null
 * (unified Dashboard view), iterates all known sources; when set, renders
 * contacts for that single source. Modeled directly on `DashboardWaypoints`.
 */
import { useDashboardSources } from '../../hooks/useDashboardData';
import { AtakContactsLayer, type SourceInfo } from '../map/layers/AtakContactsLayer';

interface DashboardAtakContactsProps {
  /** A real source UUID renders contacts for that source only. Any other
   *  value (null, undefined, or the unified-view sentinel `"__unified__"`)
   *  renders contacts across all known sources. */
  sourceId: string | null;
}

export default function DashboardAtakContacts({ sourceId }: DashboardAtakContactsProps) {
  const { data: sources = [] } = useDashboardSources();
  const sourceList = sources as SourceInfo[];

  // Filter only when sourceId matches a real source; otherwise treat as "all".
  const matched = sourceId ? sourceList.find((s) => s.id === sourceId) : null;
  const visible = matched ? [matched] : sourceList;

  return (
    <>
      {visible.map((s) => (
        <AtakContactsLayer key={s.id} source={s} />
      ))}
    </>
  );
}
