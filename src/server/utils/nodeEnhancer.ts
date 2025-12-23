import { hasPermission } from '../auth/authMiddleware.js';
import type { DeviceInfo } from '../meshtasticManager.js';
import type { User } from '../../types/auth.js';

/**
 * Helper to enhance a node with position priority logic and privacy masking
 */
export function enhanceNodeForClient(
  node: DeviceInfo, 
  user: User | null, 
  estimatedPositions?: Map<string, { latitude: number; longitude: number }>
): DeviceInfo & { isMobile: boolean } {
  if (!node.user?.id) return { ...node, isMobile: false, positionIsOverride: false };

  let enhancedNode = { ...node, isMobile: node.mobile === 1, positionIsOverride: false };

  // Priority 1: Check for position override
  const hasOverride = node.positionOverrideEnabled === 1 && node.latitudeOverride != null && node.longitudeOverride != null;
  const isPrivateOverride = !!node.positionOverrideIsPrivate;
  
  // Check if user has permission to view private positions
  const canViewPrivate = user ? hasPermission(user, 'nodes_private', 'read') : false;
  const shouldApplyOverride = hasOverride && (!isPrivateOverride || canViewPrivate);

  // CRITICAL: Mask sensitive override coordinates if user is not authorized to see them
  if (isPrivateOverride && !canViewPrivate) {
    const nodeToMask = enhancedNode as Partial<DeviceInfo>;
    delete nodeToMask.latitudeOverride;
    delete nodeToMask.longitudeOverride;
    delete nodeToMask.altitudeOverride;
  }

  if (shouldApplyOverride) {
    enhancedNode.position = {
      latitude: node.latitudeOverride!,
      longitude: node.longitudeOverride!,
      altitude: node.altitudeOverride ?? node.position?.altitude,
    };
    enhancedNode.positionIsOverride = true;
    return enhancedNode;
  }

  // Priority 2: Use regular GPS position if available (already set in node.position)
  if (node.position?.latitude && node.position?.longitude) {
    return enhancedNode;
  }

  // Priority 3: Use estimated position if available
  const estimatedPos = estimatedPositions?.get(node.user.id);
    
  if (estimatedPos) {
    enhancedNode.position = {
      latitude: estimatedPos.latitude,
      longitude: estimatedPos.longitude,
      altitude: node.position?.altitude,
    };
    return enhancedNode;
  }

  return enhancedNode;
}
