/**
 * @vitest-environment jsdom
 */
/**
 * Show RF / UDP / MQTT filtering of route segments (#5097).
 *
 * These render the real hook and read the segments it hands to
 * `TraceroutePathsLayer`, rather than re-implementing the predicate in the
 * test. The predicate itself is covered in `utils/tracerouteTransport.test.ts`;
 * what needs proving here is that the hook actually applies it, on both layers,
 * with the right class for each hop — which a re-implementation cannot show.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useTraceroutePaths,
  type NodePositionDigest,
  type TracerouteDigest,
  type ThemeColors,
  type UseTraceroutePathsParams,
} from './useTraceroutePaths';
import { TX_LORA, TX_MQTT, TX_MULTICAST_UDP } from '../utils/nodeTransport';
import { UNKNOWN_SNR_SENTINEL } from '../utils/tracerouteSegments';

/** Raw (un-scaled) SNR that decodes to the firmware unknown-hop sentinel. */
const RAW_SENTINEL = UNKNOWN_SNR_SENTINEL * 4; // -128, i.e. INT8_MIN
const RAW_GOOD = 40; // 10 dB

const NODES: NodePositionDigest[] = [
  { nodeNum: 100, position: { latitude: 40.0, longitude: -75.0 }, user: { id: '!64', longName: 'A', shortName: 'A' } },
  { nodeNum: 200, position: { latitude: 40.2, longitude: -75.2 }, user: { id: '!c8', longName: 'B', shortName: 'B' } },
  { nodeNum: 300, position: { latitude: 40.1, longitude: -75.1 }, user: { id: '!12c', longName: 'C', shortName: 'C' } },
];

const THEME: ThemeColors = {
  accentAlt: '#111', error: '#f00', accent: '#0f0',
  tracerouteForward: '#00f', tracerouteReturn: '#f0f',
} as ThemeColors;

/**
 * A traceroute 100 -> 300 -> 200 (and back). `snrTowards`/`snrBack` are raw
 * firmware values; the hook scales by 4 internally.
 */
function traceroute(over: Partial<TracerouteDigest> = {}): TracerouteDigest {
  return {
    fromNodeNum: 100,
    toNodeNum: 200,
    fromNodeId: '!64',
    toNodeId: '!c8',
    route: '[300]',
    routeBack: '[300]',
    snrTowards: JSON.stringify([RAW_GOOD, RAW_GOOD]),
    snrBack: JSON.stringify([RAW_GOOD, RAW_GOOD]),
    timestamp: Date.now(),
    ...over,
  };
}

function baseParams(over: Partial<UseTraceroutePathsParams> = {}): UseTraceroutePathsParams {
  return {
    showPaths: true,
    showRoute: false,
    selectedNodeId: null,
    currentNodeId: '!64',
    nodesPositionDigest: NODES,
    traceroutesDigest: [traceroute()],
    distanceUnit: 'km',
    maxNodeAgeHours: 0, // 0 = "never" — keep every traceroute regardless of age
    themeColors: THEME,
    callbacks: { onSelectNode: () => {}, onSelectRouteSegment: () => {} },
    ...over,
  };
}

/** Node-pair keys of the segments the base ("Show Route Segments") layer drew. */
function basePairs(params: UseTraceroutePathsParams): string[] {
  const { result } = renderHook(() => useTraceroutePaths(params));
  const layer = result.current.traceroutePathsElements?.[0];
  if (!layer) return [];
  // Reading the layer's props is the point: the segments it was handed ARE the
  // filter's output.
  const segments = (layer as any).props.segments as Array<{ fromNodeNum: number; toNodeNum: number }>;
  return segments.map(s => [s.fromNodeNum, s.toNodeNum].sort((a, b) => a - b).join('-'));
}

/** Node-pair keys of the segments the selected-traceroute layer drew. */
function selectedPairs(params: UseTraceroutePathsParams): string[] {
  const { result } = renderHook(() => useTraceroutePaths(params));
  const layers = result.current.selectedNodeTraceroute;
  if (!layers) return [];
  return layers.flatMap(layer =>
    ((layer as any).props.segments ?? []).map((s: { fromNodeNum: number; toNodeNum: number }) =>
      [s.fromNodeNum, s.toNodeNum].sort((a, b) => a - b).join('-'),
    ),
  );
}

const ALL_ON = { showRfNodes: true, showUdpNodes: true, showMqttNodes: true };

