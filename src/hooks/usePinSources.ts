/**
 * usePinSources — the sources the current user may add a map pin to (#5685).
 *
 * `markerSources`: every enabled source the user holds `waypoints:write` on
 * (a local marker is stored only, so any source type will do).
 * `waypointSources`: the subset whose radio can send a waypoint.
 */
import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useDashboardSources, type DashboardSource } from './useDashboardData';
import { canSourceSendWaypoints } from '../utils/waypointSources';

export interface PinSource {
  id: string;
  name: string;
}

export function usePinSources(): { markerSources: PinSource[]; waypointSources: PinSource[] } {
  const { data } = useDashboardSources();
  const { hasPermission } = useAuth();
  return useMemo(() => {
    const sources = (data ?? []) as DashboardSource[];
    const writable = sources.filter(
      (s) => s.enabled !== false && hasPermission('waypoints', 'write', { sourceId: s.id }),
    );
    const pick = (s: DashboardSource): PinSource => ({ id: s.id, name: s.name || s.id });
    return {
      markerSources: writable.map(pick),
      waypointSources: writable.filter(canSourceSendWaypoints).map(pick),
    };
  }, [data, hasPermission]);
}
