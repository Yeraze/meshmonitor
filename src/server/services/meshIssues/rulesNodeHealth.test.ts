/**
 * Node-health rules A6-A9 (#6279), both protocols per rule.
 */
import { describe, it, expect } from 'vitest';
import { evaluateA6, evaluateA7, evaluateA8, evaluateA9, nodeHealthSkips } from './rulesNodeHealth.js';
import { evaluateAllTierA, tierASkips, type RuleContext } from './rules.js';
import { buildPooledNodeSnapshot, type NodeTelemetrySeries, type PooledNodeInput, type PooledNode } from './nodeSnapshot.js';
import { buildMeshCoreSnapshot, type MeshCoreNodeInput } from './meshcoreSnapshot.js';
import { DEFAULT_MESH_ISSUE_THRESHOLDS } from './thresholds.js';
import { DeviceRole } from '../../../constants/index.js';

const NOW = 2_000_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PK = 'aa'.repeat(32);

const emptySeries = (over: Partial<NodeTelemetrySeries> = {}): NodeTelemetrySeries => ({
  airUtilTx: [],
  channelUtilization: [],
  batteryLevel: [],
  uptimeSeconds: [],
  batteryMv: [],
  ...over,
});
const sample = (timestamp: number, value: number, sourceId = 'src-a') => ({ timestamp, value, sourceId });

function mt(over: Partial<PooledNodeInput> = {}): PooledNode {
  return buildPooledNodeSnapshot([
    {
      nodeNum: 100,
      nodeId: '!64',
      sourceId: 'src-a',
      role: DeviceRole.ROUTER,
      lastHeard: (NOW - HOUR) / 1000,
      latitude: 40,
      longitude: -100,
      ...over,
    },
  ]).get(100)!;
}
function mc(over: Partial<MeshCoreNodeInput> = {}): PooledNode {
  return [
    ...buildMeshCoreSnapshot([
      { publicKey: PK, sourceId: 'mc-1', name: 'Hill', advType: 2, lastHeard: NOW - HOUR, latitude: 30, longitude: -90, ...over },
    ]).nodes.values(),
  ][0];
}
function ctx(nodes: PooledNode[], extra: Partial<RuleContext> = {}): RuleContext {
  return {
    nodes: new Map(nodes.map((n) => [n.nodeNum, n])),
    telemetry: new Map(),
    positionSpanMeters: new Map(),
    nowMs: NOW,
    thresholds: DEFAULT_MESH_ISSUE_THRESHOLDS,
    routerBroadcastTelemetryCadence: new Map(),
    sourceLastHeardMs: new Map([
      ['src-a', NOW - HOUR],
      ['mc-1', NOW - HOUR],
    ]),
    ...extra,
  };
}