describe('useTraceroutePaths — Show RF / UDP / MQTT on route segments (#5097)', () => {
  it('draws every segment when no transport flags are supplied', () => {
    // The compatibility guarantee: a caller with no toggles filters nothing.
    expect(new Set(basePairs(baseParams()))).toEqual(new Set(['100-300', '200-300']));
  });

  it('draws every segment when all three toggles are on', () => {
    expect(new Set(basePairs(baseParams({ transportFlags: ALL_ON })))).toEqual(
      new Set(['100-300', '200-300']),
    );
  });

  it('hides a UDP-delivered traceroute when Show UDP is off', () => {
    // The half of the request that could not be built before migration 160:
    // nothing on the row said UDP, so nothing could filter on it.
    const params = baseParams({
      traceroutesDigest: [traceroute({ transportMechanism: TX_MULTICAST_UDP })],
      transportFlags: { ...ALL_ON, showUdpNodes: false },
    });
    expect(basePairs(params)).toEqual([]);
  });

  it('keeps a UDP-delivered traceroute while Show UDP is on', () => {
    const params = baseParams({
      traceroutesDigest: [traceroute({ transportMechanism: TX_MULTICAST_UDP })],
      transportFlags: { ...ALL_ON, showRfNodes: false, showMqttNodes: false },
    });
    expect(new Set(basePairs(params))).toEqual(new Set(['100-300', '200-300']));
  });

  it('hides an MQTT-delivered traceroute when Show MQTT is off', () => {
    const params = baseParams({
      traceroutesDigest: [traceroute({ transportMechanism: TX_MQTT })],
      transportFlags: { ...ALL_ON, showMqttNodes: false },
    });
    expect(basePairs(params)).toEqual([]);
  });

  it('treats a pre-migration traceroute (no mechanism) as RF', () => {
    // Upgrade safety: historical rows carry NULL and must not vanish.
    const params = baseParams({
      traceroutesDigest: [traceroute({ transportMechanism: null })],
      transportFlags: { ...ALL_ON, showMqttNodes: false, showUdpNodes: false },
    });
    expect(new Set(basePairs(params))).toEqual(new Set(['100-300', '200-300']));

    const rfOff = baseParams({
      traceroutesDigest: [traceroute({ transportMechanism: null })],
      transportFlags: { ...ALL_ON, showRfNodes: false },
    });
    expect(basePairs(rfOff)).toEqual([]);
  });

  it('drops only the sentinel hop of an RF traceroute when Show MQTT is off', () => {
    // Per-hop, not per-record: hop 100->300 carries the firmware unknown-SNR
    // sentinel, so it is an MQTT hop even though the traceroute reached us over
    // RF. Its sibling 300->200 is real RF and stays. This is the requester's
    // "segments that relied on mqtt are filtered" in its sharpest form.
    const params = baseParams({
      traceroutesDigest: [
        traceroute({
          transportMechanism: TX_LORA,
          snrTowards: JSON.stringify([RAW_SENTINEL, RAW_GOOD]),
          snrBack: JSON.stringify([RAW_GOOD, RAW_SENTINEL]),
        }),
      ],
      transportFlags: { ...ALL_ON, showMqttNodes: false },
    });
    // Forward hop 0 (100->300) and return hop 1 (300->100) are both the 100-300
    // pair and both sentinel, so that pair is MQTT-only and drops.
    expect(new Set(basePairs(params))).toEqual(new Set(['200-300']));
  });

  it('keeps a link one traceroute saw over RF even when another saw it over MQTT', () => {
    // The additive-across-records half. The 100-300 pair is contributed twice:
    // once by an MQTT traceroute, once by an RF one. RF evidence is real, so
    // turning MQTT off must not erase the link.
    const params = baseParams({
      traceroutesDigest: [
        traceroute({ fromNodeNum: 100, toNodeNum: 300, route: '[]', routeBack: '[]', transportMechanism: TX_MQTT, snrTowards: '[40]', snrBack: '[40]' }),
        traceroute({ fromNodeNum: 100, toNodeNum: 300, fromNodeId: '!64', toNodeId: '!12c', route: '[]', routeBack: '[]', transportMechanism: TX_LORA, snrTowards: '[40]', snrBack: '[40]', timestamp: Date.now() + 1000 }),
      ],
      transportFlags: { ...ALL_ON, showMqttNodes: false },
    });
    expect(basePairs(params)).toContain('100-300');
  });

  it('keys segments numerically, so a mixed-width node pair still matches', () => {
    // Review point on #5097: the pair key used a bare `.sort()`, which orders
    // lexicographically — [9, 100] becomes "100-9". Every site was wrong the
    // same way so nothing broke, but a new site using a numeric sort would have
    // silently missed the accumulated transport classes and rendered a segment
    // the toggle should have removed. Node 9 vs 100 is the smallest pair that
    // distinguishes the two orderings.
    const params = baseParams({
      nodesPositionDigest: [
        { nodeNum: 9, position: { latitude: 40.0, longitude: -75.0 }, user: { id: '!9', longName: 'S', shortName: 'S' } },
        { nodeNum: 100, position: { latitude: 40.2, longitude: -75.2 }, user: { id: '!64', longName: 'A', shortName: 'A' } },
      ],
      traceroutesDigest: [
        traceroute({
          fromNodeNum: 9,
          toNodeNum: 100,
          fromNodeId: '!9',
          toNodeId: '!64',
          route: '[]',
          routeBack: '[]',
          snrTowards: '[40]',
          snrBack: '[40]',
          transportMechanism: TX_MQTT,
        }),
      ],
      transportFlags: { ...ALL_ON, showMqttNodes: false },
    });
    // If the filter looked the pair up under a differently-ordered key it would
    // find no classes, fall through to "no evidence", and draw the segment.
    expect(basePairs(params)).toEqual([]);
  });

  it('applies the same rule to the selected traceroute layer', () => {
    // "Show Traceroute" is a separate memo with its own render path; a fix that
    // only reached the aggregated layer would leave this one unfiltered.
    const shown = baseParams({
      showPaths: false,
      showRoute: true,
      selectedNodeId: '!c8',
      traceroutesDigest: [traceroute({ transportMechanism: TX_MULTICAST_UDP })],
      transportFlags: ALL_ON,
    });
    expect(selectedPairs(shown).length).toBeGreaterThan(0);

    const hidden = { ...shown, transportFlags: { ...ALL_ON, showUdpNodes: false } };
    expect(selectedPairs(hidden)).toEqual([]);
  });
});
