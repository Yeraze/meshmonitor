import { describe, it, expect } from 'vitest';
import { buildPooledNodeSnapshot, buildTelemetrySeries, type PooledNodeInput } from './nodeSnapshot.js';

function makeInput(overrides: Partial<PooledNodeInput> = {}): PooledNodeInput {
  return {
    nodeNum: 100,
    nodeId: '!00000064',
    sourceId: 'src-a',
    ...overrides,
  };
}

describe('buildPooledNodeSnapshot', () => {
  it('pools two source rows for one nodeNum into one PooledNode with both sourceIds', () => {
    const rows = [
      makeInput({ sourceId: 'src-a', updatedAt: 1000 }),
      makeInput({ sourceId: 'src-b', updatedAt: 2000 }),
    ];
    const snapshot = buildPooledNodeSnapshot(rows);
    expect(snapshot.size).toBe(1);
    const node = snapshot.get(100)!;
    expect(node.sourceIds).toEqual(['src-a', 'src-b']);
  });

  it('newest-wins picks the fresher row role, and a null field on the fresher row falls back to the older row', () => {
    const rows = [
      makeInput({ sourceId: 'src-a', updatedAt: 1000, role: 2, longName: 'Old Name' }),
      makeInput({ sourceId: 'src-b', updatedAt: 2000, role: 4, longName: null }),
    ];
    const snapshot = buildPooledNodeSnapshot(rows);
    const node = snapshot.get(100)!;
    // Fresher row (src-b) has a non-null role -> wins.
    expect(node.role).toBe(4);
    // Fresher row's longName is null -> falls back to the older row's value.
    expect(node.longName).toBe('Old Name');
  });

  it('takes lat/lon as a pair from a single source, never mixing axes', () => {
    const rows = [
      makeInput({ sourceId: 'src-a', updatedAt: 2000, latitude: 30.0, longitude: -90.0 }),
      makeInput({ sourceId: 'src-b', updatedAt: 1000, latitude: 40.0, longitude: -100.0 }),
    ];
    const snapshot = buildPooledNodeSnapshot(rows);
    const node = snapshot.get(100)!;
    expect(node.latitude).toBe(30.0);
    expect(node.longitude).toBe(-90.0);
  });

  it('falls back to the next-freshest row for position when the freshest row has no position', () => {
    const rows = [
      makeInput({ sourceId: 'src-a', updatedAt: 2000, latitude: null, longitude: null }),
      makeInput({ sourceId: 'src-b', updatedAt: 1000, latitude: 40.0, longitude: -100.0 }),
    ];
    const snapshot = buildPooledNodeSnapshot(rows);
    const node = snapshot.get(100)!;
    expect(node.latitude).toBe(40.0);
    expect(node.longitude).toBe(-100.0);
  });

  it('honors a position override as the effective position pair', () => {
    const rows = [
      makeInput({
        sourceId: 'src-a',
        updatedAt: 1000,
        latitude: 30.0,
        longitude: -90.0,
        positionOverrideEnabled: true,
        latitudeOverride: 35.0,
        longitudeOverride: -95.0,
      }),
    ];
    const snapshot = buildPooledNodeSnapshot(rows);
    const node = snapshot.get(100)!;
    expect(node.latitude).toBe(35.0);
    expect(node.longitude).toBe(-95.0);
  });

  it('takes positionPrecisionBits as the min across non-null values', () => {
    const rows = [
      makeInput({ sourceId: 'src-a', updatedAt: 1000, positionPrecisionBits: 17 }),
      makeInput({ sourceId: 'src-b', updatedAt: 2000, positionPrecisionBits: 12 }),
      makeInput({ sourceId: 'src-c', updatedAt: 3000, positionPrecisionBits: null }),
    ];
    const snapshot = buildPooledNodeSnapshot(rows);
    const node = snapshot.get(100)!;
    expect(node.positionPrecisionBits).toBe(12);
  });

  it('takes mobile as a logical OR across rows', () => {
    const rows = [
      makeInput({ sourceId: 'src-a', updatedAt: 1000, mobile: 0 }),
      makeInput({ sourceId: 'src-b', updatedAt: 2000, mobile: 1 }),
    ];
    const snapshot = buildPooledNodeSnapshot(rows);
    const node = snapshot.get(100)!;
    expect(node.mobile).toBe(true);
  });

  it('normalizes lastHeard seconds to ms and uses it over updatedAt', () => {
    const nowSeconds = 1_700_000_000; // well below 1e12 -> unix seconds
    const rows = [makeInput({ sourceId: 'src-a', lastHeard: nowSeconds, updatedAt: 1 })];
    const snapshot = buildPooledNodeSnapshot(rows);
    const node = snapshot.get(100)!;
    expect(node.lastHeardMs).toBe(nowSeconds * 1000);
  });

  it('falls back to updatedAt (already ms) when lastHeard is absent', () => {
    const rows = [makeInput({ sourceId: 'src-a', lastHeard: null, updatedAt: 1_700_000_000_000 })];
    const snapshot = buildPooledNodeSnapshot(rows);
    const node = snapshot.get(100)!;
    expect(node.lastHeardMs).toBe(1_700_000_000_000);
  });

  it('returns null lastHeardMs when no row carries either timestamp', () => {
    const rows = [makeInput({ sourceId: 'src-a', lastHeard: null, updatedAt: null })];
    const snapshot = buildPooledNodeSnapshot(rows);
    const node = snapshot.get(100)!;
    expect(node.lastHeardMs).toBeNull();
  });

  it('coerces a string (BIGINT) nodeNum', () => {
    const rows = [makeInput({ nodeNum: '100' })];
    const snapshot = buildPooledNodeSnapshot(rows);
    expect(snapshot.has(100)).toBe(true);
  });

  it('preserves an explicit false isUnmessagable from the freshest row', () => {
    const rows = [
      makeInput({ sourceId: 'src-a', updatedAt: 1000, isUnmessagable: true }),
      makeInput({ sourceId: 'src-b', updatedAt: 2000, isUnmessagable: false }),
    ];
    const snapshot = buildPooledNodeSnapshot(rows);
    const node = snapshot.get(100)!;
    expect(node.isUnmessagable).toBe(false);
  });
});

