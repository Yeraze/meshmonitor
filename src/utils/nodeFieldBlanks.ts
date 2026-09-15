/**
 * Shared "is this NodeInfo value real data?" predicates (#5231).
 *
 * Two kinds of value look filled but carry no information:
 *
 * 1. **All-zero MAC addresses.** `User.macaddr` was deprecated in firmware
 *    2.1.x ("not populated by the phone"), so plenty of nodes broadcast six
 *    zero bytes. Hex-encoded that is `'000000000000'` — a non-empty string the
 *    nodes repository happily stores over a real MAC another source learned.
 * 2. **MeshMonitor's own derived name placeholders.** When a node is first seen
 *    as a traceroute hop or a neighbour entry we insert a stub row named
 *    `Node !aabbccdd` with short name `ccdd`. Those are non-empty strings too,
 *    so a "fill only what is blank" copy skips them forever and the unified map
 *    renders the hex stub even when another source knows the real name.
 *
 * Both server ingest/enrichment and the frontend's cross-source node merge need
 * the same answer, so the predicates live here rather than in either half.
 */

/** `!aabbccdd` → true. Anything else (including MeshCore `mc:…` ids) → false. */
function isHexNodeId(nodeId: string): boolean {
  return /^![0-9a-f]{8}$/i.test(nodeId);
}

/**
 * True for a macaddr that carries no information: absent, empty, or all zeros.
 *
 * Accepts the hex string form used in the `nodes` table as well as the raw
 * byte form seen at the protobuf boundary.
 */
export function isBlankMacAddr(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') {
    if (value === '') return true;
    return /^0+$/.test(value);
  }
  if (value instanceof Uint8Array || Array.isArray(value)) {
    const arr = value as ArrayLike<number>;
    if (arr.length === 0) return true;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] !== 0) return false;
    }
    return true;
  }
  return false;
}

/**
 * True for a longName that is MeshMonitor's own `Node !aabbccdd` stub rather
 * than a name the node broadcast.
 */
export function isPlaceholderLongName(value: unknown): boolean {
  return typeof value === 'string' && /^Node ![0-9a-f]{8}$/i.test(value);
}

/**
 * True for a shortName that is MeshMonitor's derived last-4-hex stub for this
 * node id. Needs the node id: `e848` is only a placeholder for `!9e80e848`.
 *
 * Note this also matches the firmware's own default short name, which is
 * derived the same way. That is harmless — a donor whose short name is the
 * same default reads as blank too, so no copy is offered.
 */
export function isPlaceholderShortName(value: unknown, nodeId?: string | null): boolean {
  if (typeof value !== 'string' || !nodeId || !isHexNodeId(nodeId)) return false;
  return value.toLowerCase() === nodeId.slice(-4).toLowerCase();
}
