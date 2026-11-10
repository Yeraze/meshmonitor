/**
 * Shared loader for the `nodeMulti` picker's node list. Used by the automation
 * editor (AutomationsPage) and the template gallery wizard (#6271) so both
 * list the same nodes.
 */
import apiService from '../../services/api';
import type { NodeMultiOption } from './NodeMultiFieldInput';

interface NodeRow {
  nodeNum: number;
  longName?: string;
  shortName?: string;
  nodeId?: string;
  mobile?: number;
  isMobile?: boolean;
  asset?: { retentionDays: number };
  user?: { id?: string; longName?: string; shortName?: string };
}

/** Resolves to [] on any failure — the picker just shows no nodes. */
export async function loadNodeOptions(): Promise<NodeMultiOption[]> {
  try {
    const list = await apiService.get<NodeRow[]>('/api/nodes');
    const rows = Array.isArray(list) ? list : [];
    return rows
      .filter((n) => {
        const num = Number(n.nodeNum);
        // Drop broadcast / unset MeshCore stubs from the hand-picker.
        return Number.isFinite(num) && num > 0 && num !== 0xffffffff;
      })
      .map((n) => {
        const nodeNum = Number(n.nodeNum);
        const nodeId = n.nodeId || n.user?.id || `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
        return {
          nodeNum,
          longName: n.longName || n.user?.longName,
          shortName: n.shortName || n.user?.shortName,
          nodeId,
          mobile: n.mobile,
          isMobile: n.isMobile,
          asset: n.asset,
        };
      });
  } catch {
    return [];
  }
}
