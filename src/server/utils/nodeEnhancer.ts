import { hasPermission } from '../auth/authMiddleware.js';
import type { DeviceInfo } from '../meshtasticManager.js';
import type { User } from '../../types/auth.js';
import type { ResourceType, PermissionSet } from '../../types/permission.js';
import databaseService from '../../services/database.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';

/**
 * Helper to enhance a node with position priority logic and privacy masking
 */
export async function enhanceNodeForClient(
  node: DeviceInfo,
  user: User | null,
  estimatedPositions?: Map<string, { latitude: number; longitude: number }>,
  canViewPrivateOverride?: boolean
): Promise<DeviceInfo & { isMobile: boolean }> {
  if (!node.user?.id) return { ...node, isMobile: false, positionIsOverride: false };

  let enhancedNode = { ...node, isMobile: node.mobile === 1, positionIsOverride: false };

  // Priority 1: Check for position override
  const hasOverride = node.positionOverrideEnabled === true && node.latitudeOverride != null && node.longitudeOverride != null;
  const isPrivateOverride = node.positionOverrideIsPrivate === true;

  // Check if user has permission to view private positions (use pre-computed value if provided)
  const canViewPrivate = canViewPrivateOverride !== undefined
    ? canViewPrivateOverride
    : (user ? await hasPermission(user, 'nodes_private', 'read') : false);
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
 * For device channels (0-7), uses the regular permission system.
 * For virtual channels (>= CHANNEL_DB_OFFSET), uses channel database permissions.
 *
 * @param nodes - Array of nodes (any type that has an optional channel property)
 * @param user - The user making the request, or null for anonymous
 * @returns Filtered array of nodes the user has permission to see on the map
 */
export async function filterNodesByChannelPermission<T>(
  nodes: T[],
  user: User | null | undefined,
  sourceId?: string
): Promise<T[]> {
  // Admins see all nodes
  if (user?.isAdmin) {
    return nodes;
  }

  // Get user's device channel permission set
  const permissions: PermissionSet = user
    ? await databaseService.getUserPermissionSetAsync(user.id, sourceId)
    : {};

  // Get user's virtual channel (channel database) permissions
  const channelDbPermissions = user
    ? await databaseService.getChannelDatabasePermissionsForUserAsSetAsync(user.id)
    : {};

  // Filter nodes by channel viewOnMap permission for map visibility
  return nodes.filter(node => {
    // Access channel property dynamically since different node types have different shapes
    const nodeWithChannel = node as { channel?: number };
    const channelNum = nodeWithChannel.channel ?? 0;

    // Device channels (0-7)
    if (channelNum < CHANNEL_DB_OFFSET) {
      const channelResource = `channel_${channelNum}` as ResourceType;
      return permissions[channelResource]?.viewOnMap === true;
    }

    // Virtual channels (>= CHANNEL_DB_OFFSET)
    const channelDbId = channelNum - CHANNEL_DB_OFFSET;
    return channelDbPermissions[channelDbId]?.viewOnMap === true;
  });
}

/**
 * Mask location fields on nodes where the user lacks access to the positionChannel.
 *
 * A node's GPS position may arrive on a different (private) channel than the channel
 * the node is generally heard on. This function strips latitude/longitude and related
 * position fields for any node whose positionChannel is inaccessible to the user,
 * preventing private-channel location data from leaking via the nodes API.
 *
 * Nodes with no positionChannel recorded are left unchanged (no position to protect).
 * Admins always see full data.
 *
 * @param nodes - Array of nodes (any type that may have location/positionChannel fields)
 * @param user  - The user making the request, or null/undefined for anonymous
 * @returns Array with location fields stripped where positionChannel is inaccessible
 */
export async function maskNodeLocationByChannel<T>(
  nodes: T[],
  user: User | null | undefined,
  sourceId?: string
): Promise<T[]> {
  if (user?.isAdmin) return nodes;

  // Get user's device channel permission set
  const permissions: PermissionSet = user
    ? await databaseService.getUserPermissionSetAsync(user.id, sourceId)
    : {};

  // Get user's virtual channel (channel database) permissions
  const channelDbPermissions = user
    ? await databaseService.getChannelDatabasePermissionsForUserAsSetAsync(user.id)
    : {};

  return nodes.map(node => {
    const nodeWithPos = node as { positionChannel?: number };
    const posChannel = nodeWithPos.positionChannel;

    // No positionChannel recorded — nothing to mask
    if (posChannel === undefined || posChannel === null) {
      return node;
    }

    // Check if the user can see data from this position channel
    let hasPositionChannelAccess: boolean;
    if (posChannel < CHANNEL_DB_OFFSET) {
      const channelResource = `channel_${posChannel}` as ResourceType;
      hasPositionChannelAccess = permissions[channelResource]?.viewOnMap === true;
    } else {
      const channelDbId = posChannel - CHANNEL_DB_OFFSET;
      hasPositionChannelAccess = channelDbPermissions[channelDbId]?.viewOnMap === true;
    }

    if (hasPositionChannelAccess) {
      return node;
    }

    // Strip location fields — user cannot access the channel this position came from
    const masked = { ...node } as Record<string, unknown>;
    delete masked.latitude;
    delete masked.longitude;
    delete masked.altitude;
    delete masked.positionChannel;
    delete masked.positionTimestamp;
    delete masked.positionPrecisionBits;
    delete masked.positionGpsAccuracy;
    delete masked.positionHdop;
    return masked as T;
  });
}

/**
 * Filter telemetry records where the user lacks access to the source channel.
 *
 * Each telemetry record carries an optional `channel` field indicating which mesh
 * channel the packet was received on. Records from a private (inaccessible) channel
 * are removed entirely — the individual values would leak channel-private sensor data.
 *
 * Records with no channel recorded are left unchanged (channel unknown / pre-migration).
 * Admins always see all records.
 *
 * @param records - Array of telemetry records (any type with an optional channel field)
 * @param user    - The user making the request, or null/undefined for anonymous
 * @returns Array with records from inaccessible channels removed
 */
export async function maskTelemetryByChannel<T>(
  records: T[],
  user: User | null | undefined,
  sourceId?: string
): Promise<T[]> {
  if (user?.isAdmin) return records;

  const permissions: PermissionSet = user
    ? await databaseService.getUserPermissionSetAsync(user.id, sourceId)
    : {};

  const channelDbPermissions = user
    ? await databaseService.getChannelDatabasePermissionsForUserAsSetAsync(user.id)
    : {};

  return records.filter(record => {
    const r = record as { channel?: number | null };
    const ch = r.channel;

    // No channel recorded — no channel restriction
    if (ch === undefined || ch === null) return true;

    if (ch < CHANNEL_DB_OFFSET) {
      const channelResource = `channel_${ch}` as ResourceType;
      return permissions[channelResource]?.viewOnMap === true;
    }

    const channelDbId = ch - CHANNEL_DB_OFFSET;
    return channelDbPermissions[channelDbId]?.viewOnMap === true;
  });
}

/**
 * Filter traceroute records where the user lacks access to the source channel.
 *
 * Traceroutes carry a `channel` field set when the response packet was received on
 * a specific mesh channel. Traceroutes from a private (inaccessible) channel are
 * removed so the route topology doesn't leak private-channel network data.
 *
 * Records with no channel recorded (null/pre-migration) are left unchanged.
 * Admins always see all records.
 *
 * @param records - Array of traceroute records (any type with an optional channel field)
 * @param user    - The user making the request, or null/undefined for anonymous
 * @returns Array with records from inaccessible channels removed
 */
export async function maskTraceroutesByChannel<T>(
  records: T[],
  user: User | null | undefined,
  sourceId?: string
): Promise<T[]> {
  if (user?.isAdmin) return records;

  const permissions: PermissionSet = user
    ? await databaseService.getUserPermissionSetAsync(user.id, sourceId)
    : {};

  const channelDbPermissions = user
    ? await databaseService.getChannelDatabasePermissionsForUserAsSetAsync(user.id)
    : {};

  return records.filter(record => {
    const r = record as { channel?: number | null };
    const ch = r.channel;

    // No channel recorded — no channel restriction
    if (ch === undefined || ch === null) return true;

    if (ch < CHANNEL_DB_OFFSET) {
      const channelResource = `channel_${ch}` as ResourceType;
      return permissions[channelResource]?.viewOnMap === true;
    }

    const channelDbId = ch - CHANNEL_DB_OFFSET;
    return channelDbPermissions[channelDbId]?.viewOnMap === true;
  });
}

/**
 * Check if a user has viewOnMap permission for the channel that a specific node belongs to.
 * Used to enforce per-node channel-based access control on telemetry/position endpoints.
 */
export async function checkNodeChannelAccess(
  nodeId: string,
  user: User | null | undefined,
  sourceId?: string
): Promise<boolean> {
  if (user?.isAdmin) return true;

  // Support both hex nodeId (!abcdef01) and decimal nodeId (2882400001)
  const nodeNum = nodeId.startsWith('!')
    ? parseInt(nodeId.replace('!', ''), 16)
    : parseInt(nodeId, 10);
  const node = await databaseService.nodes.getNode(nodeNum);
  const channelNum = node?.channel ?? 0;

  // Get user's device channel permission set
  const permissions: PermissionSet = user
    ? await databaseService.getUserPermissionSetAsync(user.id, sourceId)
    : {};

  // Device channels (0-7)
  if (channelNum < CHANNEL_DB_OFFSET) {
    const channelResource = `channel_${channelNum}` as ResourceType;
    return permissions[channelResource]?.viewOnMap === true;
  }

  // Virtual channels (>= CHANNEL_DB_OFFSET)
  const channelDbPermissions = user
    ? await databaseService.getChannelDatabasePermissionsForUserAsSetAsync(user.id)
    : {};
  const channelDbId = channelNum - CHANNEL_DB_OFFSET;
  return channelDbPermissions[channelDbId]?.viewOnMap === true;
}
