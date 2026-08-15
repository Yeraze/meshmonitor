/**
 * Display name for a surveyed neighbour (#4726).
 *
 * Lives outside the component module so that file exports only its component —
 * react-refresh cannot fast-refresh a module that mixes the two.
 */
export interface NodeLabelLike {
  nodeNum: number;
  name: string | null;
}

/**
 * Falls back to the hex node id, matching how nodes are addressed elsewhere.
 *
 * Treats an empty/whitespace name as absent rather than rendering a blank
 * label. `??` alone would pass `''` straight through and produce a row with no
 * identifier in it.
 */
export function nodeLabel(n: NodeLabelLike): string {
  const name = n.name?.trim();
  return name || `!${n.nodeNum.toString(16).padStart(8, '0')}`;
}
