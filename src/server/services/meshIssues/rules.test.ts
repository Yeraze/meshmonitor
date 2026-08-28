import { describe, it, expect } from 'vitest';
import {
  evaluateA1,
  evaluateA2a,
  evaluateA2b,
  evaluateA3,
  evaluateA4,
  evaluateA5,
  evaluateAllTierA,
  type RuleContext,
} from './rules.js';
import type { PooledNode, NodeTelemetrySeries, TelemetrySample } from './nodeSnapshot.js';
import { MESH_ISSUE_TYPES } from './types.js';
import { UTILIZATION_WINDOW_HOURS, POWER_WINDOW_HOURS } from './thresholds.js';
import { DeviceRole } from '../../../constants/index.js';

const NOW_MS = 2_000_000_000_000;
const UTIL_WINDOW_START = NOW_MS - UTILIZATION_WINDOW_HOURS * 3600_000;
const POWER_WINDOW_START = NOW_MS - POWER_WINDOW_HOURS * 3600_000;

function makeNode(overrides: Partial<PooledNode> = {}): PooledNode {
  return {
    nodeNum: 100,
    nodeId: '!00000064',
    longName: 'Test Node',
    shortName: 'TN',
    hwModel: 1,
    role: null,
    isUnmessagable: false,
    firmwareVersion: null,
    batteryLevel: null,
    voltage: null,
    channelUtilization: null,
    airUtilTx: null,
    latitude: null,
    longitude: null,
    positionPrecisionBits: null,
    mobile: false,
    lastHeardMs: null,
    sourceIds: ['src-a'],
    ...overrides,
  };
}

function emptySeries(): NodeTelemetrySeries {
  return { airUtilTx: [], channelUtilization: [], batteryLevel: [], uptimeSeconds: [] };
}

function makeContext(
  nodes: PooledNode[],
  telemetry: Map<number, NodeTelemetrySeries> = new Map(),
  positionSpanMeters: Map<number, number> = new Map(),
  nowMs = NOW_MS
): RuleContext {
  const nodeMap = new Map<number, PooledNode>();
  for (const n of nodes) nodeMap.set(n.nodeNum, n);
  return { nodes: nodeMap, telemetry, positionSpanMeters, nowMs };
}

describe('evaluateA1 — deprecated role', () => {
  it('fires for REPEATER, with lastHeardAgeMs present', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.REPEATER, lastHeardMs: NOW_MS - 5000 })]);
    const findings = evaluateA1(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.lastHeardAgeMs).toBe(5000);
  });

  it('fires for ROUTER_CLIENT', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER_CLIENT })]);
    expect(evaluateA1(ctx)).toHaveLength(1);
  });

  it('does not fire for ROUTER', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER })]);
    expect(evaluateA1(ctx)).toHaveLength(0);
  });

  it('does not fire for CLIENT', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.CLIENT })]);
    expect(evaluateA1(ctx)).toHaveLength(0);
  });

  it('is null when lastHeardMs is unknown', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.REPEATER, lastHeardMs: null })]);
    expect(evaluateA1(ctx)[0].evidence.lastHeardAgeMs).toBeNull();
  });

  it('recommendation never contains "promote"', () => {
    const ctx = makeContext([
      makeNode({ nodeNum: 1, role: DeviceRole.REPEATER }),
      makeNode({ nodeNum: 2, role: DeviceRole.ROUTER_CLIENT }),
    ]);
    for (const f of evaluateA1(ctx)) {
      expect(f.recommendation.toLowerCase()).not.toContain('promote');
    }
  });
});

