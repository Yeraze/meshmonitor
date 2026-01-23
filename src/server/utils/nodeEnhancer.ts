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
 * For backwards compatibility: Users with nodes:read permission but no explicit channel permissions
 * will see all nodes (this covers users created before per-channel permissions were introduced).
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

  // Check if user has any channel-specific permissions
  const hasAnyChannelPermission = Object.keys(permissions).some(key => key.startsWith('channel_'));

  // Backwards compatibility: If user has no channel permissions but has nodes:read,
  // allow all nodes (for users created before per-channel permissions)
  if (!hasAnyChannelPermission) {
    if (permissions.nodes?.read === true) {
      return nodes;
    }
    // No permissions at all - return empty
    return [];
  }

  // Pre-compute which channels the user has viewOnMap permission for
  const allowedChannels = new Set<number>();
  for (const key of Object.keys(permissions)) {
    if (key.startsWith('channel_') && permissions[key as ResourceType]?.viewOnMap === true) {
      const channelNum = parseInt(key.replace('channel_', ''), 10);
      if (!isNaN(channelNum)) {
        allowedChannels.add(channelNum);
      }
    }
  }

  // Filter nodes by channel viewOnMap permission for map visibility
  return nodes.filter(node => {
    // Access channel property dynamically since different node types have different shapes
    const nodeWithChannel = node as { channel?: number | null };
    const channelNum = nodeWithChannel.channel;

    // If node has no channel set (null/undefined), allow if user has ANY channel permission
    // This handles nodes that haven't been heard on a specific channel yet
    if (channelNum === null || channelNum === undefined) {
      return allowedChannels.size > 0;
    }

    return allowedChannels.has(channelNum);
  });
}

/**
 * Filter nodes based on channel read permissions.
 * A user can only see nodes that were last heard on a channel they have read permission for.
 * Admins see all nodes.
 *
 * This is used by API endpoints where "read" access is the appropriate permission,
 * as opposed to "viewOnMap" which is specifically for map display.
 *
 * @param nodes - Array of nodes (any type that has an optional channel property)
 * @param user - The user making the request, or null for anonymous
 * @returns Filtered array of nodes the user has permission to read
 */
export async function filterNodesByChannelReadPermission<T>(
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

  // If user has no permissions at all, check if they have nodes:read permission
  // (for backwards compatibility with users created before per-channel permissions)
  const hasAnyChannelPermission = Object.keys(permissions).some(key => key.startsWith('channel_'));

  if (!hasAnyChannelPermission) {
    // No channel permissions set - allow all nodes if user has nodes:read permission
    // This maintains backwards compatibility for users without explicit channel permissions
    if (permissions.nodes?.read === true) {
      return nodes;
    }
    // No permissions at all - return empty (will be handled by the nodes:read check in the endpoint)
    return [];
  }

  // Filter nodes by channel read permission
  return nodes.filter(node => {
    // Access channel property dynamically since different node types have different shapes
    const nodeWithChannel = node as { channel?: number };
    const channelNum = nodeWithChannel.channel ?? 0;
    const channelResource = `channel_${channelNum}` as ResourceType;
    return permissions[channelResource]?.read === true;
  });
}
