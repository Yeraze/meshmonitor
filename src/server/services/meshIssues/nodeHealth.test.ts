/**
 * Pure node-health helpers (#6279): battery reading, stale window, source
 * liveness, and the extracted A3 battery clause.
 */
import { describe, it, expect } from 'vitest';
import {
  batteryReading,
  isBatteryLow,
  staleHoursFor,
  buildSourceLiveness,
  infraBatteryDischarging,
} from './nodeHealth.js';
import { buildPooledNodeSnapshot, type NodeTelemetrySeries, type PooledNode } from './nodeSnapshot.js';
import { buildMeshCoreSnapshot } from './meshcoreSnapshot.js';
import { DEFAULT_MESH_ISSUE_THRESHOLDS as T } from './thresholds.js';
import { DeviceRole } from '../../../constants/index.js';

function series(over: Partial<NodeTelemetrySeries> = {}): NodeTelemetrySeries {
  return { airUtilTx: [], channelUtilization: [], batteryLevel: [], uptimeSeconds: [], batteryMv: [], ...over };
}
const sample = (timestamp: number, value: number, sourceId = 's1') => ({ timestamp, value, sourceId });

function mtNode(over: Record<string, unknown> = {}): PooledNode {
  return buildPooledNodeSnapshot([
    { nodeNum: 1, nodeId: '!1', sourceId: 's1', role: DeviceRole.ROUTER, updatedAt: 1000, ...over },
  ]).get(1)!;
}
function mcNode(): PooledNode {
  return [...buildMeshCoreSnapshot([{ publicKey: 'aa'.repeat(32), sourceId: 'm1', advType: 2, lastHeard: 1 }]).nodes.values()][0];
}

describe('batteryReading', () => {
  it('Meshtastic: latest percent with samples, values and sources', () => {
    const r = batteryReading(mtNode(), series({ batteryLevel: [sample(100, 50), sample(200, 15, 's2')] }), 0)!;
    expect(r).toMatchObject({ unit: 'pct', latest: 15, latestTs: 200, samples: 2, sources: ['s1', 's2'] });
    expect(r.values).toEqual([50, 15]);
  });

  it('Meshtastic: powered (101) is no reading', () => {
    expect(batteryReading(mtNode(), series({ batteryLevel: [sample(100, 20), sample(200, 101)] }), 0)).toBeNull();
  });

  it('Meshtastic: 0 with no voltage is no reading; 0 with a voltage is', () => {
    const s = series({ batteryLevel: [sample(100, 0)] });
    expect(batteryReading(mtNode({ voltage: null }), s, 0)).toBeNull();
    expect(batteryReading(mtNode({ voltage: 0 }), s, 0)).toBeNull();
    expect(batteryReading(mtNode({ voltage: 3.5 }), s, 0)?.latest).toBe(0);
  });

  it('MeshCore: reads batteryMv and rejects <= 0', () => {
    expect(batteryReading(mcNode(), series({ batteryMv: [sample(100, 3200)] }), 0)).toMatchObject({
      unit: 'mv',
      latest: 3200,
    });
    expect(batteryReading(mcNode(), series({ batteryMv: [sample(100, 0)] }), 0)).toBeNull();
    expect(batteryReading(mcNode(), series({ batteryMv: [sample(100, -5)] }), 0)).toBeNull();
  });

  it('respects the window and a missing series', () => {
    expect(batteryReading(mtNode(), series({ batteryLevel: [sample(100, 10)] }), 500)).toBeNull();
    expect(batteryReading(mtNode(), undefined, 0)).toBeNull();
  });
});

describe('isBatteryLow / staleHoursFor', () => {
  it('uses the percent line for pct and the mV line for mv', () => {
    const base = { latestTs: 0, samples: 1, values: [], sources: [] };
    expect(isBatteryLow({ ...base, unit: 'pct', latest: 19 }, T)).toBe(true);
    expect(isBatteryLow({ ...base, unit: 'pct', latest: 20 }, T)).toBe(false);
    expect(isBatteryLow({ ...base, unit: 'mv', latest: 3299 }, T)).toBe(true);
    expect(isBatteryLow({ ...base, unit: 'mv', latest: 3300 }, T)).toBe(false);
  });

  it('picks the per-protocol window', () => {
    expect(staleHoursFor(mtNode(), T)).toBe(24);
    expect(staleHoursFor(mcNode(), T)).toBe(96);
  });
});

describe('buildSourceLiveness', () => {
  it('takes the max per source, scales seconds, and excludes local rows', () => {
    const m = buildSourceLiveness([
      { sourceId: 'a', lastHeard: 1_700_000_000 },
      { sourceId: 'a', lastHeard: 1_600_000_000 },
      { sourceId: 'b', lastHeard: 1_700_000_000_000 },
      { sourceId: 'c', lastHeard: 1_800_000_000, isLocal: true },
      { sourceId: 'd', updatedAt: 5000 },
      { sourceId: 'e' },
    ]);
    expect(m.get('a')).toBe(1_700_000_000_000);
    expect(m.get('b')).toBe(1_700_000_000_000);
    expect(m.has('c')).toBe(false);
    expect(m.get('d')).toBe(5000);
    expect(m.has('e')).toBe(false);
  });

  it('honours a custom isLocalRow', () => {
    const m = buildSourceLiveness([{ sourceId: 'a', lastHeard: 1_700_000_000 }], () => true);
    expect(m.size).toBe(0);
  });
});

describe('infraBatteryDischarging (A3 battery clause)', () => {
  const w = 0;
  const three = series({ batteryLevel: [sample(1, 50), sample(2, 15), sample(3, 30)] });
  it('fires for infra on battery with >=3 samples whose min is under the line', () => {
    expect(infraBatteryDischarging(mtNode(), three, w, T)).toMatchObject({ met: true, minBatteryLevel: 15, sampleCount: 3 });
  });
  it('does not fire with too few samples, a powered node, MeshCore, or a non-infra node', () => {
    expect(infraBatteryDischarging(mtNode(), series({ batteryLevel: [sample(1, 5), sample(2, 5)] }), w, T).met).toBe(false);
    expect(infraBatteryDischarging(mtNode({ batteryLevel: 101 }), three, w, T).met).toBe(false);
    expect(infraBatteryDischarging(mcNode(), three, w, T).met).toBe(false);
    expect(infraBatteryDischarging(mtNode({ role: DeviceRole.CLIENT }), three, w, T).met).toBe(false);
  });
  it('follows the tunable line', () => {
    expect(infraBatteryDischarging(mtNode(), three, w, { ...T, lowBatteryPct: 10 }).met).toBe(false);
  });
});
