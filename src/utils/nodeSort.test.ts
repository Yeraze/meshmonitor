import { describe, it, expect, vi } from 'vitest';
import { sortNodesByField } from './nodeSort';
import type { DeviceInfo } from '../types/device';
import type { SortField, SortDirection } from '../types/ui';

// The comparator NodesTab used before keys were precomputed — kept here as the
// reference the new sort must match exactly.
function legacySort(nodes: DeviceInfo[], sortField: SortField, sortDirection: SortDirection, hopsOf: (n: DeviceInfo) => number) {
  return [...nodes].sort((a, b) => {
    let aVal: any, bVal: any;
    switch (sortField) {
      case 'longName': aVal = a.user?.longName || `Node ${a.nodeNum}`; bVal = b.user?.longName || `Node ${b.nodeNum}`; break;
      case 'shortName': aVal = a.user?.shortName || ''; bVal = b.user?.shortName || ''; break;
      case 'id': aVal = a.user?.id || a.nodeNum; bVal = b.user?.id || b.nodeNum; break;
      case 'lastHeard': aVal = a.lastHeard || 0; bVal = b.lastHeard || 0; break;
      case 'snr': aVal = a.snr ?? -999; bVal = b.snr ?? -999; break;
      case 'battery': aVal = a.deviceMetrics?.batteryLevel ?? -1; bVal = b.deviceMetrics?.batteryLevel ?? -1; break;
      case 'uptime': aVal = a.uptimeSeconds ?? a.deviceMetrics?.uptimeSeconds ?? -1; bVal = b.uptimeSeconds ?? b.deviceMetrics?.uptimeSeconds ?? -1; break;
      case 'hwModel': aVal = a.user?.hwModel ?? 0; bVal = b.user?.hwModel ?? 0; break;
      case 'hops': aVal = hopsOf(a); bVal = hopsOf(b); break;
      default: return 0;
    }
    const comparison = typeof aVal === 'string' && typeof bVal === 'string'
      ? aVal.localeCompare(bVal)
      : aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    return sortDirection === 'asc' ? comparison : -comparison;
  });
}

function makeNodes(n: number): DeviceInfo[] {
  const names = ['alpha', 'Bravo', 'charlie', 'Älpha', 'delta', '', 'echo', 'bravo'];
  const nodes: DeviceInfo[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      nodeNum: 1000 + ((i * 7919) % 97),
      lastHeard: i % 5 === 0 ? undefined : (i * 37) % 11,
      snr: i % 4 === 0 ? undefined : ((i * 13) % 9) - 4,
      hopsAway: i % 3,
      uptimeSeconds: i % 6 === 0 ? undefined : (i * 101) % 7,
      deviceMetrics: { batteryLevel: i % 3 === 0 ? undefined : (i * 17) % 5, uptimeSeconds: (i * 3) % 4 },
      user: i % 9 === 0 ? undefined : {
        id: i % 10 === 0 ? '' : `!${(i * 31 % 50).toString(16).padStart(8, '0')}`,
        longName: names[i % names.length],
        shortName: names[(i + 3) % names.length].slice(0, 4),
        hwModel: (i * 5) % 4,
      },
    } as unknown as DeviceInfo);
  }
  return nodes;
}

const FIELDS: SortField[] = ['longName', 'shortName', 'id', 'lastHeard', 'snr', 'battery', 'uptime', 'hwModel', 'hops'];

describe('sortNodesByField', () => {
  const nodes = makeNodes(120);
  const hopsOf = (n: DeviceInfo) => (n.hopsAway ?? 999);

  for (const field of FIELDS) {
    for (const dir of ['asc', 'desc'] as SortDirection[]) {
      it(`matches the legacy comparator for ${field} ${dir} (including tie order)`, () => {
        expect(sortNodesByField(nodes, field, dir, hopsOf)).toEqual(legacySort(nodes, field, dir, hopsOf));
      });
    }
  }

  it('computes the hops key once per node, not per comparison', () => {
    const spy = vi.fn(hopsOf);
    sortNodesByField(nodes, 'hops', 'asc', spy);
    expect(spy).toHaveBeenCalledTimes(nodes.length);
  });

  it('does not call hopsOf for other fields', () => {
    const spy = vi.fn(hopsOf);
    sortNodesByField(nodes, 'longName', 'asc', spy);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps input order for an unknown field and never mutates the input', () => {
    const copy = [...nodes];
    const out = sortNodesByField(nodes, 'nope' as SortField, 'asc', hopsOf);
    expect(out).toEqual(copy);
    expect(out).not.toBe(nodes);
    sortNodesByField(nodes, 'snr', 'desc', hopsOf);
    expect(nodes).toEqual(copy);
  });

  it('handles empty and single-node lists', () => {
    expect(sortNodesByField([], 'snr', 'asc', hopsOf)).toEqual([]);
    expect(sortNodesByField(nodes.slice(0, 1), 'snr', 'asc', hopsOf)).toEqual(nodes.slice(0, 1));
  });
});