describe('evaluateA2a — chatty node', () => {
  function seriesWithAirUtil(samples: Array<Pick<TelemetrySample, 'timestamp' | 'value'>>): Map<number, NodeTelemetrySeries> {
    const m = new Map<number, NodeTelemetrySeries>();
    m.set(100, { ...emptySeries(), airUtilTx: samples.map((s) => ({ sourceId: 'src-a', ...s })) });
    return m;
  }

  it('fires at 6 samples mean 9%', () => {
    const samples = Array.from({ length: 6 }, (_, i) => ({ timestamp: UTIL_WINDOW_START + 1000 + i, value: 9 }));
    const ctx = makeContext([makeNode()], seriesWithAirUtil(samples));
    expect(evaluateA2a(ctx)).toHaveLength(1);
  });

  it('does not fire at 5 samples', () => {
    const samples = Array.from({ length: 5 }, (_, i) => ({ timestamp: UTIL_WINDOW_START + 1000 + i, value: 9 }));
    const ctx = makeContext([makeNode()], seriesWithAirUtil(samples));
    expect(evaluateA2a(ctx)).toHaveLength(0);
  });

  it('does not fire at mean 8.0 (strict >)', () => {
    const samples = Array.from({ length: 6 }, (_, i) => ({ timestamp: UTIL_WINDOW_START + 1000 + i, value: 8 }));
    const ctx = makeContext([makeNode()], seriesWithAirUtil(samples));
    expect(evaluateA2a(ctx)).toHaveLength(0);
  });

  it('excludes out-of-window samples from both the count and the mean', () => {
    const inWindow = Array.from({ length: 5 }, (_, i) => ({ timestamp: UTIL_WINDOW_START + 1000 + i, value: 9 }));
    const outOfWindow = [{ timestamp: UTIL_WINDOW_START - 10_000, value: 100 }];
    const ctx = makeContext([makeNode()], seriesWithAirUtil([...inWindow, ...outOfWindow]));
    expect(evaluateA2a(ctx)).toHaveLength(0); // only 5 in-window samples, below AIR_UTIL_TX_MIN_SAMPLES
  });
});

describe('evaluateA2b — congested area', () => {
  function channelUtilSeries(value: number): NodeTelemetrySeries {
    return { ...emptySeries(), channelUtilization: [{ timestamp: UTIL_WINDOW_START + 1000, value, sourceId: 'src-a' }] };
  }

  it('emits one area finding (nodeNum null) for 3 nodes in one bin at mean 30%', () => {
    const nodes = [
      makeNode({ nodeNum: 1, latitude: 10.01, longitude: 20.01 }),
      makeNode({ nodeNum: 2, latitude: 10.02, longitude: 20.02 }),
      makeNode({ nodeNum: 3, latitude: 10.03, longitude: 20.03 }),
    ];
    const telemetry = new Map<number, NodeTelemetrySeries>([
      [1, channelUtilSeries(30)],
      [2, channelUtilSeries(30)],
      [3, channelUtilSeries(30)],
    ]);
    const findings = evaluateA2b(makeContext(nodes, telemetry));
    expect(findings).toHaveLength(1);
    expect(findings[0].issueType).toBe(MESH_ISSUE_TYPES.A2B_CONGESTED_AREA);
    expect(findings[0].nodeNum).toBeNull();
    expect(findings[0].severity).toBe('warning');
  });

  it('emits info node findings instead of an area finding for 2 qualifying nodes in a bin', () => {
    const nodes = [
      makeNode({ nodeNum: 1, latitude: 10.01, longitude: 20.01 }),
      makeNode({ nodeNum: 2, latitude: 10.02, longitude: 20.02 }),
    ];
    const telemetry = new Map<number, NodeTelemetrySeries>([
      [1, channelUtilSeries(30)],
      [2, channelUtilSeries(30)],
    ]);
    const findings = evaluateA2b(makeContext(nodes, telemetry));
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.issueType).toBe(MESH_ISSUE_TYPES.A2B_CONGESTED_NODE);
      expect(f.severity).toBe('info');
      expect(f.nodeNum).not.toBeNull();
    }
  });

  it('excludes a bogus (Null Island) position from clustering', () => {
    const nodes = [makeNode({ nodeNum: 1, latitude: 0, longitude: 0 })];
    const telemetry = new Map<number, NodeTelemetrySeries>([[1, channelUtilSeries(90)]]);
    expect(evaluateA2b(makeContext(nodes, telemetry))).toHaveLength(0);
  });

  it('excludes nodes without a position', () => {
    const nodes = [makeNode({ nodeNum: 1, latitude: null, longitude: null })];
    const telemetry = new Map<number, NodeTelemetrySeries>([[1, channelUtilSeries(90)]]);
    expect(evaluateA2b(makeContext(nodes, telemetry))).toHaveLength(0);
  });

  it('uses a stable bin key that merges two nearby coordinates into one finding', () => {
    const nodes = [
      makeNode({ nodeNum: 1, latitude: 10.001, longitude: 20.001 }),
      makeNode({ nodeNum: 2, latitude: 10.049, longitude: 20.049 }),
      makeNode({ nodeNum: 3, latitude: 10.02, longitude: 20.02 }),
    ];
    const telemetry = new Map<number, NodeTelemetrySeries>([
      [1, channelUtilSeries(30)],
      [2, channelUtilSeries(30)],
      [3, channelUtilSeries(30)],
    ]);
    const findings = evaluateA2b(makeContext(nodes, telemetry));
    expect(findings).toHaveLength(1);
  });

  it('emits a per-node info finding (not an area finding) for a hot node in a quiet bin — deliberate broadening beyond the spec\'s literal "fewer than 3 nodes" wording (review finding, #4964)', () => {
    // 3 qualifying nodes -> satisfies the node-count clause, but the bin's
    // MEAN stays under the 25% ceiling (60 + 5 + 5) / 3 = 23.33% -> the
    // combined area condition does not fire. One node individually exceeds
    // the threshold, so the fallback branch (the `else` of the combined
    // condition) still surfaces it as a low-confidence, node-attributed
    // signal instead of silently dropping it.
    const nodes = [
      makeNode({ nodeNum: 1, latitude: 10.01, longitude: 20.01 }),
      makeNode({ nodeNum: 2, latitude: 10.02, longitude: 20.02 }),
      makeNode({ nodeNum: 3, latitude: 10.03, longitude: 20.03 }),
    ];
    const telemetry = new Map<number, NodeTelemetrySeries>([
      [1, channelUtilSeries(60)],
      [2, channelUtilSeries(5)],
      [3, channelUtilSeries(5)],
    ]);
    const findings = evaluateA2b(makeContext(nodes, telemetry));
    expect(findings).toHaveLength(1);
    expect(findings[0].issueType).toBe(MESH_ISSUE_TYPES.A2B_CONGESTED_NODE);
    expect(findings[0].nodeNum).toBe(1);
    expect(findings[0].severity).toBe('info');
    expect(findings.some((f) => f.issueType === MESH_ISSUE_TYPES.A2B_CONGESTED_AREA)).toBe(false);
  });
});

