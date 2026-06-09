import { describe, it, expect } from 'vitest';
import {
  shouldGateAutomations,
  DEFAULT_AIRTIME_CUTOFF_THRESHOLD,
  averageStrongestNeighborUtilization,
  INFRASTRUCTURE_ROLES,
  type NeighborUtilCandidate,
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

  it('treats Router/Router-Client/Repeater/Router-Late as infrastructure', () => {
    expect([...INFRASTRUCTURE_ROLES].sort((a, b) => a - b)).toEqual([2, 3, 4, 11]);
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

  it('excludes nodes that are not directly heard (hopsAway != 0)', () => {
    const r = averageStrongestNeighborUtilization([
      n({ hopsAway: 1, channelUtilization: 99 }),
      n({ hopsAway: null, channelUtilization: 99 }),
      n({ hopsAway: 0, channelUtilization: 25 }),
    ]);
    expect(r.sampleCount).toBe(1);
    expect(r.value).toBe(25);
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
