/**
 * Resolve the solar grid cell for one node, as seen by one viewer (#6523).
 *
 * The cell (and the sunlight curve read from it) gives away the node's rough
 * location — sunrise time alone pins longitude — so this applies the same
 * position visibility gate as the map: a viewer who cannot see the node's
 * position gets `null`. The position is always resolved server-side; callers
 * never pass coordinates in and never return the cell key out.
 */
import databaseService from '../../services/database.js';
import { buildPositionFilter, buildMeshCorePositionFilter } from './positionVisibility.js';
import { checkNodeChannelAccess } from './nodeEnhancer.js';
import { hasPermission } from '../auth/authMiddleware.js';
import { isValidNodeNum } from '../constants/meshtastic.js';
import { cellFor, loadSolarSettings, solarPosition } from '../services/openMeteoSolarService.js';
import type { SolarIrradianceRow } from '../../db/repositories/index.js';
import type { User } from '../../types/auth.js';

const MESHCORE_KEY = /^[0-9a-fA-F]{64}$/;

export async function resolveNodeSolarCell(
  user: User | null | undefined,
  sourceId: string,
  nodeId: string,
  gridSize: number,
): Promise<string | null> {
  let pos: { latitude: number; longitude: number } | null;

  if (MESHCORE_KEY.test(nodeId)) {
    const publicKey = nodeId.toLowerCase();
    const node = await databaseService.meshcore.getNodeByPublicKeyAndSource(publicKey, sourceId);
    if (!node) return null;
    const visible = await buildMeshCorePositionFilter(user ?? null, [sourceId], new Map([[sourceId, [node]]]));
    if (!visible({ sourceId, publicKey })) return null;
    pos = await solarPosition(node, sourceId);
  } else {
    const nodeNum = parseInt(nodeId.replace('!', ''), 16);
    if (!isValidNodeNum(nodeNum)) return null;
    const node = await databaseService.nodes.getNode(nodeNum, sourceId);
    if (!node) return null;
    // `hideFromMap` only removes the map marker; the node's telemetry graphs
    // (where this curve is drawn) still show, so drop that display gate here.
    const visible = await buildPositionFilter(user ?? null, [sourceId], new Map([[sourceId, [{ ...node, hideFromMap: false }]]]));
    if (!visible({ sourceId, nodeNum })) return null;
    pos = await solarPosition(node, sourceId);
  }

  return pos ? cellFor(pos.latitude, pos.longitude, gridSize).key : null;
}

export type NodeIrradianceResult =
  | { status: 200; enabled: boolean; points: SolarIrradianceRow[] }
  | { status: 400 | 403; message: string };

/** Longest window one request may cover (31 days). */
const MAX_RANGE_S = 31 * 86_400;

/**
 * Shared read for `/api/solar/irradiance` and `/api/v1/sources/:sourceId/solar`: the node's
 * telemetry-graph read gate (info or dashboard read, plus channel access on
 * the source), then the position gate in `resolveNodeSolarCell`.
 */
export async function getNodeIrradiance(
  user: User | null | undefined,
  sourceId: string,
  nodeId: string,
  start: number,
  end: number,
): Promise<NodeIrradianceResult> {
  if (
    !user?.isAdmin &&
    !(user ? await hasPermission(user, 'info', 'read') : false) &&
    !(user ? await hasPermission(user, 'dashboard', 'read') : false)
  ) {
    return { status: 403, message: 'Insufficient permissions' };
  }
  if (!nodeId) return { status: 400, message: 'nodeId is required' };
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || end - start > MAX_RANGE_S) {
    return { status: 400, message: 'start/end must be Unix seconds, start <= end, at most 31 days apart' };
  }
  if (!await checkNodeChannelAccess(nodeId, user, sourceId)) {
    return { status: 403, message: 'Insufficient permissions' };
  }
  const settings = await loadSolarSettings();
  if (!settings.enabled) return { status: 200, enabled: false, points: [] };
  const cellKey = await resolveNodeSolarCell(user, sourceId, nodeId, settings.gridSize);
  const points = cellKey ? await databaseService.solarIrradiance.getCellRange(cellKey, start, end) : [];
  return { status: 200, enabled: true, points };
}

/** A place a node can be read from: a source plus its `!hex` or public key. */
export interface SolarNodeRef {
  sourceId: string;
  nodeId: string;
}

/**
 * Hourly sunlight series for many nodes at once, for the Analysis solar
 * report (#6523). Each node's candidates are tried in order until one gives a
 * visible position (the same gate as `resolveNodeSolarCell`); a node with no
 * visible position, or Solar Monitoring off, is simply absent from the map.
 * Cells shared by several nodes are read once.
 */
export async function getSolarSeriesForNodes(
  user: User | null | undefined,
  refsByNode: Map<number, SolarNodeRef[]>,
  start: number,
  end: number,
): Promise<Map<number, SolarIrradianceRow[]>> {
  const out = new Map<number, SolarIrradianceRow[]>();
  if (refsByNode.size === 0) return out;
  const settings = await loadSolarSettings();
  if (!settings.enabled) return out;

  const byCell = new Map<string, Promise<SolarIrradianceRow[]>>();
  for (const [nodeNum, refs] of refsByNode) {
    let cellKey: string | null = null;
    for (const ref of refs) {
      cellKey = await resolveNodeSolarCell(user, ref.sourceId, ref.nodeId, settings.gridSize);
      if (cellKey) break;
    }
    if (!cellKey) continue;
    let rows = byCell.get(cellKey);
    if (!rows) {
      rows = databaseService.solarIrradiance.getCellRange(cellKey, start, end);
      byCell.set(cellKey, rows);
    }
    out.set(nodeNum, await rows);
  }
  return out;
}
