/**
 * One node's effective position as one viewer may see it (#6523).
 *
 * The single home of the map position gate for per-node reads that leak
 * location (the solar cell, the node's timezone): load the node — Meshtastic
 * by `!hex`, MeshCore by 64-hex public key — and apply `buildPositionFilter` /
 * `buildMeshCorePositionFilter`. `hideFromMap` is dropped for Meshtastic: it
 * only removes the map marker, while the node's telemetry graphs (where these
 * reads are shown) still appear.
 */
import databaseService from '../../services/database.js';
import { buildPositionFilter, buildMeshCorePositionFilter } from './positionVisibility.js';
import type { SourcePermissions } from './sourcePermissions.js';
import { checkNodeChannelAccess } from './nodeEnhancer.js';
import { hasPermission } from '../auth/authMiddleware.js';
import { isValidNodeNum } from '../constants/meshtastic.js';
import { solarPosition } from '../services/openMeteoSolarService.js';
import type { User } from '../../types/auth.js';

const MESHCORE_KEY = /^[0-9a-fA-F]{64}$/;

export interface VisibleNode {
  /** The node's stored Timezone Override (#6523), or null. */
  timezoneOverride: string | null;
  /** Effective position (override, else sign-corrected GPS), or null when it has none. */
  position: { latitude: number; longitude: number } | null;
}

/** True when `nodeId` names a MeshCore node (64-hex public key). */
export function isMeshCoreNodeId(nodeId: string): boolean {
  return MESHCORE_KEY.test(nodeId);
}

/**
 * The node, if it exists and the viewer passes its position gate; else null.
 * A node with no position still passes when the gate allows it, with
 * `position: null`.
 */
export async function resolveVisibleNode(
  user: User | null | undefined,
  sourceId: string,
  nodeId: string,
  permissions?: SourcePermissions,
): Promise<VisibleNode | null> {
  if (isMeshCoreNodeId(nodeId)) {
    const publicKey = nodeId.toLowerCase();
    const node = await databaseService.meshcore.getNodeByPublicKeyAndSource(publicKey, sourceId);
    if (!node) return null;
    const visible = await buildMeshCorePositionFilter(user ?? null, [sourceId], new Map([[sourceId, [node]]]), permissions);
    if (!visible({ sourceId, publicKey })) return null;
    return { timezoneOverride: node.timezoneOverride ?? null, position: await solarPosition(node, sourceId) };
  }
  const nodeNum = parseInt(nodeId.replace('!', ''), 16);
  if (!isValidNodeNum(nodeNum)) return null;
  const node = await databaseService.nodes.getNode(nodeNum, sourceId);
  if (!node) return null;
  const visible = await buildPositionFilter(user ?? null, [sourceId], new Map([[sourceId, [{ ...node, hideFromMap: false }]]]), permissions);
  if (!visible({ sourceId, nodeNum })) return null;
  return { timezoneOverride: node.timezoneOverride ?? null, position: await solarPosition(node, sourceId) };
}

/** The node's effective position if this viewer may see it, else null. */
export async function resolveVisibleNodePosition(
  user: User | null | undefined,
  sourceId: string,
  nodeId: string,
  permissions?: SourcePermissions,
): Promise<{ latitude: number; longitude: number } | null> {
  return (await resolveVisibleNode(user, sourceId, nodeId, permissions))?.position ?? null;
}

/** The role half of the node telemetry-graph read gate: admin, info read or dashboard read. */
export async function hasTelemetryReadRole(user: User | null | undefined): Promise<boolean> {
  if (user?.isAdmin) return true;
  if (!user) return false;
  return (await hasPermission(user, 'info', 'read')) || (await hasPermission(user, 'dashboard', 'read'));
}

/**
 * The node telemetry-graph read gate: {@link hasTelemetryReadRole} plus
 * channel access to the node on this source.
 */
export async function canReadNodeTelemetry(
  user: User | null | undefined,
  sourceId: string,
  nodeId: string,
): Promise<boolean> {
  return (await hasTelemetryReadRole(user)) && checkNodeChannelAccess(nodeId, user, sourceId);
}
