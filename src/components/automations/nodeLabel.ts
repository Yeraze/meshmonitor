/**
 * Pure label helper for the node multi-picker (kept out of the component file so
 * the `.tsx` exports only a component — react-refresh/only-export-components).
 */
import type { NodeMultiOption } from './NodeMultiFieldInput';

/** Primary human label: long name → short name → node id → decimal nodeNum. */
export function labelOf(n: NodeMultiOption): string {
  const long = (n.longName || '').trim();
  const short = (n.shortName || '').trim();
  if (long) return long;
  if (short) return short;
  if (n.nodeId) return n.nodeId;
  return `!${(Number(n.nodeNum) >>> 0).toString(16).padStart(8, '0')}`;
}
