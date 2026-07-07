/**
 * Resolve each source's own (local) node position from a node list.
 *
 * The polar grid overlay (#2307, #3971) is centered on the local node. On the
 * per-source NodesTab map the local node is known from the device config
 * (`currentNodeId`), but the Map Analysis and Unified/Dashboard maps aggregate
 * several sources at once and have no single "current node". Instead we pair
 * each source's local `nodeNum` (surfaced by `GET /api/sources/:id/status` via
 * the manager's `getStatus()`) with that node's position from the shared node
 * list. `nodeNum` is globally unique per physical node, so a single position
 * lookup table resolves every source's own node.
 *
 * MeshCore sources carry no meshtastic `nodeNum` (their status omits it), so
 * they naturally yield no entry here and the grid is disabled for them —
 * matching the issue's "disabled when the source has no own-node position".
 */
import { isNullIsland } from './nullIsland';

export interface OwnNodePosition {
  sourceId: string;
  lat: number;
  lng: number;
}

/** A node record carrying a nodeNum and either flat or nested lat/lng. */
interface PositionedNode {
  nodeNum?: number | string | null;
  latitude?: number | null;
  longitude?: number | null;
  position?: { latitude?: number | null; longitude?: number | null } | null;
}

function resolveLatLng(node: PositionedNode): { lat: number; lng: number } | null {
  const lat = node?.latitude ?? node?.position?.latitude;
  const lng = node?.longitude ?? node?.position?.longitude;
  if (lat == null || lng == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (isNullIsland(lat, lng)) return null;
  return { lat, lng };
}

/**
 * Build the list of own-node positions for the given sources.
 *
 * @param nodes                 node records (flat or nested position; carry nodeNum)
 * @param localNodeNumBySource  sourceId → local nodeNum (from source status;
 *                              null/undefined when the source has no known local node)
 */
export function getOwnNodePositions(
  nodes: PositionedNode[],
  localNodeNumBySource: Map<string, number | null | undefined>,
): OwnNodePosition[] {
  // Index the newest resolvable position per nodeNum. Callers pass merged/unified
  // nodes (one record per nodeNum), so first-wins is sufficient and cheap.
  const posByNodeNum = new Map<number, { lat: number; lng: number }>();
  for (const n of nodes ?? []) {
    const num = typeof n?.nodeNum === 'number' ? n.nodeNum : Number(n?.nodeNum);
    if (!Number.isFinite(num)) continue;
    if (posByNodeNum.has(num)) continue;
    const pos = resolveLatLng(n);
    if (pos) posByNodeNum.set(num, pos);
  }

  const out: OwnNodePosition[] = [];
  for (const [sourceId, localNum] of localNodeNumBySource) {
    if (localNum == null) continue;
    const num = Number(localNum);
    if (!Number.isFinite(num)) continue;
    const pos = posByNodeNum.get(num);
    if (pos) out.push({ sourceId, lat: pos.lat, lng: pos.lng });
  }
  return out;
}