describe('A6 stale node', () => {
  it('flags a stale Meshtastic infra node and a stale MeshCore repeater', () => {
    const a = mt({ lastHeard: (NOW - 30 * HOUR) / 1000 });
    const b = mc({ lastHeard: NOW - 100 * HOUR });
    const f = evaluateA6(ctx([a, b]));
    expect(f).toHaveLength(2);
    const mtF = f.find((x) => x.subjectKey.startsWith('node:'))!;
    expect(mtF.evidence).toMatchObject({ thresholdHours: 24, roleName: 'Router', aliveSources: ['src-a'] });
    expect(mtF.evidence).not.toHaveProperty('publicKey');
    const mcF = f.find((x) => x.subjectKey.startsWith('mc:'))!;
    expect(mcF.nodeNum).toBeNull();
    expect(mcF.evidence).toMatchObject({ thresholdHours: 96, publicKey: PK });
    expect(mcF.recommendation).toContain('flood-advert interval');
    expect(mtF.recommendation).not.toContain('flood-advert');
  });

  it('uses the per-protocol window', () => {
    // 50 h: stale for Meshtastic (24) but fresh for MeshCore (96).
    expect(evaluateA6(ctx([mt({ lastHeard: (NOW - 50 * HOUR) / 1000 })]))).toHaveLength(1);
    expect(evaluateA6(ctx([mc({ lastHeard: NOW - 50 * HOUR })]))).toHaveLength(0);
  });

  it('does not flag fresh, future, null, or older-than-30-day nodes', () => {
    expect(evaluateA6(ctx([mt()]))).toHaveLength(0);
    expect(evaluateA6(ctx([mt({ lastHeard: (NOW + HOUR) / 1000 })]))).toHaveLength(0);
    expect(evaluateA6(ctx([mt({ lastHeard: null, updatedAt: null })]))).toHaveLength(0);
    expect(evaluateA6(ctx([mt({ lastHeard: (NOW - 31 * DAY) / 1000 })]))).toHaveLength(0);
    expect(evaluateA6(ctx([mt({ lastHeard: (NOW - 29 * DAY) / 1000 })]))).toHaveLength(1);
  });

  it('skips the local node, companions and non-infra roles', () => {
    const old = (NOW - 40 * HOUR) / 1000;
    expect(evaluateA6(ctx([mt({ lastHeard: old, isLocal: true })]))).toHaveLength(0);
    expect(evaluateA6(ctx([mt({ lastHeard: old, role: DeviceRole.CLIENT })]))).toHaveLength(0);
    expect(evaluateA6(ctx([mc({ lastHeard: NOW - 200 * HOUR, advType: 1 })]))).toHaveLength(0);
  });

  it('silent sources produce no findings and one skip', () => {
    const n = mt({ lastHeard: (NOW - 30 * HOUR) / 1000 });
    const c = ctx([n], { sourceLastHeardMs: new Map([['src-a', NOW - 40 * HOUR]]) });
    expect(evaluateA6(c)).toHaveLength(0);
    expect(nodeHealthSkips(c)).toContainEqual({ rule: 'A6', reason: '1 node(s) skipped, source(s) silent' });
    expect(tierASkips(c).some((s) => s.rule === 'A6')).toBe(true);
  });

  it('honours a tuned window', () => {
    const n = mt({ lastHeard: (NOW - 30 * HOUR) / 1000 });
    const c = ctx([n], { thresholds: { ...DEFAULT_MESH_ISSUE_THRESHOLDS, staleHoursMeshtastic: 48 } });
    expect(evaluateA6(c)).toHaveLength(0);
  });
});

describe('A7 no position', () => {
  it('no_position on both protocols', () => {
    const f = evaluateA7(ctx([mt({ latitude: null, longitude: null }), mc({ latitude: null, longitude: null })]));
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.evidence.clause === 'no_position' && x.severity === 'info' && x.confidence === 'high')).toBe(true);
    expect(f.find((x) => x.subjectKey.startsWith('node:'))!.recommendation).toContain('fixed position');
    expect(f.find((x) => x.subjectKey.startsWith('mc:'))!.recommendation).toContain('Repeater settings');
  });

  it('position_sharing_disabled (Meshtastic, precision 0)', () => {
    const f = evaluateA7(ctx([mt({ latitude: null, longitude: null, positionPrecisionBits: 0 })]));
    expect(f[0].evidence.clause).toBe('position_sharing_disabled');
  });

  it('advert_without_position (MeshCore) fires with stored coordinates, medium confidence', () => {
    const f = evaluateA7(ctx([mc({ lastAdvertHadPosition: false })]));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ confidence: 'medium' });
    expect(f[0].evidence.clause).toBe('advert_without_position');
    expect(evaluateA7(ctx([mc({ lastAdvertHadPosition: true })]))).toHaveLength(0);
  });

  it('a position override suppresses every clause', () => {
    const ov = { positionOverrideEnabled: 1, latitudeOverride: 1, longitudeOverride: 2 };
    expect(evaluateA7(ctx([mt({ latitude: null, longitude: null, ...ov })]))).toHaveLength(0);
    expect(evaluateA7(ctx([mc({ lastAdvertHadPosition: false, ...ov })]))).toHaveLength(0);
  });

  it('does not flag a node with a position, a companion, or a Meshtastic CLIENT', () => {
    expect(evaluateA7(ctx([mt()]))).toHaveLength(0);
    expect(evaluateA7(ctx([mc({ advType: 1, latitude: null, longitude: null })]))).toHaveLength(0);
    expect(evaluateA7(ctx([mt({ role: DeviceRole.CLIENT, latitude: null, longitude: null })]))).toHaveLength(0);
  });
});