describe('evaluateA3 — infra role on failing power', () => {
  it('never fires when powered (battery=101)', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER, batteryLevel: 101 })]);
    expect(evaluateA3(ctx)).toHaveLength(0);
  });

  it('fires warning on 2 uptime resets', () => {
    const uptimeSamples: TelemetrySample[] = [
      { timestamp: POWER_WINDOW_START + 1000, value: 5000, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 2000, value: 100, sourceId: 'src-a' }, // reset 1
      { timestamp: POWER_WINDOW_START + 3000, value: 3000, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 4000, value: 50, sourceId: 'src-a' }, // reset 2
    ];
    const telemetry = new Map<number, NodeTelemetrySeries>([
      [100, { ...emptySeries(), uptimeSeconds: uptimeSamples }],
    ]);
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER, batteryLevel: 50 })], telemetry);
    const findings = evaluateA3(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].confidence).toBe('medium');
    expect(findings[0].evidence.clause).toBe('resets');
  });

  it('fires info for battery 15% with clean uptime and >=3 samples', () => {
    const batterySamples: TelemetrySample[] = [
      { timestamp: POWER_WINDOW_START + 1000, value: 15, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 2000, value: 18, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 3000, value: 16, sourceId: 'src-a' },
    ];
    const telemetry = new Map<number, NodeTelemetrySeries>([
      [100, { ...emptySeries(), batteryLevel: batterySamples }],
    ]);
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER, batteryLevel: 15 })], telemetry);
    const findings = evaluateA3(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].confidence).toBe('low');
    expect(findings[0].evidence.clause).toBe('battery');
  });

  it('does not fire on battery 15% with only 2 samples', () => {
    const batterySamples: TelemetrySample[] = [
      { timestamp: POWER_WINDOW_START + 1000, value: 15, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 2000, value: 18, sourceId: 'src-a' },
    ];
    const telemetry = new Map<number, NodeTelemetrySeries>([
      [100, { ...emptySeries(), batteryLevel: batterySamples }],
    ]);
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER, batteryLevel: 15 })], telemetry);
    expect(evaluateA3(ctx)).toHaveLength(0);
  });

  it('never fires for a non-infra role', () => {
    const batterySamples: TelemetrySample[] = [
      { timestamp: POWER_WINDOW_START + 1000, value: 5, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 2000, value: 5, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 3000, value: 5, sourceId: 'src-a' },
    ];
    const telemetry = new Map<number, NodeTelemetrySeries>([
      [100, { ...emptySeries(), batteryLevel: batterySamples }],
    ]);
    const ctx = makeContext([makeNode({ role: DeviceRole.CLIENT, batteryLevel: 5 })], telemetry);
    expect(evaluateA3(ctx)).toHaveLength(0);
  });
});

