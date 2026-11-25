/**
 * Enabled walkabout-capable sources the viewer can read (#5891).
 * One filter for the Walkabout page and the Coverage Report view.
 */
import { useMemo } from 'react';
import type { ResourceType } from '../types/permission.js';
import { useWalkaboutSources, type WalkaboutSourceRow } from './useWalkabout.js';
import { WALKABOUT_READ_GRANT, WALKABOUT_SOURCE_TYPES } from '../utils/walkabout.js';

export type HasSourcePermission = (
  resource: ResourceType,
  action: 'read' | 'write',
  opts?: { sourceId?: string | null },
) => boolean;

export function useReadableWalkaboutSources(hasPermission: HasSourcePermission): WalkaboutSourceRow[] {
  const sourcesQ = useWalkaboutSources();
  return useMemo(
    () =>
      (sourcesQ.data ?? []).filter(
        (s) =>
          s.enabled !== false &&
          WALKABOUT_SOURCE_TYPES.has(s.type ?? '') &&
          hasPermission(WALKABOUT_READ_GRANT.resource, WALKABOUT_READ_GRANT.action, { sourceId: s.id }),
      ),
    [sourcesQ.data, hasPermission],
  );
}
