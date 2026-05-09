/**
 * DashboardWaypoints — renders waypoint markers on the Dashboard map.
 *
 * Reuses `PerSourceWaypoints` from MapAnalysis/layers/WaypointsLayer to keep
 * marker visuals identical across the two map surfaces. When `sourceId` is
 * null (unified Dashboard view), iterates all known sources; when set,
 * renders waypoints for that single source.
 */
import { useDashboardSources } from '../../hooks/useDashboardData';
import {
  PerSourceWaypoints,
  type SourceInfo,
  type WaypointPopupActions,
} from '../MapAnalysis/layers/WaypointsLayer';

interface DashboardWaypointsProps {
  /** A real source UUID renders waypoints for that source only. Any other
   *  value (null, undefined, or the unified-view sentinel `"__unified__"`)
   *  renders waypoints across all known sources. */
  sourceId: string | null;
  /** Optional edit/delete actions; only meaningful on the per-source dashboard
   *  surface where the caller knows which source is active. */
  actions?: WaypointPopupActions;
}

export default function DashboardWaypoints({ sourceId, actions }: DashboardWaypointsProps) {
  const { data: sources = [] } = useDashboardSources();
  const sourceList = sources as SourceInfo[];

  // Filter only when sourceId matches a real source; otherwise treat as "all".
  const matched = sourceId ? sourceList.find((s) => s.id === sourceId) : null;
  const visible = matched ? [matched] : sourceList;
  // Authoring actions only apply when we're scoped to a single real source —
  // on the unified ("all sources") view, edit/delete is ambiguous.
  const passedActions = matched ? actions : undefined;

  return (
    <>
      {visible.map((s) => (
        <PerSourceWaypoints key={s.id} source={s} actions={passedActions} />
      ))}
    </>
  );
}
