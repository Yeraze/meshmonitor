import { DeviceRole } from '../../constants/index.js';

/** Roles that benefit from zero-cost hop favoriting */
export const AUTO_FAVORITE_LOCAL_ROLES = new Set([
  DeviceRole.ROUTER,
  DeviceRole.ROUTER_LATE,
  DeviceRole.CLIENT_BASE,
]);

/** Roles eligible as zero-cost relay favorites (for ROUTER/ROUTER_LATE local) */
export const ZERO_HOP_RELAY_ROLES = new Set([
  DeviceRole.ROUTER,
  DeviceRole.ROUTER_LATE,
  DeviceRole.CLIENT_BASE,
]);

interface AutoFavoriteTarget {
  hopsAway?: number | null;
  role?: number | null;
  isFavorite?: boolean | null;
}

/**
 * Determines if a target node is eligible for auto-favoriting.
 * - Local must be ROUTER, ROUTER_LATE, or CLIENT_BASE
 * - Target must be 0-hop (hopsAway === 0)
 * - Target must not already be favorited
 * - For ROUTER/ROUTER_LATE local: target must also be ROUTER/ROUTER_LATE/CLIENT_BASE
 * - For CLIENT_BASE local: any role is eligible
 */
export function isAutoFavoriteEligible(
  localRole: number | undefined | null,
  target: AutoFavoriteTarget
): boolean {
  if (localRole == null || !AUTO_FAVORITE_LOCAL_ROLES.has(localRole)) {
    return false;
  }
  if (target.hopsAway == null || target.hopsAway !== 0) {
    return false;
  }
  if (target.isFavorite) {
    return false;
  }
  if (localRole === DeviceRole.ROUTER || localRole === DeviceRole.ROUTER_LATE) {
    if (target.role == null || !ZERO_HOP_RELAY_ROLES.has(target.role)) {
      return false;
    }
  }
  return true;
}

/**
 * Checks if a local node role is valid for auto-favorite feature.
 */
export function isAutoFavoriteValidRole(role: number | undefined | null): boolean {
  return role != null && AUTO_FAVORITE_LOCAL_ROLES.has(role);
}
