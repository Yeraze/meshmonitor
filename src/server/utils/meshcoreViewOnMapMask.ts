/**
 * Strip `latitude`/`longitude` from contact/node rows when the caller lacks
 * `nodes:viewOnMap` on this source (#4559). `nodes:read` makes the contact
 * list available; publishing positions additionally requires `viewOnMap` —
 * mirrors the gate `buildSourceNodes()` applies to the same data for the
 * Dashboard/Unified/Map Analysis maps. Admins and any caller with the grant
 * pass through unchanged.
 *
 * Lives in `utils/` (moved from `routes/meshcoreRouteShared.ts`, which
 * re-exports it) so the v1 API and the metrics collector share it.
 */
import { hasPermission } from '../auth/authMiddleware.js';
import type { User } from '../../types/auth.js';
import { stripPositions } from './meshcorePositions.js';

export async function maskContactPositionsForViewOnMap<T extends { latitude?: number; longitude?: number }>(
  items: T[],
  user: User | null | undefined,
  sourceId: string,
): Promise<T[]> {
  const canViewOnMap = user ? await hasPermission(user, 'nodes', 'viewOnMap', sourceId) : false;
  return canViewOnMap ? items : stripPositions(items);
}
