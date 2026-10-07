import { hasPermission } from '../auth/authMiddleware.js';
import type { DeviceInfo } from '../meshtasticManager.js';
import type { User } from '../../types/auth.js';
import type { ResourceType, PermissionSet } from '../../types/permission.js';
import databaseService from '../../services/database.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import { effectiveIsMobile } from '../../utils/assetTracking.js';
import { loadSourcePermissions } from './sourcePermissions.js';
import type { SourcePermissions } from './sourcePermissions.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';

/**
 * Effective position fields for a database node row.
 *
 * `latitude`/`longitude`/`altitude` are the device-reported GPS columns;
 * `latitudeOverride`/`longitudeOverride`/`altitudeOverride` are the user-set
 * override that takes precedence when `positionOverrideEnabled` is true.
 */
type DbNodePositionFields = {
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
  positionOverrideEnabled?: boolean | number | null;
  latitudeOverride?: number | null;
  longitudeOverride?: number | null;
  altitudeOverride?: number | null;
};

export interface EffectivePosition {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  altitude: number | null | undefined;
  isOverride: boolean;
}

/**
 * Get the effective position for a raw database node row, respecting any
 * user-set position override.
 *
 * Both the device-reported GPS (latitude/longitude) and the user override
 * (latitudeOverride/longitudeOverride) are stored together so the historical
 * GPS trail is preserved, but every read-side surface should consult this
 * helper so the user's override is what's actually displayed/used downstream
 * (issue #2847).
 *
 * Returns the override coords when `positionOverrideEnabled` is truthy AND
 * both override coords are non-null; otherwise falls back to the device GPS
 * columns. SQLite returns 1/0 for booleans; PostgreSQL/MySQL return real
 * booleans — both are handled via truthy check.
 */
export function getEffectiveDbNodePosition(
  node: DbNodePositionFields | null | undefined,
): EffectivePosition {
  if (!node) {
    return { latitude: undefined, longitude: undefined, altitude: undefined, isOverride: false };
  }

  if (
    node.positionOverrideEnabled &&
    node.latitudeOverride != null &&
    node.longitudeOverride != null
  ) {
    return {
      latitude: node.latitudeOverride,
      longitude: node.longitudeOverride,
      altitude: node.altitudeOverride ?? node.altitude,
      isOverride: true,
    };
  }

  return {
    latitude: node.latitude,
    longitude: node.longitude,
    altitude: node.altitude,
    isOverride: false,
  };
}

/**
 * Helper to enhance a node with position priority logic and privacy masking.
 *
 * `assets` (#5354) is the global tracked-asset map, loaded once per request.
 * An asset gets `asset: { retentionDays }` and `isMobile: true` — a computed
 * overlay only. `node.mobile` (the heuristic column) is passed through as-is,
 * so nothing downstream that reads it (becameMobile, automation tokens) sees
 * the asset flag.
 * Keep in step with the same overlay in `buildSourceNodes` (sourceDashboardData.ts).
 */
