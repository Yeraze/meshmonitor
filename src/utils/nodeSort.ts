import type { DeviceInfo } from '../types/device.js';
import type { SortField, SortDirection } from '../types/ui.js';

type SortKey = string | number;

/**
 * The value a node sorts by for `field`. `hopsOf` is called only for the
 * `'hops'` field (it can be costly: in traceroute mode it scans and parses
 * every traceroute).
 */
export function nodeSortKey(
  node: DeviceInfo,
  field: SortField,
  hopsOf: (node: DeviceInfo) => number
): SortKey | undefined {
  switch (field) {
    case 'longName':
      return node.user?.longName || `Node ${node.nodeNum}`;
    case 'shortName':
      return node.user?.shortName || '';
    case 'id':
      return node.user?.id || node.nodeNum;
    case 'lastHeard':
      return node.lastHeard || 0;
    case 'snr':
      return node.snr ?? -999;
    case 'battery':
      return node.deviceMetrics?.batteryLevel ?? -1;
    case 'uptime':
      // Never-reported uptime sorts to the bottom. Top-level uptimeSeconds is
      // enriched by /api/nodes (#4814), with the device-metrics copy as fallback.
      return node.uptimeSeconds ?? node.deviceMetrics?.uptimeSeconds ?? -1;
    case 'hwModel':
      return node.user?.hwModel ?? 0;
    case 'hops':
      return hopsOf(node);
    default:
      return undefined;
  }
}

// Same ordering as String.prototype.localeCompare() with no arguments, but
// built once instead of per comparison.
const collator = new Intl.Collator();

function compareKeys(a: SortKey, b: SortKey): number {
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort nodes by `field`, returning a new array. Each node's key is computed
 * once (decorate-sort-undecorate) rather than twice per comparison, which
 * matters for the 'hops' key and for long lists. Stable: equal keys keep
 * their input order. An unknown field returns the input order unchanged.
 */
export function sortNodesByField(
  nodes: readonly DeviceInfo[],
  field: SortField,
  direction: SortDirection,
  hopsOf: (node: DeviceInfo) => number
): DeviceInfo[] {
  if (nodes.length < 2) return [...nodes];
  const first = nodeSortKey(nodes[0], field, hopsOf);
  if (first === undefined) return [...nodes];
  const keyed = nodes.map((node, i) => ({ node, key: i === 0 ? first : (nodeSortKey(node, field, hopsOf) as SortKey) }));
  const sign = direction === 'asc' ? 1 : -1;
  keyed.sort((x, y) => sign * compareKeys(x.key, y.key));
  return keyed.map((k) => k.node);
}
