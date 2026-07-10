/**
 * Runs in the default node environment — tracerouteSegments.ts is pure and
 * leaflet-free (#4047 P3 WP2).
 */
import { describe, it, expect } from 'vitest';
import {
  UNKNOWN_SNR_SENTINEL,
  isUnknownSnr,
  isValidRouteNode,
  parseSnapshotRoutePositions,
  resolveSegmentPosition,
  buildLiveNodePositionMap,
  hasReturnPath,
  decomposeTraceroute,
  type TracerouteDecomposeInput,
} from './tracerouteSegments';

describe('isUnknownSnr / UNKNOWN_SNR_SENTINEL (#2931, re-homed from mapHelpers)', () => {
  it('is -32 (firmware INT8_MIN / 4)', () => {
    expect(UNKNOWN_SNR_SENTINEL).toBe(-32);
  });

  it('treats -32 as unknown', () => {
    expect(isUnknownSnr(-32)).toBe(true);
  });

  it('treats 0 (protobuf default) as NOT unknown', () => {
    expect(isUnknownSnr(0)).toBe(false);
  });

  it('treats undefined as NOT unknown', () => {
    expect(isUnknownSnr(undefined)).toBe(false);
  });
});

describe('parseSnapshotRoutePositions (#1862)', () => {
  it('returns an empty map for null/undefined/empty input', () => {
    expect(parseSnapshotRoutePositions(undefined).size).toBe(0);
    expect(parseSnapshotRoutePositions(null).size).toBe(0);
    expect(parseSnapshotRoutePositions('').size).toBe(0);
  });

  it('returns an empty map for malformed JSON', () => {
    expect(parseSnapshotRoutePositions('{not json').size).toBe(0);
  });

  it('parses a valid snapshot into a nodeNum -> [lat,lng] map', () => {
    const snap = JSON.stringify({
      100: { lat: 10.5, lng: 20.5 },
      200: { lat: -5, lng: -10, alt: 123 },
    });
    const result = parseSnapshotRoutePositions(snap);
    expect(result.get(100)).toEqual([10.5, 20.5]);
    expect(result.get(200)).toEqual([-5, -10]);
  });

  it('skips entries missing lat or lng', () => {
    const snap = JSON.stringify({
      100: { lat: 10.5 }, // missing lng
      200: { lng: 20.5 }, // missing lat
      300: { lat: 1, lng: 2 },
    });
    const result = parseSnapshotRoutePositions(snap);
    expect(result.has(100)).toBe(false);
    expect(result.has(200)).toBe(false);
    expect(result.get(300)).toEqual([1, 2]);
  });

  it('handles lat/lng of exactly 0 correctly (typeof-number check, not truthy)', () => {
    // Regression guard for the 3-way diff finding: two of the three
    // pre-existing implementations used a truthy `snapshot?.lat && snapshot?.lng`
    // check that silently dropped nodes sitting exactly on lat=0 or lng=0.
    const snap = JSON.stringify({ 100: { lat: 0, lng: 0 } });
    const result = parseSnapshotRoutePositions(snap);
    expect(result.get(100)).toEqual([0, 0]);
  });
});

describe('resolveSegmentPosition', () => {
  it('prefers the snapshot position over the live position', () => {
    const snapshot = new Map<number, [number, number]>([[1, [1, 1]]]);
    const live = new Map<number, [number, number]>([[1, [9, 9]]]);
    expect(resolveSegmentPosition(1, snapshot, live)).toEqual([1, 1]);
  });

  it('falls back to the live position when the snapshot has no entry', () => {
    const snapshot = new Map<number, [number, number]>();
    const live = new Map<number, [number, number]>([[1, [9, 9]]]);
    expect(resolveSegmentPosition(1, snapshot, live)).toEqual([9, 9]);
  });

  it('returns null when neither has an entry', () => {
    const snapshot = new Map<number, [number, number]>();
    const live = new Map<number, [number, number]>();
    expect(resolveSegmentPosition(1, snapshot, live)).toBeNull();
  });
});