export async function enhanceNodeForClient(
  node: DeviceInfo,
  user: User | null,
  estimatedPositions?: Map<string, { latitude: number; longitude: number; uncertaintyKm?: number | null }>,
  canViewPrivateOverride?: boolean,
  assets?: Map<number, { retentionDays: number }>
): Promise<DeviceInfo & { isMobile: boolean }> {
  const assetEntry = assets?.get(Number(node.nodeNum));
  const asset = assetEntry ? { retentionDays: assetEntry.retentionDays } : undefined;
  if (!node.user?.id) {
    return { ...node, asset, isMobile: effectiveIsMobile(node.mobile, asset), positionIsOverride: false, positionIsEstimated: false };
  }

  const enhancedNode = { ...node, asset, isMobile: effectiveIsMobile(node.mobile, asset), positionIsOverride: false, positionIsEstimated: false };

  // Priority 1: Check for position override
  const hasOverride = node.positionOverrideEnabled === true && node.latitudeOverride != null && node.longitudeOverride != null;
  const isPrivateOverride = node.positionOverrideIsPrivate === true;

  // Whether the caller may see a private override. Callers pass it, computed
  // once per request for the node's source (`loadNodeViewAccess`). Without it
  // the check is made on the node's own source: `nodes_private` is a
  // per-source permission, and a check with no source passes on a grant for
  // any source. A node that names no source is shown to admins only.
  const nodeSourceId = (node as { sourceId?: string | null }).sourceId;
  const canViewPrivate = canViewPrivateOverride !== undefined
    ? canViewPrivateOverride
    : !user
      ? false
      : nodeSourceId
        ? await hasPermission(user, 'nodes_private', 'read', nodeSourceId)
        : user.isAdmin === true;
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
  //
  // Presence check, not truthiness: a latitude or longitude of exactly 0 is a
  // real coordinate (the equator / the prime meridian), and the old truthy test
  // treated such a node as unpositioned, overwriting its genuine fix with an
  // estimate (#4432 follow-up).
  //
  // Null Island — where BOTH are ~0 — is explicitly rejected rather than left to
  // upstream filtering. It is already filtered at ingest and by migration 107,
  // but making the gate independently correct matters: a bare presence check
  // would accept a stray (0, 0) and render it as a GPS fix, which is worse than
  // the behaviour this change replaces. Falling through lets an estimate take
  // over, correctly labelled.
  const pos = node.position;
  if (pos?.latitude != null && pos?.longitude != null && !isBogusPosition(pos.latitude, pos.longitude)) {
    return enhancedNode;
  }

  // Priority 3: Use estimated position if available.
  //
  // This is a trilaterated guess, not a device GPS fix, so flag it — otherwise
  // it is indistinguishable from a real position by the time any screen reads
  // `node.position` (#4432). Priority 1 (override) returns above, so a
  // user-placed node can never be labelled estimated.
  const estimatedPos = estimatedPositions?.get(node.user.id);

  if (estimatedPos) {
    enhancedNode.position = {
      latitude: estimatedPos.latitude,
      longitude: estimatedPos.longitude,
      altitude: node.position?.altitude,
    };
    enhancedNode.positionIsEstimated = true;
    if (estimatedPos.uncertaintyKm != null) {
      enhancedNode.positionEstimateUncertaintyKm = estimatedPos.uncertaintyKm;
    }
    return enhancedNode;
  }

  return enhancedNode;
}

/**
 * Who may see which node rows, decided per row from the row's OWN source.
 *
 * `filterNodesByChannelPermission(nodes, user)` with no source merges the
 * caller's channel grants across every source, so `channel_0:viewOnMap` on
 * source A showed channel-0 nodes from source B. Reads that return rows from
 * several sources use this instead: one load, then a pure check per row.
 */
export interface NodeViewAccess {
  readonly isAdmin: boolean;
  /** The grants this was built from, for a per-source check on another resource. */
  readonly permissions: SourcePermissions;
  /** May the caller see a node last heard on `channel` of `sourceId`? */
  canViewNode(sourceId: string | null | undefined, channel: number | null | undefined): boolean;
  /** May the caller see a private position override held on `sourceId`? */
  canViewPrivate(sourceId: string | null | undefined): boolean;
  /**
   * The sources worth querying: `'all'` for an admin, and for a caller with a
   * virtual-channel grant (those are global by design, so a row on any source
   * can match). Otherwise the sources where the caller holds `viewOnMap` on
   * some device channel. `canViewNode` still decides each row.
   */
  readonly sources: 'all' | string[];
}

const DEVICE_CHANNEL_RESOURCES: ResourceType[] = [0, 1, 2, 3, 4, 5, 6, 7].map(
  (n) => `channel_${n}` as ResourceType,
);

export async function loadNodeViewAccess(user: User | null | undefined): Promise<NodeViewAccess> {
  if (user?.isAdmin) {
    // Everything, on every source.
    const permissions = await loadSourcePermissions(user);
    return { isAdmin: true, permissions, canViewNode: () => true, canViewPrivate: () => true, sources: 'all' };
  }
  if (!user) {
    // No user at all: nothing, on any source.
    const permissions = await loadSourcePermissions(null);
    return { isAdmin: false, permissions, canViewNode: () => false, canViewPrivate: () => false, sources: [] };
  }
  const [permissions, channelDbPermissions] = await Promise.all([
    loadSourcePermissions(user),
    // Global by design: see filterNodesByChannelPermission below.
    databaseService.getChannelDatabasePermissionsForUserAsSetAsync(user.id),
  ]);
  const hasVirtualGrant = Object.values(channelDbPermissions).some((grant) => grant?.viewOnMap === true);
  return {
    isAdmin: false,
    permissions,
    canViewNode(sourceId, channel) {
      const channelNum = channel ?? 0;
      if (channelNum >= CHANNEL_DB_OFFSET) {
        return channelDbPermissions[channelNum - CHANNEL_DB_OFFSET]?.viewOnMap === true;
      }
      if (!sourceId) return false;
      return permissions.can(`channel_${channelNum}` as ResourceType, 'viewOnMap', sourceId);
    },
    canViewPrivate: (sourceId) => (sourceId ? permissions.can('nodes_private', 'read', sourceId) : false),
    sources: hasVirtualGrant
      ? 'all'
      : permissions.sourcesWhere((grants) => DEVICE_CHANNEL_RESOURCES.some((r) => grants[r]?.viewOnMap === true)),
  };
}

