/**
 * Canonical cross-source node identity helpers (issue #3788, Phase 1 WP-A).
 *
 * `unifiedNodeKey` is the single source of truth for how a physical node is
 * keyed across Meshtastic and MeshCore sources. It MUST match the bucketing
 * logic in `mergeUnifiedSourceData` (src/hooks/useDashboardData.ts) — that
 * function calls this helper directly so the two can never drift.
 */
export interface IdentifiableNode {
  /**
   * Accepts a string as well as a number: `nodeNum` is BIGINT on
   * PostgreSQL/MySQL and can reach the client as a numeric string. Treating
   * that as "no identity" used to drop the node from the unified view
   * entirely (#4573).
   */
  nodeNum?: number | string | null;
  isMeshCore?: boolean | null;
  publicKey?: string | null;
  nodeId?: string | null;
}

/** Coerce a `nodeNum` that may arrive as a BIGINT string. `0` is a real value. */
function toNodeNum(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Recover a nodeNum from the `!aabbccdd` hex form when the numeric field is unusable. */
function nodeNumFromNodeId(nodeId: unknown): number | null {
  if (typeof nodeId !== 'string' || !/^![0-9a-fA-F]+$/.test(nodeId)) return null;
  const n = parseInt(nodeId.slice(1), 16);
  return Number.isFinite(n) ? n : null;
}

/**
 * Canonical cross-source node key — MUST match mergeUnifiedSourceData's keying.
 *
 * Returns null only when a node carries no usable identity at all. That case
 * makes a node invisible in the unified view, so the fallbacks below matter:
 * every `null` is a node the per-source view shows and the unified view does
 * not, which is exactly the undercount reported in #4573.
 */
export function unifiedNodeKey(n: IdentifiableNode): string | null {
  if (n.isMeshCore) {
    if (typeof n.publicKey === 'string' && n.publicKey.length > 0) return `mc:${n.publicKey}`;
    if (typeof n.nodeId === 'string' && n.nodeId.length > 0) return `mc:${n.nodeId}`;
    return null;
  }
  // Prefer the numeric identity so a node reported with a numeric `nodeNum` by
  // one source and a hex `nodeId` by another lands in ONE bucket rather than
  // two — keying the fallback on the raw nodeId string would split it.
  const num = toNodeNum(n.nodeNum) ?? nodeNumFromNodeId(n.nodeId);
  if (num !== null) return `mt:${num}`;
  // Last resort: any stable string identity beats dropping the node.
  if (typeof n.nodeId === 'string' && n.nodeId.length > 0) return `mt:${n.nodeId}`;
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
