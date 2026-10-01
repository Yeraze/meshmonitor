/**
 * Node lookup for the Traceroute Explorer report (#5511).
 *
 * The report spans every source the caller can read, so one nodeNum can have
 * a row on several sources. This merges those rows into one display entry per
 * node: the newest-heard row supplies names, and the newest-heard row that
 * still carries a usable position supplies coordinates.
 *
 * Callers pass rows that are already permission-filtered and channel-masked
 * (see `tracerouteRoutes.ts`): a row whose position the caller may not see
 * must arrive here without `latitude`/`longitude`, and this function never
 * looks anywhere else for coordinates.
 */
import { isBogusPosition } from '../../utils/nullIsland.js';
import { getDisplayDbNodePosition, type SignFlipContext } from '../services/signFlipCorrection.js';

export interface ExplorerNodeRow {
  nodeNum: number;
  nodeId?: string | null;
  longName?: string | null;
  shortName?: string | null;
  hwModel?: number | null;
  role?: number | null;
  lastHeard?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  positionPrecisionBits?: number | null;
  positionOverrideEnabled?: boolean | number | null;
  latitudeOverride?: number | null;
  longitudeOverride?: number | null;
  altitudeOverride?: number | null;
  altitude?: number | null;
  sourceId: string;
}

export interface ExplorerNode {
  nodeNum: number;
  nodeId: string;
  shortName: string | null;
  longName: string | null;
  role: number | null;
  hwModel: number | null;
  latitude: number | null;
  longitude: number | null;
}

export function hexNodeId(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Merge per-source node rows into one entry per wanted nodeNum. Nodes with no
 * row at all still get an entry (hex id, no names, no position) so the client
 * can label every hop.
 */
export function mergeExplorerNodes(
  rows: ExplorerNodeRow[],
  wanted: Iterable<number>,
  signFlip: Map<string, SignFlipContext | null>,
): ExplorerNode[] {
  const byNum = new Map<number, ExplorerNodeRow[]>();
  for (const row of rows) {
    const num = Number(row.nodeNum);
    const list = byNum.get(num);
    if (list) list.push(row);
    else byNum.set(num, [row]);
  }

  const out: ExplorerNode[] = [];
  for (const nodeNum of new Set(wanted)) {
    const candidates = (byNum.get(nodeNum) ?? [])
      .slice()
      .sort((a, b) => (Number(b.lastHeard) || 0) - (Number(a.lastHeard) || 0));

    const named = candidates.find(r => r.longName || r.shortName) ?? candidates[0];

    let latitude: number | null = null;
    let longitude: number | null = null;
    for (const row of candidates) {
      const pos = getDisplayDbNodePosition(row, signFlip.get(row.sourceId) ?? null);
      if (pos.latitude == null || pos.longitude == null) continue;
      if (isBogusPosition(pos.latitude, pos.longitude, row.positionPrecisionBits)) continue;
      latitude = pos.latitude;
      longitude = pos.longitude;
      break;
    }

    out.push({
      nodeNum,
      nodeId: named?.nodeId || hexNodeId(nodeNum),
      shortName: named?.shortName ?? null,
      longName: named?.longName ?? null,
      role: named?.role ?? null,
      hwModel: named?.hwModel ?? null,
      latitude,
      longitude,
    });
  }
  return out;
}