/**
 * Filter nodes based on channel viewOnMap permissions.
 * A user can only see nodes on the map that were last heard on a channel they have viewOnMap permission for.
 * Admins see all nodes.
 *
 * For device channels (0-7), uses the regular permission system.
 * For virtual channels (>= CHANNEL_DB_OFFSET), uses channel database permissions.
 *
 *
 * Pass `sourceId` whenever the rows come from one source. With no `sourceId`
 * the caller's grants are merged across EVERY source, so a grant on source A
 * passes a row of source B. A read that returns rows from several sources
 * must check each row on its own source instead: see `loadNodeViewAccess`.
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

  // Get user's virtual channel (channel database) permissions.
  // NOT source-scoped by design: the channel_database (server-side decryption
  // PSKs) is global — channelDecryptionService tries every enabled row
  // regardless of source, and migration 063 dropped its dead sourceId column.
  // So virtual-channel (>= CHANNEL_DB_OFFSET) permissions are global too.
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
 *
 * Pass `sourceId` whenever the rows come from one source. With no `sourceId`
 * the caller's grants are merged across EVERY source, so a grant on source A
 * passes a row of source B. A read that returns rows from several sources
 * must check each row on its own source instead: see `loadNodeViewAccess`.
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

  // Get user's virtual channel (channel database) permissions.
  // NOT source-scoped by design: the channel_database (server-side decryption
  // PSKs) is global — channelDecryptionService tries every enabled row
  // regardless of source, and migration 063 dropped its dead sourceId column.
  // So virtual-channel (>= CHANNEL_DB_OFFSET) permissions are global too.
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
    return stripNodeLocation(node);
  });
}

/** A copy of a node row without the position it reported. */
function stripNodeLocation<T>(node: T): T {
  const masked = { ...node } as Record<string, unknown>;
  delete masked.latitude;
  delete masked.longitude;
  delete masked.altitude;
  delete masked.positionChannel;
  delete masked.positionTimestamp;
  delete masked.positionPrecisionBits;
  delete masked.positionGpsAccuracy;
  delete masked.positionHdop;
  // #5364/#5365 Phase 2: the "confirmed fixed" anchor is a position too.
  delete masked.aircraftFixedLatitude;
  delete masked.aircraftFixedLongitude;
  return masked as T;
}

/**
 * One source's raw node rows as a caller may see them, from grants already
 * loaded for the request (`loadNodeViewAccess`): no query here.
 *
 *  - a row is dropped unless the caller holds `viewOnMap` on the channel the
 *    node was last heard on, on this source;
 *  - the reported position is removed when it arrived on a channel the caller
 *    cannot view on this source (`maskNodeLocationByChannel`'s rule);
 *  - a PRIVATE position override's coordinates are removed unless the caller
 *    holds `nodes_private:read` on this source. The flags stay, as they do in
 *    `enhanceNodeForClient`.
 *
 * Admins get the rows back untouched.
 */
export function scopeNodeRowsForViewer<T>(nodes: T[], access: NodeViewAccess, sourceId: string): T[] {
  if (access.isAdmin) return nodes;
  const canViewPrivate = access.canViewPrivate(sourceId);
  const out: T[] = [];
  for (const node of nodes) {
    const row = node as {
      channel?: number | null;
      positionChannel?: number | null;
      positionOverrideIsPrivate?: boolean | number | null;
    };
    if (!access.canViewNode(sourceId, row.channel)) continue;
    let shown = node;
    if (row.positionChannel != null && !access.canViewNode(sourceId, row.positionChannel)) {
      shown = stripNodeLocation(shown);
    }
    if (row.positionOverrideIsPrivate && !canViewPrivate) {
      shown = withholdPrivateOverride(shown);
    }
    out.push(shown);
  }
  return out;
}

