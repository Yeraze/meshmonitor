/**
 * Canonical cross-source node identity helpers (issue #3788, Phase 1 WP-A).
 *
 * `unifiedNodeKey` is the single source of truth for how a physical node is
 * keyed across Meshtastic and MeshCore sources. It MUST match the bucketing
 * logic in `mergeUnifiedSourceData` (src/hooks/useDashboardData.ts) — that
 * function calls this helper directly so the two can never drift.
 */
export interface IdentifiableNode {
  nodeNum?: number | null;
  isMeshCore?: boolean | null;
  publicKey?: string | null;
  nodeId?: string | null;
}

/** Canonical cross-source node key — MUST match mergeUnifiedSourceData's keying. */
export function unifiedNodeKey(n: IdentifiableNode): string | null {
  if (n.isMeshCore) {
    if (typeof n.publicKey === 'string' && n.publicKey.length > 0) return `mc:${n.publicKey}`;
    if (typeof n.nodeId === 'string' && n.nodeId.length > 0) return `mc:${n.nodeId}`;
    return null;
  }
  if (typeof n.nodeNum === 'number') return `mt:${n.nodeNum}`;
  return null;
}

/** Dim factor applied to unselected markers/trails when a selection is active. */
export const SELECTION_DIM_OPACITY = 0.3;

/** With an empty selection everything is full-emphasis; otherwise only members are. */
export function isNodeEmphasized(key: string | null, selectedNodeIds: readonly string[]): boolean {
  if (selectedNodeIds.length === 0) return true;
  return key != null && selectedNodeIds.includes(key);
}

/** Base opacity scaled down when the node is not emphasized. */
export function selectionOpacity(base: number, emphasized: boolean): number {
  return emphasized ? base : base * SELECTION_DIM_OPACITY;
}
