/**
 * Regression tests for #3506 — serial telemetry ingest unified onto the shared
 * canonical-key normalizer (buildCanonicalMetrics).
 *
 * The device / environment / airQuality / power branches no longer read a
 * hand-maintained list of camelCase property names; they iterate the decoded
 * fields and resolve each through canonicalTelemetryType/Unit. These tests pin:
 *   - the environment leaf renames (relativeHumidity→humidity, etc.),
 *   - device + power channels coming through the same path,
 *   - genuine 0 readings still stored,
 *   - protobuf.js repeated fields (exposed as own `[]`) and unknown leaves skipped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsertTelemetry = vi.fn();
const mockUpsertNode = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    telemetry: { insertTelemetry: mockInsertTelemetry },
    nodes: { upsertNode: mockUpsertNode, getAllNodes: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function storedValue(type: string): number | undefined {
  const call = mockInsertTelemetry.mock.calls.find((c) => c[0]?.telemetryType === type);
  return call?.[0]?.value;
}
function storedUnit(type: string): string | undefined {
  const call = mockInsertTelemetry.mock.calls.find((c) => c[0]?.telemetryType === type);
  return call?.[0]?.unit;
}
function storedTypes(): string[] {
  return mockInsertTelemetry.mock.calls.map((c) => c[0]?.telemetryType);
}

describe('MeshtasticManager - canonical telemetry normalization (#3506)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    vi.spyOn(manager, 'trackPKIEncryption').mockResolvedValue(undefined);
  });

  const meshPacket = { from: 0x22222222, id: 7 };

  it('normalizes environment leaf renames and units', async () => {
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      environmentMetrics: {
        temperature: 21.5,
        relativeHumidity: 48,
        barometricPressure: 1013.2,
        voltage: 3.7,
        current: 0.12,
      },
    });

    expect(storedValue('temperature')).toBeCloseTo(21.5, 2);
    expect(storedValue('humidity')).toBe(48);
    expect(storedUnit('humidity')).toBe('%');
    expect(storedValue('pressure')).toBeCloseTo(1013.2, 1);
    expect(storedUnit('pressure')).toBe('hPa');
    // Deprecated env voltage/current are renamed so they don't collide with PowerMetrics.
    expect(storedValue('envVoltage')).toBeCloseTo(3.7, 2);
    expect(storedUnit('envVoltage')).toBe('V');
    expect(storedValue('envCurrent')).toBeCloseTo(0.12, 2);
    expect(storedUnit('envCurrent')).toBe('A');
  });

  it('stores device metrics through the shared path', async () => {
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      deviceMetrics: {
        batteryLevel: 0, // genuine 0 must persist
        voltage: 4.1,
        channelUtilization: 12.5,
        airUtilTx: 3.2,
        uptimeSeconds: 86400,
      },
    });

    expect(storedValue('batteryLevel')).toBe(0);
    expect(storedUnit('batteryLevel')).toBe('%');
    expect(storedValue('voltage')).toBeCloseTo(4.1, 2);
    expect(storedValue('channelUtilization')).toBeCloseTo(12.5, 2);
    expect(storedValue('airUtilTx')).toBeCloseTo(3.2, 2);
    expect(storedValue('uptimeSeconds')).toBe(86400);
  });

  it('stores power channels through the shared path', async () => {
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      powerMetrics: { ch1Voltage: 3.8, ch1Current: 150, ch3Voltage: 5.0 },
    });

    expect(storedValue('ch1Voltage')).toBeCloseTo(3.8, 2);
    expect(storedUnit('ch1Voltage')).toBe('V');
    expect(storedValue('ch1Current')).toBe(150);
    expect(storedUnit('ch1Current')).toBe('mA');
    expect(storedValue('ch3Voltage')).toBe(5.0);
  });

  it('excludes NaN / Infinity values (Number.isFinite guard)', async () => {
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      environmentMetrics: {
        temperature: NaN,
        barometricPressure: Infinity,
        // humidity IS a known canonical type (ENVIRONMENT_UNITS has it) — it's
        // excluded here purely by the Number.isFinite guard, not for being unknown.
        humidity: -Infinity,
        gasResistance: 12.3, // a finite value still gets through
      },
    });

    expect(storedTypes()).not.toContain('temperature');
    expect(storedTypes()).not.toContain('pressure');
    expect(storedValue('gasResistance')).toBeCloseTo(12.3, 2);
  });

  it('skips repeated/array fields and unknown leaves', async () => {
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      environmentMetrics: {
        temperature: 19,
        // protobuf.js exposes repeated EnvironmentMetrics.oneWireTemperature as an own [].
        oneWireTemperature: [],
        // A leaf with no canonical unit must not be persisted.
        someFutureUntrackedField: 999,
      },
    });

    expect(storedValue('temperature')).toBe(19);
    expect(storedTypes()).not.toContain('oneWireTemperature');
    expect(storedTypes()).not.toContain('someFutureUntrackedField');
  });

  it('stores localStats under bare canonical names, incl. a genuine 0 (#3515)', async () => {
    vi.spyOn(manager, 'checkAutoHeapManagement').mockResolvedValue(undefined);
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      localStats: {
        uptimeSeconds: 3600,
        channelUtilization: 12.5,
        airUtilTx: 3.2,
        numPacketsTx: 100,
        numPacketsRx: 250,
        numPacketsRxBad: 4,
        numOnlineNodes: 8,
        numTotalNodes: 42,
        numTxRelayCanceled: 0, // genuine 0 must persist
        numTxDropped: 1,
        heapFreeBytes: 51200,
        noiseFloor: -98,
      },
    });

    expect(storedValue('uptimeSeconds')).toBe(3600);
    expect(storedValue('channelUtilization')).toBeCloseTo(12.5, 2);
    expect(storedValue('numPacketsTx')).toBe(100);
    expect(storedUnit('numPacketsTx')).toBe('packets');
    expect(storedValue('numPacketsRxBad')).toBe(4);
    expect(storedUnit('numPacketsRxBad')).toBe('packets');
    expect(storedValue('numTxDropped')).toBe(1);
    expect(storedValue('numOnlineNodes')).toBe(8);
    expect(storedUnit('numOnlineNodes')).toBe('nodes');
    expect(storedValue('numTxRelayCanceled')).toBe(0);
    expect(storedValue('heapFreeBytes')).toBe(51200);
    expect(storedUnit('heapFreeBytes')).toBe('bytes');
    expect(storedValue('noiseFloor')).toBe(-98);
    expect(storedUnit('noiseFloor')).toBe('dBm');
  });

  it('stores hostMetrics under host-prefixed names (#3515)', async () => {
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      hostMetrics: {
        uptimeSeconds: 7200,
        freememBytes: 1048576,
        diskfree1Bytes: 2097152,
        load1: 0.42,
        load15: 0.10,
      },
    });

    expect(storedValue('hostUptimeSeconds')).toBe(7200);
    expect(storedUnit('hostUptimeSeconds')).toBe('s');
    expect(storedValue('hostFreememBytes')).toBe(1048576);
    expect(storedUnit('hostFreememBytes')).toBe('bytes');
    expect(storedValue('hostDiskfree1Bytes')).toBe(2097152);
    expect(storedValue('hostLoad1')).toBeCloseTo(0.42, 2);
    expect(storedUnit('hostLoad1')).toBe('load');
    expect(storedValue('hostLoad15')).toBeCloseTo(0.10, 2);
  });

  it('stores trafficManagementStats under tm-prefixed names (#3515)', async () => {
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      trafficManagementStats: {
        packetsInspected: 5000,
        positionDedupDrops: 12,
        nodeinfoCacheHits: 88,
        rateLimitDrops: 0,
        routerHopsPreserved: 3,
      },
    });

    expect(storedValue('tmPacketsInspected')).toBe(5000);
    expect(storedUnit('tmPacketsInspected')).toBe('packets');
    expect(storedValue('tmPositionDedupDrops')).toBe(12);
    expect(storedValue('tmNodeinfoCacheHits')).toBe(88);
    expect(storedUnit('tmNodeinfoCacheHits')).toBe('hits');
    expect(storedValue('tmRateLimitDrops')).toBe(0);
    expect(storedValue('tmRouterHopsPreserved')).toBe(3);
    expect(storedUnit('tmRouterHopsPreserved')).toBe('hops');
  });
});
