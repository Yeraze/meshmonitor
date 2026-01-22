import { hasPermission } from '../auth/authMiddleware.js';
import type { DeviceInfo } from '../meshtasticManager.js';
import type { User } from '../../types/auth.js';
import type { ResourceType, PermissionSet } from '../../types/permission.js';
import databaseService from '../../services/database.js';

/**
 * Helper to enhance a node with position priority logic and privacy masking
 */
export async function enhanceNodeForClient(
  node: DeviceInfo,
  user: User | null,
  estimatedPositions?: Map<string, { latitude: number; longitude: number }>
): Promise<DeviceInfo & { isMobile: boolean }> {
  if (!node.user?.id) return { ...node, isMobile: false, positionIsOverride: false };

  let enhancedNode = { ...node, isMobile: node.mobile === 1, positionIsOverride: false };

  // Priority 1: Check for position override
  const hasOverride = node.positionOverrideEnabled === true && node.latitudeOverride != null && node.longitudeOverride != null;
  const isPrivateOverride = node.positionOverrideIsPrivate === true;

  // Check if user has permission to view private positions
  const canViewPrivate = user ? await hasPermission(user, 'nodes_private', 'read') : false;
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

/**
 * Filter nodes based on channel viewOnMap permissions.
 * A user can only see nodes on the map that were last heard on a channel they have viewOnMap permission for.
 * Admins see all nodes.
 *
 * @param nodes - Array of nodes (any type that has an optional channel property)
 * @param user - The user making the request, or null for anonymous
 * @returns Filtered array of nodes the user has permission to see on the map
 */
export async function filterNodesByChannelPermission<T>(
  nodes: T[],
  user: User | null | undefined
): Promise<T[]> {
  // Admins see all nodes
  if (user?.isAdmin) {
    return nodes;
  }

  // Get user's permission set
  const permissions: PermissionSet = user
    ? await databaseService.getUserPermissionSetAsync(user.id)
    : {};

  // Filter nodes by channel viewOnMap permission for map visibility
  return nodes.filter(node => {
    // Access channel property dynamically since different node types have different shapes
    const nodeWithChannel = node as { channel?: number };
    const channelNum = nodeWithChannel.channel ?? 0;
    const channelResource = `channel_${channelNum}` as ResourceType;
    return permissions[channelResource]?.viewOnMap === true;
  });
}
