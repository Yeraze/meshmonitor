import type { DeviceInfo } from '../types/device.js';
import type { SortField, SortDirection } from '../types/ui.js';

export type SortKey = string | number;

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
 * Generic stable sort by a computed key, returning a new array. Each key is
 * computed once (decorate-sort-undecorate). If the first item's key is
 * undefined the input order is returned unchanged.
 */
export function sortByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => SortKey | undefined,
  direction: SortDirection
): T[] {
  if (items.length < 2) return [...items];
  const first = keyOf(items[0]);
  // An unknown field yields no key for any item: keep input order (as before).
  if (first === undefined) return [...items];
  const keyed = items.map((item, i) => ({ item, key: i === 0 ? first : keyOf(item) }));
  const sign = direction === 'asc' ? 1 : -1;
  // A missing key always sorts last, whatever the direction (stable among themselves).
  keyed.sort((x, y) => {
    if (x.key === undefined || y.key === undefined) {
      return x.key === undefined ? (y.key === undefined ? 0 : 1) : -1;
    }
    return sign * compareKeys(x.key, y.key);
  });
  return keyed.map((k) => k.item);
}

/**
 * Favorites first, each partition ordered by `sort`. Shared by the Meshtastic
 * and MeshCore node lists.
 */
export function orderFavoritesFirst<T extends { isFavorite?: boolean }>(
  items: readonly T[],
  sort: (xs: T[]) => T[]
): T[] {
  const favs: T[] = [];
  const rest: T[] = [];
  for (const item of items) (item.isFavorite ? favs : rest).push(item);
  return [...sort(favs), ...sort(rest)];
}

/**
 * Sort nodes by `field`, returning a new array. Stable: equal keys keep
 * their input order. An unknown field returns the input order unchanged.
 */
export function sortNodesByField(
  nodes: readonly DeviceInfo[],
  field: SortField,
  direction: SortDirection,
  hopsOf: (node: DeviceInfo) => number
): DeviceInfo[] {
  return sortByKey(nodes, (node) => nodeSortKey(node, field, hopsOf), direction);
}
