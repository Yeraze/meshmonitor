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

/** Falls back to the hex node id, matching how nodes are addressed elsewhere. */
export function nodeLabel(n: NodeLabelLike): string {
  return n.name ?? `!${n.nodeNum.toString(16).padStart(8, '0')}`;
}
