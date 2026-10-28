import { describe, it, expect } from 'vitest';
import {
  shouldGateAutomations,
  DEFAULT_AIRTIME_CUTOFF_THRESHOLD,
  DEFAULT_NEIGHBOR_UTIL_MAX_HOPS,
  MAX_NEIGHBOR_UTIL_MAX_HOPS,
  averageStrongestNeighborUtilization,
  INFRASTRUCTURE_ROLES,
  NEIGHBOR_UTIL_SAMPLE_COUNT,
  MIN_NEIGHBOR_UTIL_SAMPLE_COUNT,
  MAX_NEIGHBOR_UTIL_SAMPLE_COUNT,
  NEIGHBOR_UTIL_FRESH_MS,
  clampNeighborSampleCount,
  computeNeighborUtilization,
  isPickableInfrastructureNode,
  parseManualNeighborNodes,
  type NeighborUtilCandidate,
  type NeighborUtilOptions,
} from './airtimeCutoff.js';

describe('shouldGateAutomations', () => {
  it('gates when utilization exceeds the threshold', () => {
    expect(shouldGateAutomations(45, 30)).toBe(true);
  });

  it('does not gate when utilization is below the threshold', () => {
    expect(shouldGateAutomations(10, 30)).toBe(false);
  });

  it('does not gate when utilization exactly equals the threshold', () => {
    // Strictly greater-than: at the threshold we still run.
    expect(shouldGateAutomations(30, 30)).toBe(false);
  });

  it('uses the default threshold value of 30', () => {
    expect(DEFAULT_AIRTIME_CUTOFF_THRESHOLD).toBe(30);
    expect(shouldGateAutomations(31, DEFAULT_AIRTIME_CUTOFF_THRESHOLD)).toBe(true);
    expect(shouldGateAutomations(29, DEFAULT_AIRTIME_CUTOFF_THRESHOLD)).toBe(false);
  });

  it('never gates when the threshold is 0 (feature disabled)', () => {
    expect(shouldGateAutomations(99, 0)).toBe(false);
  });

  it('never gates when the threshold is negative', () => {
    expect(shouldGateAutomations(99, -5)).toBe(false);
  });

  it('never gates when utilization is unknown (null/undefined)', () => {
    expect(shouldGateAutomations(null, 30)).toBe(false);
    expect(shouldGateAutomations(undefined, 30)).toBe(false);
  });

  it('does not gate on NaN inputs', () => {
    expect(shouldGateAutomations(NaN, 30)).toBe(false);
    expect(shouldGateAutomations(50, NaN)).toBe(false);
  });
});

