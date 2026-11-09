/**
 * Mesh Issues on MeshCore (#6263 S5, maintainer decision 6): the MeshCore
 * snapshot adapter plus A3 (uptime resets), A4 and C2 advert cadence, and the
 * guarantee that Meshtastic-only rules never see a MeshCore node.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMeshCoreSnapshot,
  buildMeshCoreUptimeSeries,
  buildMeshCoreTelemetrySeries,
  buildMeshCoreAdvertCadence,
  MESHCORE_ADVERT_DEDUPE_WINDOW_MS,
  type MeshCoreNodeInput,
} from './meshcoreSnapshot.js';
import { evaluateAllTierA, evaluateA3, evaluateA4, type RuleContext } from './rules.js';
import {
  evaluateAllTierC,
  evaluateC2Advert,
  tierCSkips,
  type TierCRuleContext,
} from './rulesTierC.js';
import { evaluateAllTierB, type TierBRuleContext } from './rulesTierB.js';
import { buildPooledNodeSnapshot, subjectKeyFor, type PooledNode } from './nodeSnapshot.js';
import { DEFAULT_MESH_ISSUE_THRESHOLDS, POWER_WINDOW_HOURS } from './thresholds.js';
import { MESH_ISSUE_TYPES } from './types.js';
import { DeviceRole } from '../../../constants/index.js';

const NOW = 2_000_000_000_000;
const HOUR = 3_600_000;
const PK_REPEATER = 'AA'.repeat(32);
const PK_COMPANION = 'BB'.repeat(32);

function mcRow(overrides: Partial<MeshCoreNodeInput> = {}): MeshCoreNodeInput {
  return {
    publicKey: PK_REPEATER,
    sourceId: 'mc-1',
    name: 'Hill Repeater',
    advType: 2,
    latitude: 30,
    longitude: -90,
    lastHeard: NOW - HOUR,
    ...overrides,
  };
}

function ruleCtx(nodes: Map<number, PooledNode>, extra: Partial<RuleContext> = {}): RuleContext {
  return {
    nodes,
    telemetry: new Map(),
    positionSpanMeters: new Map(),
    nowMs: NOW,
    thresholds: DEFAULT_MESH_ISSUE_THRESHOLDS,
    routerBroadcastTelemetryCadence: new Map(),
    ...extra,
  };
}

describe('buildMeshCoreSnapshot', () => {
  it('pools one node per lowercased public key across sources, newest row wins', () => {
    const { nodes, handleByKey } = buildMeshCoreSnapshot([
      mcRow({ sourceId: 'mc-1', name: 'Old', lastHeard: NOW - 5 * HOUR }),
      mcRow({ sourceId: 'mc-2', publicKey: PK_REPEATER.toLowerCase(), name: 'New', lastHeard: NOW - HOUR }),
    ]);
    expect(nodes.size).toBe(1);
    const node = [...nodes.values()][0];
    expect(node.protocol).toBe('meshcore');
    expect(node.nodeKey).toBe(PK_REPEATER.toLowerCase());
    expect(node.longName).toBe('New');
    expect(node.sourceIds).toEqual(['mc-1', 'mc-2']);
    expect(handleByKey.get(PK_REPEATER.toLowerCase())).toBe(node.nodeNum);
  });

  it('uses negative handles that cannot collide with Meshtastic nodeNums, and a mc: subjectKey', () => {
    const { nodes } = buildMeshCoreSnapshot([mcRow(), mcRow({ publicKey: PK_COMPANION, advType: 1 })]);
    for (const [k, n] of nodes) {
      expect(k).toBeLessThan(0);
      expect(subjectKeyFor(n)).toBe(`mc:${n.nodeKey}`);
    }
  });

  it('marks infra from advType (repeater, room server) and not companions', () => {
    const { nodes } = buildMeshCoreSnapshot([
      mcRow({ publicKey: 'cc'.repeat(32), advType: 3 }),
      mcRow({ publicKey: PK_REPEATER, advType: 2 }),
      mcRow({ publicKey: PK_COMPANION, advType: 1 }),
    ]);
    const byKey = new Map([...nodes.values()].map((n) => [n.nodeKey, n.infra]));
    expect(byKey.get('cc'.repeat(32))).toBe(true);
    expect(byKey.get(PK_REPEATER.toLowerCase())).toBe(true);
    expect(byKey.get(PK_COMPANION.toLowerCase())).toBe(false);
  });

  it('subjectKeyFor keeps node:<nodeNum> for Meshtastic', () => {
    const mt = buildPooledNodeSnapshot([{ nodeNum: 100, nodeId: '!00000064', sourceId: 's' }]).get(100)!;
    expect(subjectKeyFor(mt)).toBe('node:100');
  });
});

describe('A4 on MeshCore', () => {
  it('flags a mobile repeater with subjectKey mc:<pk>, nodeNum null and publicKey evidence', () => {
    const { nodes } = buildMeshCoreSnapshot([mcRow()]);
    const h = [...nodes.keys()][0];
    const findings = evaluateA4(ruleCtx(nodes, { positionSpanMeters: new Map([[h, 5000]]) }));
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.issueType).toBe(MESH_ISSUE_TYPES.A4_MOBILE_INFRA);
    expect(f.subjectKey).toBe(`mc:${PK_REPEATER.toLowerCase()}`);
    expect(f.nodeNum).toBeNull();
    expect(f.evidence.publicKey).toBe(PK_REPEATER.toLowerCase());
    expect(f.evidence.nodeName).toBe('Hill Repeater');
    expect(f.evidence.sourceIds).toEqual(['mc-1']);
    expect(f.sourceIds).toEqual(['mc-1']);
  });

  it('does not flag a companion, or a repeater inside the span threshold', () => {
    const { nodes } = buildMeshCoreSnapshot([
      mcRow(),
      mcRow({ publicKey: PK_COMPANION, advType: 1 }),
    ]);
    const spans = new Map([...nodes.keys()].map((h) => [h, 5000]));
    const found = evaluateAllTierA(ruleCtx(nodes, { positionSpanMeters: spans }));
    expect(found.map((f) => f.subjectKey)).toEqual([`mc:${PK_REPEATER.toLowerCase()}`]);

    const quiet = evaluateAllTierA(ruleCtx(nodes, { positionSpanMeters: new Map([[[...nodes.keys()][0], 10]]) }));
    expect(quiet).toEqual([]);
  });
});

describe('A3 on MeshCore (uptime-reset clause only)', () => {
  function uptimeRows(handleKey: string, values: number[]) {
    return values.map((value, i) => ({
      nodeId: handleKey,
      timestamp: NOW - (values.length - i) * HOUR,
      value,
      sourceId: 'mc-1',
    }));
  }

  it('fires on repeated uptime resets in the window', () => {
    const { nodes, handleByKey } = buildMeshCoreSnapshot([mcRow()]);
    const telemetry = buildMeshCoreUptimeSeries(
      uptimeRows(PK_REPEATER, [5000, 9000, 100, 4000, 50]),
      handleByKey,
    );
    const findings = evaluateA3(ruleCtx(nodes, { telemetry }));
    expect(findings).toHaveLength(1);
    expect(findings[0].subjectKey).toBe(`mc:${PK_REPEATER.toLowerCase()}`);
    expect(findings[0].nodeNum).toBeNull();
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].evidence.clause).toBe('resets');
    expect(findings[0].evidence.uptimeResets).toBe(2);
    expect(findings[0].evidence.publicKey).toBe(PK_REPEATER.toLowerCase());
  });

  it('does not fire on steadily increasing uptime, with no battery clause on MeshCore', () => {
    const { nodes, handleByKey } = buildMeshCoreSnapshot([mcRow()]);
    const telemetry = buildMeshCoreUptimeSeries(uptimeRows(PK_REPEATER, [100, 200, 300, 400]), handleByKey);
    expect(evaluateA3(ruleCtx(nodes, { telemetry }))).toEqual([]);
  });

  it('ignores resets older than the power window and a companion with resets', () => {
    const { nodes, handleByKey } = buildMeshCoreSnapshot([
      mcRow(),
      mcRow({ publicKey: PK_COMPANION, advType: 1 }),
    ]);
    const old = [5000, 100, 4000, 50].map((value, i) => ({
      nodeId: PK_REPEATER,
      timestamp: NOW - (POWER_WINDOW_HOURS + 10 + i) * HOUR,
      value,
      sourceId: 'mc-1',
    }));
    const companion = uptimeRows(PK_COMPANION, [5000, 100, 4000, 50]);
    const telemetry = buildMeshCoreUptimeSeries([...old, ...companion], handleByKey);
    expect(evaluateA3(ruleCtx(nodes, { telemetry }))).toEqual([]);
  });
});

describe('C2 advert cadence on MeshCore', () => {
  function adverts(key: string, routeType: number, gapMs: number, count: number, hopCount: number | null = null) {
    return Array.from({ length: count }, (_, i) => ({
      sourceId: 'mc-1',
      timestamp: NOW - (count - i) * gapMs,
      routeType,
      hopCount,
      senderPubKey: key,
    }));
  }

  function tierCCtx(nodes: Map<number, PooledNode>, cadence: TierCRuleContext['meshcoreAdvertCadence'], extra: Partial<TierCRuleContext> = {}): TierCRuleContext {
    return {
      nodes,
      cadence: new Map(),
      thresholds: DEFAULT_MESH_ISSUE_THRESHOLDS,
      nowMs: NOW,
      windowHours: 168,
      meshcoreAdvertCadence: cadence,
      meshcoreAdvertLogEnabled: true,
      ...extra,
    };
  }

  it('flags a repeater whose median flood-advert gap is under 6 h', () => {
    const { nodes, handleByKey } = buildMeshCoreSnapshot([mcRow()]);
    const reps = new Set(handleByKey.values());
    const cadence = buildMeshCoreAdvertCadence(adverts(PK_REPEATER, 1, 2 * HOUR, 8), handleByKey, reps);
    const findings = evaluateC2Advert(tierCCtx(nodes, cadence));
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.issueType).toBe(MESH_ISSUE_TYPES.C2_OVER_BROADCASTING);
    expect(f.subjectKey).toBe(`mc:${PK_REPEATER.toLowerCase()}`);
    expect(f.nodeNum).toBeNull();
    expect(f.evidence.stream).toBe('advert_flood');
    expect(f.evidence.publicKey).toBe(PK_REPEATER.toLowerCase());
    expect(f.evidence.nodeName).toBe('Hill Repeater');
    expect(f.evidence.sourceIds).toEqual(['mc-1']);
    expect(f.evidence.medianIntervalSeconds).toBe(2 * 3600);
  });

  it('flags a repeater whose median zero-hop advert gap is under 60 min', () => {
    const { nodes, handleByKey } = buildMeshCoreSnapshot([mcRow()]);
    const reps = new Set(handleByKey.values());
    const cadence = buildMeshCoreAdvertCadence(adverts(PK_REPEATER, 2, 20 * 60_000, 10, 0), handleByKey, reps);
    const findings = evaluateC2Advert(tierCCtx(nodes, cadence));
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.stream).toBe('advert_zero_hop');
  });

  it('does not flag healthy cadence (flood 12 h, zero-hop 2 h)', () => {
    const { nodes, handleByKey } = buildMeshCoreSnapshot([mcRow()]);
    const reps = new Set(handleByKey.values());
    const cadence = buildMeshCoreAdvertCadence(
      [...adverts(PK_REPEATER, 1, 12 * HOUR, 8), ...adverts(PK_REPEATER, 2, 2 * HOUR, 8, 0)],
      handleByKey,
      reps,
    );
    expect(evaluateC2Advert(tierCCtx(nodes, cadence))).toEqual([]);
  });

  it('collapses copies of one advert heard by several observers', () => {
    const { nodes, handleByKey } = buildMeshCoreSnapshot([mcRow()]);
    const reps = new Set(handleByKey.values());
    // 8 genuine adverts 12 h apart, each heard 5 times within seconds.
    const dup = adverts(PK_REPEATER, 1, 12 * HOUR, 8).flatMap((p) =>
      [0, 1000, 2000, 3000, 4000].map((d) => ({ ...p, timestamp: p.timestamp + d })),
    );
    const cadence = buildMeshCoreAdvertCadence(dup, handleByKey, reps);
    expect(evaluateC2Advert(tierCCtx(nodes, cadence))).toEqual([]);
    expect(cadence.get([...reps][0])!.flood!.sampleCount).toBe(8);
    expect(MESHCORE_ADVERT_DEDUPE_WINDOW_MS).toBeLessThan(HOUR);
  });

  it('a companion never gets a C2 advert finding', () => {
    const { nodes, handleByKey } = buildMeshCoreSnapshot([mcRow({ publicKey: PK_COMPANION, advType: 1 })]);
    const reps = new Set(handleByKey.values()); // even if wrongly passed as repeater
    const cadence = buildMeshCoreAdvertCadence(adverts(PK_COMPANION, 1, HOUR, 8), handleByKey, reps);
    expect(evaluateAllTierC(tierCCtx(nodes, cadence))).toEqual([]);
  });

  it('skips with a coverage reason when MeshCore logging is off, and stays quiet with no MeshCore nodes', () => {
    const { nodes } = buildMeshCoreSnapshot([mcRow()]);
    const off = tierCSkips(tierCCtx(nodes, new Map(), { meshcoreAdvertLogEnabled: false }));
    expect(off.some((s) => s.rule === 'C2' && /packet log/i.test(s.reason))).toBe(true);
    const none = tierCSkips(tierCCtx(new Map(), undefined, { meshcoreAdvertLogEnabled: undefined }));
    expect(none.every((s) => !/packet log/i.test(s.reason))).toBe(true);
  });
});

describe('Meshtastic-only rules never see MeshCore nodes', () => {
  it('A1/A2/A5 and Tier B ignore a MeshCore node carrying Meshtastic-looking fields', () => {
    const { nodes } = buildMeshCoreSnapshot([
      mcRow({ publicKey: 'd1'.repeat(32), latitude: 30, longitude: -90 }),
      mcRow({ publicKey: 'd2'.repeat(32), latitude: 30.001, longitude: -90.001 }),
    ]);
    // Give them roles every Meshtastic rule would act on.
    const handles = [...nodes.keys()];
    for (const n of nodes.values()) {
      n.role = DeviceRole.REPEATER; // A1 deprecated role
      n.isUnmessagable = false;
      n.firmwareVersion = '2.6.0'; // A5 clause armed
    }
    const a = evaluateAllTierA(ruleCtx(nodes));
    expect(a.filter((f) => ['A1_deprecated_role', 'A5_cosplay_router'].includes(f.issueType))).toEqual([]);

    for (const n of nodes.values()) n.role = DeviceRole.ROUTER;
    const edgeKey = `${Math.min(handles[0], handles[1])}-${Math.max(handles[0], handles[1])}`;
    const edge = {
      a: Math.min(handles[0], handles[1]),
      b: Math.max(handles[0], handles[1]),
      key: edgeKey,
      evidenceClasses: ['neighborInfo'],
      direct: true,
      neighborInfoCount: 1,
      tracerouteSampleCount: 0,
      tracerouteDistinctPairCount: 0,
      gatewayDirectCount: 0,
      coReceptionGateways: [],
      observationCount: 1,
      snrToA: { count: 0, meanDb: null },
      snrToB: { count: 0, meanDb: null },
      sourceIds: ['mc-1'],
      firstSeenMs: null,
      lastSeenMs: null,
    };
    const adj = new Map([
      [handles[0], new Set([handles[1]])],
      [handles[1], new Set([handles[0]])],
    ]);
    const graph = {
      edges: new Map([[edgeKey, edge]]),
      directAdjacency: adj,
      adjacency: adj,
      stats: { directEdgeCount: 1, totalEdgeCount: 1, nodeCount: 2 },
    };
    const mkCtx = (ns: Map<number, PooledNode>) =>
      ({
        nodes: ns,
        graph,
        samples: [],
        hopHorizon: new Map(),
        mqttSourceIds: new Set(),
        nowMs: NOW,
        thresholds: DEFAULT_MESH_ISSUE_THRESHOLDS,
      }) as unknown as TierBRuleContext;
    // Control: the same two nodes as Meshtastic routers DO form a B1 cluster.
    const asMeshtastic = new Map(
      [...nodes.entries()].map(([k, n]) => [k, { ...n, protocol: undefined, nodeKey: undefined, infra: undefined }]),
    );
    expect(evaluateAllTierB(mkCtx(asMeshtastic as Map<number, PooledNode>)).length).toBeGreaterThan(0);
    const bCtx = mkCtx(nodes);
    expect(evaluateAllTierB(bCtx)).toEqual([]);
  });

  it('Tier C: C1 and Meshtastic C2 skip MeshCore nodes even with flags set', () => {
    const { nodes } = buildMeshCoreSnapshot([mcRow()]);
    const n = [...nodes.values()][0];
    n.isExcessivePackets = true;
    n.keyIsLowEntropy = true;
    n.isTimeOffsetIssue = true;
    n.timeOffsetSeconds = 99999;
    n.role = DeviceRole.CLIENT;
    const ctx: TierCRuleContext = {
      nodes,
      cadence: new Map([[n.nodeNum, { position: null, telemetry: { sampleCount: 20, meanIntervalSeconds: 10, medianIntervalSeconds: 10, sourceIds: ['mc-1'] } }]]),
      thresholds: DEFAULT_MESH_ISSUE_THRESHOLDS,
      nowMs: NOW,
      windowHours: 168,
    };
    expect(evaluateAllTierC(ctx)).toEqual([]);
  });
});

describe('MeshCore node-health inputs (#6279)', () => {
  it('derives reportedPosition, override, advertHadPosition and isLocal', () => {
    const { nodes } = buildMeshCoreSnapshot([
      mcRow({ sourceId: 'mc-1', lastHeard: NOW - 2 * HOUR, lastAdvertHadPosition: false }),
      mcRow({
        sourceId: 'mc-2',
        lastHeard: NOW - 3 * HOUR,
        isLocalNode: true,
        positionOverrideEnabled: true,
        latitudeOverride: 1,
        longitudeOverride: 2,
      }),
    ]);
    const n = [...nodes.values()][0];
    expect(n.reportedPosition).toBe('valid');
    expect(n.hasPositionOverride).toBe(true);
    expect(n.advertHadPosition).toBe(false);
    expect(n.isLocal).toBe(true);
  });

  it('flags bogus and absent reported positions, and null advertHadPosition when unknown', () => {
    const bogus = [...buildMeshCoreSnapshot([mcRow({ latitude: 0, longitude: 0 })]).nodes.values()][0];
    expect(bogus.reportedPosition).toBe('bogus');
    expect(bogus.advertHadPosition).toBeNull();
    const none = [...buildMeshCoreSnapshot([mcRow({ latitude: null, longitude: null })]).nodes.values()][0];
    expect(none.reportedPosition).toBe('none');
  });

  it('normalises mc_battery_mv and mc_status_battery_volts into batteryMv (mV), deduping across sources', () => {
    const { handleByKey } = buildMeshCoreSnapshot([mcRow()]);
    const key = PK_REPEATER.toLowerCase();
    const handle = handleByKey.get(key)!;
    const series = buildMeshCoreTelemetrySeries(
      [
        { nodeId: PK_REPEATER, telemetryType: 'mc_battery_mv', timestamp: 1000, value: 3400, sourceId: 'mc-1' },
        { nodeId: PK_REPEATER, telemetryType: 'mc_status_battery_volts', timestamp: 2000, value: 3.25, sourceId: 'mc-1' },
        { nodeId: PK_REPEATER, telemetryType: 'mc_status_battery_volts', timestamp: 2000, value: 3.25, sourceId: 'mc-2' },
        { nodeId: PK_REPEATER, telemetryType: 'mc_status_uptime_secs', timestamp: 2000, value: 99, sourceId: 'mc-1' },
        { nodeId: PK_REPEATER, telemetryType: 'mc_other', timestamp: 2000, value: 1, sourceId: 'mc-1' },
        { nodeId: 'ff'.repeat(32), telemetryType: 'mc_battery_mv', timestamp: 2000, value: 1, sourceId: 'mc-1' },
      ],
      handleByKey,
    );
    const s = series.get(handle)!;
    expect(s.batteryMv.map((x) => x.value)).toEqual([3400, 3250]);
    expect(s.uptimeSeconds.map((x) => x.value)).toEqual([99]);
    expect(series.size).toBe(1);
  });

  it('the uptime wrapper treats untyped rows as uptime', () => {
    const { handleByKey } = buildMeshCoreSnapshot([mcRow()]);
    const series = buildMeshCoreUptimeSeries(
      [{ nodeId: PK_REPEATER, timestamp: 1000, value: 5, sourceId: 'mc-1' }],
      handleByKey,
    );
    expect([...series.values()][0].uptimeSeconds).toHaveLength(1);
  });
});