describe('A8 low battery', () => {
  const start = NOW - 100 * HOUR;
  it('Meshtastic percent: low, confidence by trailing samples', () => {
    const n = mt({ voltage: 3.5 });
    // Two samples: too few for A3 (needs 3) and too few to confirm.
    const f = evaluateA8(
      ctx([n], {
        telemetry: new Map([[n.nodeNum, emptySeries({ batteryLevel: [sample(start, 15), sample(start + 1, 14)] })]]),
      }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warning', confidence: 'low' });
    expect(f[0].evidence).toMatchObject({ unit: 'pct', latestBatteryPct: 14, latestBatteryMv: null, thresholdUsed: 20, sampleCount: 2 });
  });

  it('MeshCore mV: three trailing low samples give high confidence', () => {
    const n = mc();
    const c = ctx([n], {
      telemetry: new Map([[n.nodeNum, emptySeries({ batteryMv: [sample(start, 3200), sample(start + 1, 3150), sample(start + 2, 3100)] })]]),
    });
    const f = evaluateA8(c);
    expect(f[0]).toMatchObject({ confidence: 'high' });
    expect(f[0].evidence).toMatchObject({ unit: 'mv', latestBatteryMv: 3100, latestBatteryPct: null, thresholdUsed: 3300 });
    expect(f[0].nodeNum).toBeNull();
    expect(f[0].evidence).toMatchObject({ publicKey: PK });
  });

  it('MeshCore mV: a mixed trailing window is low confidence; healthy is silent', () => {
    const n = mc();
    const mixed = ctx([n], {
      telemetry: new Map([[n.nodeNum, emptySeries({ batteryMv: [sample(start, 4000), sample(start + 1, 3200), sample(start + 2, 3100)] })]]),
    });
    expect(evaluateA8(mixed)[0].confidence).toBe('low');
    const ok = ctx([n], { telemetry: new Map([[n.nodeNum, emptySeries({ batteryMv: [sample(start, 3900)] })]]) });
    expect(evaluateA8(ok)).toHaveLength(0);
  });

  it('skips a powered node (101) and a 0 % reading with no voltage', () => {
    const powered = mt();
    const c1 = ctx([powered], { telemetry: new Map([[powered.nodeNum, emptySeries({ batteryLevel: [sample(start, 101)] })]]) });
    expect(evaluateA8(c1)).toHaveLength(0);
    const c2 = ctx([powered], { telemetry: new Map([[powered.nodeNum, emptySeries({ batteryLevel: [sample(start, 0)] })]]) });
    expect(evaluateA8(c2)).toHaveLength(0);
  });

  it('leaves an infra node whose A3 battery clause fires to A3', () => {
    const n = mt();
    const c = ctx([n], {
      telemetry: new Map([[n.nodeNum, emptySeries({ batteryLevel: [sample(start, 15), sample(start + 1, 16), sample(start + 2, 14)] })]]),
    });
    expect(evaluateA8(c)).toHaveLength(0);
    const all = evaluateAllTierA(c);
    expect(all.filter((f) => f.issueType === 'A3_infra_power')).toHaveLength(1);
    expect(all.filter((f) => f.issueType === 'A8_low_battery')).toHaveLength(0);
  });

  it('follows the tunable lines and ignores readings outside the window', () => {
    const n = mc();
    const t = { ...DEFAULT_MESH_ISSUE_THRESHOLDS, lowBatteryMv: 3000 };
    const c = ctx([n], { thresholds: t, telemetry: new Map([[n.nodeNum, emptySeries({ batteryMv: [sample(start, 3100)] })]]) });
    expect(evaluateA8(c)).toHaveLength(0);
    const old = ctx([n], { telemetry: new Map([[n.nodeNum, emptySeries({ batteryMv: [sample(NOW - 400 * HOUR, 3000)] })]]) });
    expect(evaluateA8(old)).toHaveLength(0);
  });

  it('reports a skip when no infra node has battery telemetry', () => {
    expect(nodeHealthSkips(ctx([mt()]))).toContainEqual({ rule: 'A8', reason: 'no battery telemetry in window' });
  });
});

describe('A9 bad position', () => {
  it('flags Null Island and out-of-range on both protocols, with no coordinates in evidence', () => {
    const f = evaluateA9(
      ctx([
        mt({ latitude: 0, longitude: 0 }),
        { ...mc({ latitude: 1853.45, longitude: -1598.75 }) },
      ]),
    );
    expect(f).toHaveLength(2);
    const mtF = f.find((x) => x.subjectKey.startsWith('node:'))!;
    const mcF = f.find((x) => x.subjectKey.startsWith('mc:'))!;
    expect(mtF.evidence).toMatchObject({ positionIssue: 'null_island', discardSettingOn: false });
    expect(mcF.evidence).toMatchObject({ positionIssue: 'out_of_range' });
    for (const x of f) {
      const keys = Object.keys(x.evidence).join(',').toLowerCase();
      expect(keys).not.toMatch(/lat|lon/);
      expect(JSON.stringify(x.evidence)).not.toContain('1853');
    }
  });

  it('catches a precision-offset Null Island fix', () => {
    // 14 bits re-centres a true (0, 0) fix to (0.0131, 0.0131), outside the plain box.
    const f = evaluateA9(ctx([mt({ latitude: 0.0131, longitude: 0.0131, positionPrecisionBits: 14 })]));
    expect(f).toHaveLength(1);
    expect(f[0].evidence).toMatchObject({ positionIssue: 'null_island', positionPrecisionBits: 14 });
    expect(evaluateA9(ctx([mt({ latitude: 0.0131, longitude: 0.0131 })]))).toHaveLength(0);
  });

  it('ignores an override: a bogus raw pair still fires', () => {
    const f = evaluateA9(ctx([mt({ latitude: 0, longitude: 0, positionOverrideEnabled: 1, latitudeOverride: 40, longitudeOverride: -100 })]));
    expect(f).toHaveLength(1);
  });

  it('is exclusive with A7 and skips valid positions and non-infra nodes', () => {
    const bad = mt({ latitude: 0, longitude: 0 });
    expect(evaluateA7(ctx([bad]))).toHaveLength(0);
    expect(evaluateA9(ctx([mt()]))).toHaveLength(0);
    expect(evaluateA9(ctx([mt({ role: DeviceRole.CLIENT, latitude: 0, longitude: 0 })]))).toHaveLength(0);
    expect(evaluateA9(ctx([mc({ advType: 1, latitude: 0, longitude: 0 })]))).toHaveLength(0);
  });
});

describe('Tier A integration', () => {
  it('runs A6-A9 through evaluateAllTierA with no promote/bare ROUTER advice', () => {
    const stale = { ...mt({ lastHeard: (NOW - 30 * HOUR) / 1000, latitude: null, longitude: null }), nodeNum: 1 };
    const bad = { ...mt({ latitude: 0, longitude: 0 }), nodeNum: 2 };
    const m = mc({ lastHeard: NOW - 200 * HOUR });
    const lowMc = ctx([stale, bad, m], {
      telemetry: new Map([[m.nodeNum, emptySeries({ batteryMv: [sample(NOW - HOUR, 3000)] })]]),
    });
    const f = evaluateAllTierA(lowMc);
    const types = new Set(f.map((x) => x.issueType));
    for (const t of ['A6_stale_node', 'A7_no_position', 'A8_low_battery', 'A9_bad_position']) expect(types.has(t as never)).toBe(true);
    for (const x of f) {
      expect(x.recommendation.toLowerCase()).not.toContain('promote');
      expect(x.recommendation).not.toMatch(/\bROUTER\b/);
      expect(x.recommendation.toLowerCase()).not.toMatch(/advertise more|more often/);
    }
  });
});
