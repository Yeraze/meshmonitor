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
import { checkNodeChannelAccess } from './nodeEnhancer.js';
import { loadSourcePermissions, type SourcePermissions } from './sourcePermissions.js';
import { cellFor, loadSolarSettings } from '../services/openMeteoSolarService.js';
import { hasTelemetryReadRole, resolveVisibleNodePosition } from './nodeVisiblePosition.js';
import type { SolarIrradianceRow } from '../../db/repositories/index.js';
import type { User } from '../../types/auth.js';

export async function resolveNodeSolarCell(
  user: User | null | undefined,
  sourceId: string,
  nodeId: string,
  gridSize: number,
  permissions?: SourcePermissions,
): Promise<string | null> {
  const pos = await resolveVisibleNodePosition(user, sourceId, nodeId, permissions);
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
  if (!await hasTelemetryReadRole(user)) {
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

  // The caller's grants, read once for every node instead of once per lookup.
  const permissions = await loadSourcePermissions(user?.id != null ? user : null);
  const byCell = new Map<string, Promise<SolarIrradianceRow[]>>();
  for (const [nodeNum, refs] of refsByNode) {
    let cellKey: string | null = null;
    for (const ref of refs) {
      cellKey = await resolveNodeSolarCell(user, ref.sourceId, ref.nodeId, settings.gridSize, permissions);
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