describe('evaluateA4 — mobile infra node', () => {
  it('fires for an infra node with a 600m span', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER })], new Map(), new Map([[100, 600]]));
    expect(evaluateA4(ctx)).toHaveLength(1);
  });

  it('does not fire at a 400m span', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER })], new Map(), new Map([[100, 400]]));
    expect(evaluateA4(ctx)).toHaveLength(0);
  });

  it('skips when positionPrecisionBits=16 (below the 17-bit guard)', () => {
    const ctx = makeContext(
      [makeNode({ role: DeviceRole.ROUTER, positionPrecisionBits: 16 })],
      new Map(),
      new Map([[100, 600]])
    );
    expect(evaluateA4(ctx)).toHaveLength(0);
  });

  it('never fires for a non-infra role', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.CLIENT })], new Map(), new Map([[100, 600]]));
    expect(evaluateA4(ctx)).toHaveLength(0);
  });
});

describe('evaluateA5 — cosplay router', () => {
  it('fires info for ROUTER + firmware 2.6 + isUnmessagable=false', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER, firmwareVersion: '2.6.0', isUnmessagable: false })]);
    const findings = evaluateA5(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].confidence).toBe('low');
  });

  it('does not fire when isUnmessagable=true', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER, firmwareVersion: '2.6.0', isUnmessagable: true })]);
    expect(evaluateA5(ctx)).toHaveLength(0);
  });

  it('does not fire on firmware 2.4 (below the guard)', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER, firmwareVersion: '2.4.0', isUnmessagable: false })]);
    expect(evaluateA5(ctx)).toHaveLength(0);
  });

  it('does not fire with a null firmwareVersion', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.ROUTER, firmwareVersion: null, isUnmessagable: false })]);
    expect(evaluateA5(ctx)).toHaveLength(0);
  });

  it('does not fire for ROUTER_CLIENT', () => {
    const ctx = makeContext([
      makeNode({ role: DeviceRole.ROUTER_CLIENT, firmwareVersion: '2.6.0', isUnmessagable: false }),
    ]);
    expect(evaluateA5(ctx)).toHaveLength(0);
  });

  it('does not fire for REPEATER', () => {
    const ctx = makeContext([makeNode({ role: DeviceRole.REPEATER, firmwareVersion: '2.6.0', isUnmessagable: false })]);
    expect(evaluateA5(ctx)).toHaveLength(0);
  });
});

describe('evaluateAllTierA', () => {
  it('survives a single rule throwing and returns the others', () => {
    // A5's compareVersions() call throws when firmwareVersion isn't a string
    // (a malformed value slipping past the type system at runtime). Only A5
    // touches firmwareVersion this way, so it alone should be lost.
    const badRouter = makeNode({
      nodeNum: 999,
      role: DeviceRole.ROUTER,
      firmwareVersion: {} as unknown as string,
      isUnmessagable: false,
    });
    const deprecatedNode = makeNode({ nodeNum: 1, role: DeviceRole.REPEATER });
    const ctx = makeContext([badRouter, deprecatedNode]);

    const findings = evaluateAllTierA(ctx);

    expect(findings.some((f) => f.issueType === MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE)).toBe(true);
    expect(findings.some((f) => f.issueType === MESH_ISSUE_TYPES.A5_COSPLAY_ROUTER)).toBe(false);
  });
});