/** A copy of a node row without its position-override coordinates. */
export function withholdPrivateOverride<T>(node: T): T {
  const masked = { ...node } as Record<string, unknown>;
  delete masked.latitudeOverride;
  delete masked.longitudeOverride;
  delete masked.altitudeOverride;
  return masked as T;
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

  // MeshCore node identifiers are 64-char hex public keys. They have no
  // channel, so the Meshtastic per-channel rule does not apply. The grant is
  // `nodes:viewOnMap` on the source named, the one the MeshCore position and
  // telemetry reads use (#4559, `resolveNodePositionScope`). This used to
  // pass for any signed-in user, on any source. With no source named there is
  // no source to check the grant on, so the answer is no.
  if (/^[0-9a-fA-F]{64}$/.test(nodeId)) {
    if (!user || !sourceId) return false;
    return hasPermission(user, 'nodes', 'viewOnMap', sourceId);
  }

  // Support both hex nodeId (!abcdef01) and decimal nodeId (2882400001)
  const nodeNum = nodeId.startsWith('!')
    ? parseInt(nodeId.replace('!', ''), 16)
    : parseInt(nodeId, 10);
  // Scope the node lookup to the requesting source — the same nodeNum can
  // exist in multiple sources with different channel assignments, and the
  // channel drives this permission check (#3745).
  const node = await databaseService.nodes.getNode(nodeNum, sourceId);
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

/** Which sources a position read for one node may draw on. */
export type NodePositionScope =
  | { allowed: false }
  /** `sources` is one source, a list (possibly empty: nothing to show), or every source (admin). */
  | { allowed: true; sources: typeof ALL_SOURCES | string | string[] };

/**
 * Decide which sources' position rows a caller may read for one node.
 *
 * Position telemetry is stored per source. A read keyed only by node id
 * returns every source's fixes, so the permission has to become a source
 * filter on the query, not only a yes/no at the door:
 *
 *  - Admin: the named source, or every source.
 *  - Source named: the caller needs `viewOnMap` on the channel the node was
 *    last heard on IN THAT SOURCE (channel 0 when the source has no row for
 *    it, as `checkNodeChannelAccess` does). A node whose position is private
 *    in that source yields no rows unless the caller holds `nodes_private:read`
 *    there.
 *  - None named: the same two rules applied to each source that holds the
 *    node. Refused when no source passes the channel rule.
 *  - MeshCore ids (64-hex public keys) have no channel: `nodes:viewOnMap` on
 *    the source, the gate the MeshCore position reads use (#4559).
 */
export async function resolveNodePositionScope(
  nodeId: string,
  user: User | null | undefined,
  sourceId?: string,
): Promise<NodePositionScope> {
  const named = sourceId || undefined;
  if (user?.isAdmin) return { allowed: true, sources: named ?? ALL_SOURCES };
  if (!user) return { allowed: false };

  if (/^[0-9a-fA-F]{64}$/.test(nodeId)) {
    const permissions = await loadSourcePermissions(user);
    if (named) {
      return permissions.can('nodes', 'viewOnMap', named) ? { allowed: true, sources: named } : { allowed: false };
    }
    const sources = permissions.sourcesWhere((grants) => grants.nodes?.viewOnMap === true);
    return sources.length > 0 ? { allowed: true, sources } : { allowed: false };
  }

  const nodeNum = nodeId.startsWith('!') ? parseInt(nodeId.replace('!', ''), 16) : parseInt(nodeId, 10);
  const access = await loadNodeViewAccess(user);

  if (named) {
    const node = await databaseService.nodes.getNode(nodeNum, named);
    if (!access.canViewNode(named, node?.channel ?? 0)) return { allowed: false };
    if (node?.positionOverrideIsPrivate && !access.canViewPrivate(named)) return { allowed: true, sources: [] };
    return { allowed: true, sources: named };
  }

  const rows = await databaseService.nodes.getNodeVisibilityAcrossSources(nodeNum);
  const visible = rows.filter((row) => access.canViewNode(row.sourceId, row.channel));
  if (visible.length === 0) return { allowed: false };
  return {
    allowed: true,
    sources: visible
      .filter((row) => !row.positionOverrideIsPrivate || access.canViewPrivate(row.sourceId))
      .map((row) => row.sourceId),
  };
}

/**
 * Attach latest device uptime onto client node objects for the node list's
 * "Sort: Uptime" option (#4814). Uptime is not a node column — it lives only in
 * device-metrics telemetry — so the route fetches one grouped map keyed by node
 * id and this attaches it. Nodes without a reported uptime are left untouched
 * (undefined), so the sort pushes them to the bottom. Mutates `nodes` in place.
 */
export function attachUptimeToNodes<T extends { user?: { id?: string }; uptimeSeconds?: number }>(
  nodes: T[],
  uptimeMap: Map<string, number>,
): void {
  for (const node of nodes) {
    const id = node.user?.id;
    const uptime = id ? uptimeMap.get(id) : undefined;
    if (uptime !== undefined) node.uptimeSeconds = uptime;
  }
}