describe('averageStrongestNeighborUtilization', () => {
  const n = (over: Partial<NeighborUtilCandidate>): NeighborUtilCandidate => ({
    role: 2, hopsAway: 0, rssi: -60, channelUtilization: 40, ...over,
  });

  it('treats Router/Router-Client/Repeater/Router-Late/Client-Base as infrastructure', () => {
    expect([...INFRASTRUCTURE_ROLES].sort((a, b) => a - b)).toEqual([2, 3, 4, 11, 12]);
  });

  it('treats Client Base (role 12) as infrastructure and excludes Sensor (role 6)', () => {
    // Client Base (12) retransmits like Router Late, so it must count. Sensor (6)
    // — the role the issue text mistook for CLIENT_BASE — must NOT count.
    const r = averageStrongestNeighborUtilization([
      n({ role: 6, rssi: -40, channelUtilization: 99 }),  // sensor → excluded
      n({ role: 12, rssi: -60, channelUtilization: 22 }), // client base → included
    ]);
    expect(r.sampleCount).toBe(1);
    expect(r.value).toBe(22);
  });

  it('averages the channelUtilization of the top-3 strongest-RSSI infra neighbours', () => {
    const r = averageStrongestNeighborUtilization([
      n({ rssi: -50, channelUtilization: 50 }), // strongest
      n({ rssi: -60, channelUtilization: 40 }),
      n({ rssi: -70, channelUtilization: 30 }),
      n({ rssi: -90, channelUtilization: 0 }),  // 4th → excluded by top-3
    ]);
    expect(r.sampleCount).toBe(3);
    expect(r.value).toBeCloseTo((50 + 40 + 30) / 3); // 40
  });

  it('excludes non-infrastructure roles', () => {
    const r = averageStrongestNeighborUtilization([
      n({ role: 0, rssi: -40, channelUtilization: 99 }), // client
      n({ role: 5, rssi: -40, channelUtilization: 99 }), // tracker
      n({ role: 2, rssi: -80, channelUtilization: 20 }), // router
    ]);
    expect(r.sampleCount).toBe(1);
    expect(r.value).toBe(20);
  });

  it('excludes nodes beyond the default maxHops of 0 (directly heard only)', () => {
    const r = averageStrongestNeighborUtilization([
      n({ hopsAway: 1, channelUtilization: 99 }),
      n({ hopsAway: null, channelUtilization: 99 }),
      n({ hopsAway: 0, channelUtilization: 25 }),
    ]);
    expect(r.sampleCount).toBe(1);
    expect(r.value).toBe(25);
  });

  it('admits hopsAway=1 candidates when maxHops is 1 (issue #4801)', () => {
    // The reporter's setup: a CLIENT_BASE node relays to routers, so the
    // routers arrive at the MeshMonitor-connected node as hopsAway=1.
    const r = averageStrongestNeighborUtilization(
      [
        n({ hopsAway: 1, rssi: -50, channelUtilization: 60 }),
        n({ hopsAway: 0, rssi: -70, channelUtilization: 30 }),
      ],
      3,
      1,
    );
    expect(r.sampleCount).toBe(2);
    expect(r.value).toBe(45);
  });

  it('rejects hopsAway=2 when maxHops is 1', () => {
    const r = averageStrongestNeighborUtilization(
      [
        n({ hopsAway: 2, rssi: -50, channelUtilization: 99 }),
        n({ hopsAway: 1, rssi: -70, channelUtilization: 30 }),
      ],
      3,
      1,
    );
    expect(r.sampleCount).toBe(1);
    expect(r.value).toBe(30);
  });

  it('rejects negative hopsAway even when maxHops is high', () => {
    const r = averageStrongestNeighborUtilization(
      [
        n({ hopsAway: -1, rssi: -50, channelUtilization: 99 }),
        n({ hopsAway: 0, rssi: -70, channelUtilization: 30 }),
      ],
      3,
      7,
    );
    expect(r.sampleCount).toBe(1);
    expect(r.value).toBe(30);
  });

  it('rejects undefined / null hopsAway regardless of maxHops', () => {
    const r = averageStrongestNeighborUtilization(
      [
        n({ hopsAway: undefined, rssi: -50, channelUtilization: 99 }),
        n({ hopsAway: null, rssi: -55, channelUtilization: 99 }),
        n({ hopsAway: 0, rssi: -70, channelUtilization: 30 }),
      ],
      3,
      7,
    );
    expect(r.sampleCount).toBe(1);
    expect(r.value).toBe(30);
  });

  it('does not clamp maxHops internally: caller may pass values above the UI cap', () => {
    // The UI clamps to [0, MAX_NEIGHBOR_UTIL_MAX_HOPS]; the utility trusts
    // whatever it receives, so a hopsAway=10 candidate with maxHops=10 must
    // still qualify.
    const r = averageStrongestNeighborUtilization(
      [n({ hopsAway: 10, rssi: -60, channelUtilization: 42 })],
      3,
      10,
    );
    expect(r.sampleCount).toBe(1);
    expect(r.value).toBe(42);
  });

  it('exports sane defaults for the max-hops setting', () => {
    expect(DEFAULT_NEIGHBOR_UTIL_MAX_HOPS).toBe(0);
    expect(MAX_NEIGHBOR_UTIL_MAX_HOPS).toBe(7);
  });

  it('excludes nodes missing rssi or channelUtilization', () => {
    const r = averageStrongestNeighborUtilization([
      n({ rssi: null, channelUtilization: 99 }),
      n({ channelUtilization: null }),
      n({ rssi: -55, channelUtilization: 33 }),
    ]);
    expect(r.sampleCount).toBe(1);
    expect(r.value).toBe(33);
  });

  it('averages fewer than 3 when only 1-2 qualify', () => {
    const r = averageStrongestNeighborUtilization([
      n({ rssi: -50, channelUtilization: 60 }),
      n({ rssi: -70, channelUtilization: 20 }),
    ]);
    expect(r.sampleCount).toBe(2);
    expect(r.value).toBe(40);
  });

  it('returns null/0 when nothing qualifies', () => {
    expect(averageStrongestNeighborUtilization([])).toEqual({ value: null, sampleCount: 0, contributors: [] });
    expect(averageStrongestNeighborUtilization([n({ role: 0 })])).toEqual({ value: null, sampleCount: 0, contributors: [] });
  });

  it('returns the contributing infrastructure nodes (strongest RSSI first)', () => {
    const r = averageStrongestNeighborUtilization([
      n({ nodeNum: 3, nodeId: '!3', longName: 'Gamma', rssi: -70, channelUtilization: 30 }),
      n({ nodeNum: 1, nodeId: '!1', longName: 'Alpha', rssi: -50, channelUtilization: 50 }),
      n({ nodeNum: 2, nodeId: '!2', longName: 'Beta', rssi: -60, channelUtilization: 40 }),
      n({ nodeNum: 4, nodeId: '!4', longName: 'Delta', rssi: -90, channelUtilization: 0 }), // excluded by top-3
    ]);
    expect(r.contributors.map((c) => c.longName)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(r.contributors[0]).toMatchObject({ nodeNum: 1, nodeId: '!1', rssi: -50, channelUtilization: 50 });
  });

  it('picks strongest RSSI (higher dBm) when there are byte/role ties', () => {
    const r = averageStrongestNeighborUtilization([
      n({ rssi: -95, channelUtilization: 10 }),
      n({ rssi: -45, channelUtilization: 80 }),
    ], 1);
    expect(r.sampleCount).toBe(1);
    expect(r.value).toBe(80); // the -45 dBm node
  });
});

describe('issue #6007: MQTT exclusion, manual picks, sample count, local fill', () => {
  const NOW = 1_800_000_000_000;
  const n = (over: Partial<NeighborUtilCandidate>): NeighborUtilCandidate => ({
    role: 2, hopsAway: 0, rssi: -60, channelUtilization: 40, channelUtilizationAt: NOW - 60_000, viaMqtt: false, ...over,
  });
  const auto = (nodes: NeighborUtilCandidate[], over: Partial<NeighborUtilOptions> = {}) =>
    computeNeighborUtilization(nodes, {
      mode: 'auto', sampleCount: 3, maxHops: 0, manualNodeNums: [], localChannelUtilization: null, now: NOW, ...over,
    });
  const manual = (nodes: NeighborUtilCandidate[], picks: number[], over: Partial<NeighborUtilOptions> = {}) =>
    computeNeighborUtilization(nodes, {
      mode: 'manual', sampleCount: 3, maxHops: 0, manualNodeNums: picks, localChannelUtilization: null, now: NOW, ...over,
    });

  describe('MQTT-heard nodes are excluded', () => {
    it('in the strongest-RSSI average', () => {
      const r = averageStrongestNeighborUtilization([
        n({ viaMqtt: true, rssi: -30, channelUtilization: 5 }),
        n({ viaMqtt: 1, rssi: -35, channelUtilization: 5 }),
        n({ rssi: -60, channelUtilization: 40 }),
      ]);
      expect(r.sampleCount).toBe(1);
      expect(r.value).toBe(40);
    });

    it('in auto mode', () => {
      const r = auto([
        n({ nodeNum: 1, viaMqtt: true, rssi: -30, channelUtilization: 2 }),
        n({ nodeNum: 2, rssi: -50, channelUtilization: 30 }),
        n({ nodeNum: 3, rssi: -60, channelUtilization: 30 }),
        n({ nodeNum: 4, rssi: -70, channelUtilization: 30 }),
      ]);
      expect(r.contributors.map((c) => c.nodeNum)).toEqual([2, 3, 4]);
      expect(r.value).toBe(30);
    });

    it('in manual mode, reported as skipped', () => {
      const r = manual(
        [n({ nodeNum: 1, viaMqtt: true }), n({ nodeNum: 2 }), n({ nodeNum: 3 })],
        [1, 2, 3],
      );
      expect(r.contributors.map((c) => c.nodeNum)).toEqual([2, 3]);
      expect(r.skipped).toEqual([expect.objectContaining({ nodeNum: 1, reason: 'mqtt' })]);
    });

    it('isPickableInfrastructureNode drops MQTT and non-infrastructure nodes', () => {
      expect(isPickableInfrastructureNode(n({}))).toBe(true);
      expect(isPickableInfrastructureNode(n({ viaMqtt: true }))).toBe(false);
      expect(isPickableInfrastructureNode(n({ role: 0 }))).toBe(false);
      expect(isPickableInfrastructureNode(n({ role: 12 }))).toBe(true);
    });
  });

  describe('manual picks', () => {
    it('averages only the picked nodes, ignoring RSSI rank and maxHops', () => {
      const r = manual(
        [
          n({ nodeNum: 1, rssi: -30, channelUtilization: 90 }), // strongest but not picked
          n({ nodeNum: 2, rssi: -100, hopsAway: 3, channelUtilization: 10 }),
          n({ nodeNum: 3, rssi: null, channelUtilization: 20 }),
          n({ nodeNum: 4, rssi: -90, channelUtilization: 30 }),
        ],
        [2, 3, 4],
      );
      expect(r.sampleCount).toBe(3);
      expect(r.value).toBe(20);
      expect(r.localUsed).toBeNull();
      expect(r.contributors.find((c) => c.nodeNum === 3)?.rssi).toBeNull();
    });

    it('skips stale, missing and no-longer-infrastructure picks and names them', () => {
      const r = manual(
        [
          n({ nodeNum: 1, channelUtilizationAt: NOW - NEIGHBOR_UTIL_FRESH_MS - 1 }), // stale
          n({ nodeNum: 2, channelUtilizationAt: null }), // no sample time
          n({ nodeNum: 3, channelUtilization: null }), // no reading
          n({ nodeNum: 4, role: 0 }), // now a client
          n({ nodeNum: 5, channelUtilizationAt: NOW - NEIGHBOR_UTIL_FRESH_MS, channelUtilization: 25 }), // edge: still fresh
        ],
        [1, 2, 3, 4, 5],
      );
      expect(r.contributors.map((c) => c.nodeNum)).toEqual([5]);
      expect(r.skipped.map((s) => [s.nodeNum, s.reason])).toEqual([
        [1, 'stale'], [2, 'stale'], [3, 'stale'], [4, 'not_infrastructure'],
      ]);
      const gone = manual([n({ nodeNum: 1 })], [1, 7, 8]);
      expect(gone.skipped.map((s) => [s.nodeNum, s.reason])).toEqual([[7, 'not_found'], [8, 'not_found']]);
    });

    it('targets the pick count (never below 3)', () => {
      expect(manual([], [1, 2, 3, 4, 5]).targetCount).toBe(5);
      expect(manual([], [1, 2]).targetCount).toBe(3);
    });
  });

  describe('sample count', () => {
    it('clamps to 3-5 with default 3', () => {
      expect(NEIGHBOR_UTIL_SAMPLE_COUNT).toBe(3);
      expect(MIN_NEIGHBOR_UTIL_SAMPLE_COUNT).toBe(3);
      expect(MAX_NEIGHBOR_UTIL_SAMPLE_COUNT).toBe(5);
      expect(clampNeighborSampleCount(1)).toBe(3);
      expect(clampNeighborSampleCount(4)).toBe(4);
      expect(clampNeighborSampleCount(9)).toBe(5);
      expect(clampNeighborSampleCount('5')).toBe(5);
      expect(clampNeighborSampleCount('abc')).toBe(3);
      expect(clampNeighborSampleCount(undefined)).toBe(3);
    });

    it('auto mode averages the clamped count of strongest nodes', () => {
      const nodes = [-40, -50, -60, -70, -80, -90].map((rssi, i) => n({ nodeNum: i + 1, rssi, channelUtilization: (i + 1) * 10 }));
      expect(auto(nodes, { sampleCount: 5 }).contributors.map((c) => c.nodeNum)).toEqual([1, 2, 3, 4, 5]);
      expect(auto(nodes, { sampleCount: 9 }).sampleCount).toBe(5);
      expect(auto(nodes, { sampleCount: 1 }).sampleCount).toBe(3);
    });
  });

  describe('fill the gap with local ChUtil', () => {
    it('uses max(local, average) when fewer nodes qualify than wanted', () => {
      const two = [n({ nodeNum: 1, channelUtilization: 10 }), n({ nodeNum: 2, channelUtilization: 26 })];
      const higher = auto(two, { localChannelUtilization: 31 });
      expect(higher.value).toBe(31);
      expect(higher.neighborAverage).toBe(18);
      expect(higher.localUsed).toBe('higher_than_neighbors');

      const lower = auto(two, { localChannelUtilization: 5 });
      expect(lower.value).toBe(18);
      expect(lower.localUsed).toBeNull();

      const man = manual([...two, n({ nodeNum: 3, channelUtilizationAt: 0 })], [1, 2, 3], { localChannelUtilization: 31 });
      expect(man.value).toBe(31);
      expect(man.localUsed).toBe('higher_than_neighbors');
    });

    it('uses local ChUtil when nothing qualifies', () => {
      const r = auto([n({ role: 0 })], { localChannelUtilization: 22 });
      expect(r.value).toBe(22);
      expect(r.localUsed).toBe('no_neighbors');
      expect(r.sampleCount).toBe(0);
      const m = manual([], [1, 2, 3], { localChannelUtilization: 22 });
      expect(m.value).toBe(22);
      expect(m.localUsed).toBe('no_neighbors');
    });

    it('keeps the older behaviour when local ChUtil is unknown', () => {
      expect(auto([], { localChannelUtilization: null }).value).toBeNull();
      const short = auto([n({ channelUtilization: 12 })], { localChannelUtilization: null });
      expect(short.value).toBe(12);
      expect(short.localUsed).toBeNull();
    });

    it('auto mode with enough nodes matches the strongest-RSSI average, ignoring local', () => {
      const nodes = [
        n({ rssi: -50, channelUtilization: 50 }),
        n({ rssi: -60, channelUtilization: 40 }),
        n({ rssi: -70, channelUtilization: 30 }),
        n({ rssi: -90, channelUtilization: 0 }),
      ];
      const r = auto(nodes, { localChannelUtilization: 99 });
      const legacy = averageStrongestNeighborUtilization(nodes);
      expect(r.value).toBe(legacy.value);
      expect(r.contributors).toEqual(legacy.contributors);
      expect(r.localUsed).toBeNull();
    });
  });

  it('parseManualNeighborNodes keeps unique valid node numbers', () => {
    expect(parseManualNeighborNodes('[1, 2, 2, "3", -4, 0, 1.5, "x"]')).toEqual([1, 2, 3]);
    expect(parseManualNeighborNodes('not json')).toEqual([]);
    expect(parseManualNeighborNodes('')).toEqual([]);
    expect(parseManualNeighborNodes(null)).toEqual([]);
    expect(parseManualNeighborNodes('{"a":1}')).toEqual([]);
    expect(parseManualNeighborNodes([4294967295, 4294967296])).toEqual([4294967295]);
  });
});