describe('buildTelemetrySeries', () => {
  it('collapses identical (nodeNum, type, timestamp) rows across two sources into one sample', () => {
    const rows = [
      { nodeNum: 100, telemetryType: 'airUtilTx', timestamp: 1000, value: 5, sourceId: 'src-a' },
      { nodeNum: 100, telemetryType: 'airUtilTx', timestamp: 1000, value: 5, sourceId: 'src-b' },
    ];
    const series = buildTelemetrySeries(rows);
    expect(series.get(100)!.airUtilTx).toHaveLength(1);
    expect(series.get(100)!.airUtilTx[0].sourceId).toBe('src-a'); // deterministic: sourceId asc wins the tie
  });

  it('sorts each series ascending by timestamp', () => {
    const rows = [
      { nodeNum: 100, telemetryType: 'batteryLevel', timestamp: 3000, value: 80, sourceId: 'src-a' },
      { nodeNum: 100, telemetryType: 'batteryLevel', timestamp: 1000, value: 90, sourceId: 'src-a' },
      { nodeNum: 100, telemetryType: 'batteryLevel', timestamp: 2000, value: 85, sourceId: 'src-a' },
    ];
    const series = buildTelemetrySeries(rows);
    expect(series.get(100)!.batteryLevel.map((s) => s.timestamp)).toEqual([1000, 2000, 3000]);
  });

  it('ignores unknown telemetry types', () => {
    const rows = [
      { nodeNum: 100, telemetryType: 'someUnknownType', timestamp: 1000, value: 1, sourceId: 'src-a' },
      { nodeNum: 100, telemetryType: 'airUtilTx', timestamp: 1000, value: 5, sourceId: 'src-a' },
    ];
    const series = buildTelemetrySeries(rows);
    expect(series.get(100)!.airUtilTx).toHaveLength(1);
    // No stray key beyond the four known series.
    expect(Object.keys(series.get(100)!).sort()).toEqual(
      ['airUtilTx', 'batteryLevel', 'channelUtilization', 'uptimeSeconds'].sort()
    );
  });

  it('coerces a string (BIGINT) nodeNum and string timestamp', () => {
    const rows = [{ nodeNum: '100', telemetryType: 'uptimeSeconds', timestamp: '1000', value: 42, sourceId: 'src-a' }];
    const series = buildTelemetrySeries(rows);
    expect(series.has(100)).toBe(true);
    expect(series.get(100)!.uptimeSeconds[0]).toEqual({ timestamp: 1000, value: 42, sourceId: 'src-a' });
  });

  it('keeps separate nodes and separate metric types independent', () => {
    const rows = [
      { nodeNum: 100, telemetryType: 'airUtilTx', timestamp: 1000, value: 5, sourceId: 'src-a' },
      { nodeNum: 200, telemetryType: 'channelUtilization', timestamp: 1000, value: 10, sourceId: 'src-a' },
    ];
    const series = buildTelemetrySeries(rows);
    expect(series.get(100)!.channelUtilization).toHaveLength(0);
    expect(series.get(200)!.airUtilTx).toHaveLength(0);
    expect(series.get(200)!.channelUtilization).toHaveLength(1);
  });
});