describe('cross-rule guardrail: no recommendation promotes to ROUTER', () => {
  it('never contains "promote" and never suggests the bare ROUTER role', () => {
    const nodes = [
      makeNode({ nodeNum: 1, role: DeviceRole.REPEATER }),
      makeNode({ nodeNum: 2, role: DeviceRole.ROUTER_CLIENT }),
      makeNode({ nodeNum: 4, latitude: 10.01, longitude: 20.01 }),
      makeNode({ nodeNum: 5, latitude: 10.02, longitude: 20.02 }),
      makeNode({ nodeNum: 6, latitude: 10.03, longitude: 20.03 }),
      makeNode({ nodeNum: 7, latitude: 50.0, longitude: 60.0 }), // isolated bin -> A2b node finding
      makeNode({ nodeNum: 8, role: DeviceRole.ROUTER, batteryLevel: 50 }),
      makeNode({ nodeNum: 9, role: DeviceRole.REPEATER, batteryLevel: 15 }),
      makeNode({ nodeNum: 10, role: DeviceRole.ROUTER }),
      makeNode({ nodeNum: 11, role: DeviceRole.ROUTER, firmwareVersion: '2.6.0', isUnmessagable: false }),
    ];
    const chattySamples = Array.from({ length: 6 }, (_, i) => ({
      timestamp: UTIL_WINDOW_START + 1000 + i,
      value: 9,
      sourceId: 'src-a',
    }));
    const areaChannelUtil = (value: number): TelemetrySample[] => [
      { timestamp: UTIL_WINDOW_START + 1000, value, sourceId: 'src-a' },
    ];
    const resetsUptime: TelemetrySample[] = [
      { timestamp: POWER_WINDOW_START + 1000, value: 5000, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 2000, value: 100, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 3000, value: 3000, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 4000, value: 50, sourceId: 'src-a' },
    ];
    const cleanBatterySamples: TelemetrySample[] = [
      { timestamp: POWER_WINDOW_START + 1000, value: 15, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 2000, value: 18, sourceId: 'src-a' },
      { timestamp: POWER_WINDOW_START + 3000, value: 16, sourceId: 'src-a' },
    ];

    const telemetry = new Map<number, NodeTelemetrySeries>([
      [1, { ...emptySeries(), airUtilTx: chattySamples }], // also feeds A2a for node 1
      [4, { ...emptySeries(), channelUtilization: areaChannelUtil(30) }],
      [5, { ...emptySeries(), channelUtilization: areaChannelUtil(30) }],
      [6, { ...emptySeries(), channelUtilization: areaChannelUtil(30) }],
      [7, { ...emptySeries(), channelUtilization: areaChannelUtil(90) }],
      [8, { ...emptySeries(), uptimeSeconds: resetsUptime }],
      [9, { ...emptySeries(), batteryLevel: cleanBatterySamples }],
    ]);
    const positionSpanMeters = new Map<number, number>([[10, 600]]);

    const ctx = makeContext(nodes, telemetry, positionSpanMeters);
    const findings = evaluateAllTierA(ctx);

    // Sanity: every rule actually fired at least once in this fixture.
    const issueTypes = new Set(findings.map((f) => f.issueType));
    expect(issueTypes).toEqual(
      new Set([
        MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE,
        MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
        MESH_ISSUE_TYPES.A2B_CONGESTED_AREA,
        MESH_ISSUE_TYPES.A2B_CONGESTED_NODE,
        MESH_ISSUE_TYPES.A3_INFRA_POWER,
        MESH_ISSUE_TYPES.A4_MOBILE_INFRA,
        MESH_ISSUE_TYPES.A5_COSPLAY_ROUTER,
      ])
    );

    for (const f of findings) {
      expect(f.recommendation.toLowerCase()).not.toContain('promote');
      // Word-boundary regex: matches a bare "ROUTER" but not "ROUTER_LATE" /
      // "ROUTER_CLIENT" (underscore is a word character, so there is no
      // boundary between ROUTER and the suffix).
      expect(f.recommendation).not.toMatch(/\bROUTER\b/);
    }
  });
});