describe('hasReturnPath (#2051)', () => {
  it('is true when routeBack has hops, regardless of snrBack', () => {
    expect(hasReturnPath([123], null)).toBe(true);
    expect(hasReturnPath([123], '[]')).toBe(true);
    expect(hasReturnPath([123], [])).toBe(true);
  });

  it('is false for empty routeBack and no snrBack data (string form)', () => {
    expect(hasReturnPath([], null)).toBe(false);
    expect(hasReturnPath([], undefined)).toBe(false);
    expect(hasReturnPath([], '')).toBe(false);
    expect(hasReturnPath([], 'null')).toBe(false);
    expect(hasReturnPath([], '[]')).toBe(false);
  });

  it('is true for empty routeBack but non-empty snrBack (string form) — genuine direct RF hop', () => {
    expect(hasReturnPath([], '[32]')).toBe(true);
  });

  it('is false for empty routeBack and empty snrBack (array form)', () => {
    expect(hasReturnPath([], [])).toBe(false);
  });

  it('is true for empty routeBack but non-empty snrBack (array form)', () => {
    expect(hasReturnPath([], [32])).toBe(true);
  });
});

describe('decomposeTraceroute', () => {
  const resolvePosition = (nodeNum: number): [number, number] | null => {
    const table: Record<number, [number, number]> = {
      100: [10, 10],
      150: [15, 15],
      200: [20, 20],
    };
    return table[nodeNum] ?? null;
  };

  it('returns [] when route data is entirely absent (failed traceroute)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: null,
      routeBack: '[]',
    };
    expect(decomposeTraceroute(tr, { resolvePosition })).toEqual([]);
  });

  it('builds a direct forward-only segment when there is no return path', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: JSON.stringify([40]), // 10 dB
      snrBack: '[]',
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      key: 'forward:100-200',
      from: [10, 10],
      to: [20, 20],
      leg: 'forward',
      avgSnr: 10,
      isMqtt: false,
    });
  });

  it('omits the fictitious return segment for empty routeBack + empty snrBack (#2051)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([150]),
      routeBack: '[]',
      snrTowards: JSON.stringify([40, 32]),
      snrBack: '[]',
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    // Forward: 100->150, 150->200. No return segments at all.
    expect(segments.every((s) => s.leg === 'forward')).toBe(true);
    expect(segments.map((s) => s.key)).toEqual(['forward:100-150', 'forward:150-200']);
  });

  it('draws the return segment when snrBack has data despite empty routeBack (#2051)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: JSON.stringify([40]),
      snrBack: JSON.stringify([28]), // 7 dB
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    const ret = segments.find((s) => s.leg === 'return');
    expect(ret).toBeDefined();
    expect(ret).toMatchObject({
      key: 'return:200-100',
      from: [20, 20],
      to: [10, 10],
      avgSnr: 7,
      isMqtt: false,
    });
  });

  it('draws the return leg when routeBack is populated, walking it in reverse order', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([150]),
      routeBack: JSON.stringify([150]),
      snrTowards: JSON.stringify([40, 32]),
      snrBack: JSON.stringify([36, 24]),
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    const returnSegs = segments.filter((s) => s.leg === 'return');
    expect(returnSegs.map((s) => s.key)).toEqual(['return:200-150', 'return:150-100']);
    expect(returnSegs[0].avgSnr).toBe(9); // 36/4
    expect(returnSegs[1].avgSnr).toBe(6); // 24/4
  });

  it('maps the firmware unknown-SNR sentinel (raw -128) to isMqtt=true and avgSnr=null (#2931)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: JSON.stringify([-128]),
      snrBack: JSON.stringify([-128]),
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments).toHaveLength(2);
    for (const seg of segments) {
      expect(seg.avgSnr).toBeNull();
      expect(seg.isMqtt).toBe(true);
    }
  });

  it('distinguishes a missing SNR sample (avgSnr=null, isMqtt=false) from the sentinel (avgSnr=null, isMqtt=true)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: '[]', // no SNR sample at all for the one hop
      snrBack: '[]',
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments).toHaveLength(1);
    expect(segments[0].avgSnr).toBeNull();
    expect(segments[0].isMqtt).toBe(false);
  });

  it('/4-scales raw firmware SNR values', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: JSON.stringify([20]), // raw 20 -> 5 dB
      snrBack: '[]',
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments[0].avgSnr).toBe(5);
  });

  it('skips a hop segment when either endpoint fails to resolve a position', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 999, // not in the resolvePosition table
      route: '[]',
      routeBack: '[]',
    };
    expect(decomposeTraceroute(tr, { resolvePosition })).toEqual([]);
  });

  it('carries the traceroute timestamp (or createdAt fallback) onto every segment', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrBack: '[1]',
      timestamp: 12345,
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments.every((s) => s.timestamp === 12345)).toBe(true);

    const trFallback: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      createdAt: 999,
    };
    const segmentsFallback = decomposeTraceroute(trFallback, { resolvePosition });
    expect(segmentsFallback[0].timestamp).toBe(999);
  });

  it('builds return-only segments when the forward route is absent but a return path exists (review F1)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: null,
      routeBack: JSON.stringify([150]),
      snrBack: JSON.stringify([36, 24]),
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments.every((s) => s.leg === 'return')).toBe(true);
    expect(segments.map((s) => s.key)).toEqual(['return:200-150', 'return:150-100']);
  });

  it('returns [] when both the forward route and the return path are absent', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: null,
      routeBack: null,
    };
    expect(decomposeTraceroute(tr, { resolvePosition })).toEqual([]);
  });

  it('filters reserved/placeholder node numbers out of the route, joining adjacent segments across the removed hop (review F2)', () => {
    const resolveWithExtra = (nodeNum: number): [number, number] | null =>
      nodeNum === 175 ? [17, 17] : resolvePosition(nodeNum);
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      // 4 hops: 100->150, 150->65535 (placeholder), 65535->175, 175->200
      route: JSON.stringify([150, 65535, 175]),
      routeBack: '[]',
      snrTowards: JSON.stringify([40, -128, 28, 20]),
    };
    const segments = decomposeTraceroute(tr, { resolvePosition: resolveWithExtra });
    expect(segments.map((s) => s.key)).toEqual([
      'forward:100-150',
      'forward:150-175',
      'forward:175-200',
    ]);
    // The dropped hop's own arrival SNR (-128, index 1) is discarded with it —
    // the surviving joined segment keeps 175's OWN arrival SNR (28, index 2),
    // not the removed node's.
    const joined = segments.find((s) => s.key === 'forward:150-175');
    expect(joined).toMatchObject({ fromNodeNum: 150, toNodeNum: 175, avgSnr: 7, isMqtt: false });
  });

  it('carries fromNodeNum/toNodeNum hop identity on every segment (review F5)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([150]),
      routeBack: JSON.stringify([150]),
      snrTowards: JSON.stringify([40, 32]),
      snrBack: JSON.stringify([36, 24]),
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments.map((s) => [s.fromNodeNum, s.toNodeNum])).toEqual([
      [100, 150],
      [150, 200],
      [200, 150],
      [150, 100],
    ]);
  });
});

