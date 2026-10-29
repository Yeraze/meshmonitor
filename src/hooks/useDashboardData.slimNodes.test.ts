/**
 * The dashboard bundles leave DASHBOARD_OMITTED_NODE_FIELDS out of each node.
 * The unified merge must give the same nodes without them: every field it
 * does output must match the merge of the full records.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { mergeUnifiedSourceData, type UnifiedSourceBundle } from './useDashboardData';
import { DASHBOARD_OMITTED_NODE_FIELDS } from '../utils/dashboardNodeFields';

vi.mock('../init', () => ({ appBasename: '/meshmonitor' }));

const now = Math.floor(Date.now() / 1000);

function strip<T extends Record<string, unknown>>(node: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node };
  for (const k of DASHBOARD_OMITTED_NODE_FIELDS) delete out[k];
  return out;
}

/** A full server row: every omitted field set, plus the fields the merge reads. */
function fullRow(nodeNum: number, sourceId: string, extra: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum}`,
    shortName: `N${nodeNum % 1000}`,
    hwModel: 9,
    role: 1,
    channel: 0,
    lastHeard: now - 60,
    latitude: 30 + nodeNum / 1e4,
    longitude: -90,
    altitude: 100,
    positionTimestamp: now - 120,
    positionPrecisionBits: 32,
    transportLastRf: now - 60,
    transportLastMqtt: null,
    transportLastUdp: null,
    transportMechanism: 0,
    isFavorite: false,
    isIgnored: false,
    mobile: 0,
    isMobile: false,
    likelyAircraft: false,
    aircraftManualMark: null,
    sourceId,
    ...extra,
  };
  for (const k of DASHBOARD_OMITTED_NODE_FIELDS) {
    if (!(k in row)) row[k] = k === 'macaddr' ? 'AA:BB:CC:DD:EE:FF' : 1;
  }
  return row;
}

function bundles(rowsA: Record<string, unknown>[], rowsB: Record<string, unknown>[]): UnifiedSourceBundle[] {
  return [
    { sourceId: 'a', sourceName: 'A', protocol: 'Meshtastic', nodes: rowsA, traceroutes: [], neighborInfo: [], channels: [] },
    { sourceId: 'b', sourceName: 'B', protocol: 'Meshtastic', nodes: rowsB, traceroutes: [], neighborInfo: [], channels: [] },
  ];
}

describe('mergeUnifiedSourceData with slim dashboard nodes', () => {
  it('merges to the same nodes, minus the omitted fields', () => {
    const rowsA = [
      fullRow(1, 'a'),
      fullRow(2, 'a', { lastHeard: now - 10, isFavorite: true }),
      fullRow(3, 'a', { latitude: null, longitude: null }),
    ];
    const rowsB = [
      // Same node heard by both sources: newer here, different position fix.
      fullRow(1, 'b', { lastHeard: now - 5, latitude: 31, positionTimestamp: now - 5, transportLastMqtt: now - 5 }),
      fullRow(2, 'b', { longName: 'Node !00000002', macaddr: '00:00:00:00:00:00' }),
      fullRow(4, 'b', { likelyAircraft: true, aircraftBasis: 'altitude', heightAboveGround: 900 }),
    ];

    const full = mergeUnifiedSourceData(bundles(rowsA, rowsB));
    const slim = mergeUnifiedSourceData(bundles(rowsA.map(strip), rowsB.map(strip)));

    expect(slim.nodes).toHaveLength(4);
    expect(slim.nodes).toEqual(full.nodes.map((n) => strip(n as Record<string, unknown>)));
    for (const n of slim.nodes as Record<string, unknown>[]) {
      for (const k of DASHBOARD_OMITTED_NODE_FIELDS) expect(n).not.toHaveProperty(k);
    }
  });
});