describe('isValidRouteNode (single home, review F2)', () => {
  it.each([0, 1, 2, 3, 255, 65535, 4294967295])('rejects reserved/broadcast node %i', (n) => {
    expect(isValidRouteNode(n)).toBe(false);
  });

  it.each([4, 100, 65534, 4294967294])('accepts real node numbers %i', (n) => {
    expect(isValidRouteNode(n)).toBe(true);
  });
});

describe('buildLiveNodePositionMap (review F9)', () => {
  it('builds a nodeNum -> [lat,lng] map via the extractor', () => {
    const items = [
      { id: 1, lat: 10, lng: 20 },
      { id: 2, lat: -5, lng: 15 },
    ];
    const map = buildLiveNodePositionMap(items, (i) => ({ nodeNum: i.id, lat: i.lat, lng: i.lng }));
    expect(map.get(1)).toEqual([10, 20]);
    expect(map.get(2)).toEqual([-5, 15]);
  });

  it('skips entries the extractor returns null for', () => {
    const items = [{ id: 1, lat: 10, lng: 20 }];
    const map = buildLiveNodePositionMap(items, () => null);
    expect(map.size).toBe(0);
  });

  it('skips non-numeric or missing coordinates', () => {
    const items: Array<{ id: number; lat: number | null | undefined; lng: number | null | undefined }> = [
      { id: 1, lat: undefined, lng: 20 },
      { id: 2, lat: null, lng: null },
    ];
    const map = buildLiveNodePositionMap(items, (i) => ({ nodeNum: i.id, lat: i.lat, lng: i.lng }));
    expect(map.size).toBe(0);
  });

  it('keeps a legitimate single-axis-zero position (equator or prime meridian)', () => {
    const items = [
      { id: 1, lat: 0, lng: 20 },
      { id: 2, lat: 10, lng: 0 },
    ];
    const map = buildLiveNodePositionMap(items, (i) => ({ nodeNum: i.id, lat: i.lat, lng: i.lng }));
    expect(map.get(1)).toEqual([0, 20]);
    expect(map.get(2)).toEqual([10, 0]);
  });

  it('drops the (0,0) Null Island placeholder', () => {
    const items = [{ id: 1, lat: 0, lng: 0 }];
    const map = buildLiveNodePositionMap(items, (i) => ({ nodeNum: i.id, lat: i.lat, lng: i.lng }));
    expect(map.has(1)).toBe(false);
  });
});
