/**
 * MQTT position history (#5364/#5365 Phase 3): every trustworthy MQTT fix is
 * stored as latitude/longitude/altitude telemetry, like the TCP path, and a
 * packet relayed by several gateways is stored once. Harness copied from
 * `mqttIngestion.coverage.test.ts` (database mocked wholesale).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortNum } from './constants/meshtastic.js';
import { COVERAGE_MQTT_ENABLED_SETTING } from '../utils/coverage.js';

const {
  recordReceptionMock,
  getNodeMock,
  getSettingForSourceMock,
  isIgnoredCachedMock,
  upsertNodeAsyncMock,
  applyInlineDistanceCheckMock,
  insertTelemetryAsyncMock,
} = vi.hoisted(() => ({
  recordReceptionMock: vi.fn().mockResolvedValue(true),
  getNodeMock: vi.fn().mockResolvedValue(null),
  getSettingForSourceMock: vi.fn().mockResolvedValue(null),
  isIgnoredCachedMock: vi.fn().mockReturnValue(false),
  upsertNodeAsyncMock: vi.fn().mockResolvedValue(undefined),
  applyInlineDistanceCheckMock: vi.fn().mockResolvedValue('kept'),
  insertTelemetryAsyncMock: vi.fn().mockResolvedValue(undefined),
}));

// Every dataEventEmitter method call is recorded here regardless of name —
// the coverage hook must never emit (mesh-impact checklist §0).
const emitCalls: Array<{ method: string; args: unknown[] }> = [];

vi.mock('../services/database.js', () => {
  const shared = {
    upsertNodeAsync: upsertNodeAsyncMock,
    insertTelemetryAsync: insertTelemetryAsyncMock,
    deleteNodeAsync: vi.fn().mockResolvedValue(undefined),
    nodes: {
      getNode: getNodeMock,
      getNodesByNums: vi.fn(async () => new Map()),
      upsertNode: vi.fn(async () => undefined),
    },
    ignoredNodes: {
      isIgnoredCached: isIgnoredCachedMock,
      addGeoIgnoreAsync: vi.fn(async () => true),
      liftGeoIgnoreAsync: vi.fn(async () => false),
    },
    messages: {
      getMessage: vi.fn(async () => null),
      insertMessage: vi.fn(async () => true),
    },
    channelDatabase: {
      findOrCreateByNameAndHashAsync: vi.fn(async () => undefined),
      getEnabledAsync: vi.fn(async () => []),
      getAllAsync: vi.fn(async () => []),
    },
    settings: {
      getSettingForSource: getSettingForSourceMock,
    },
    getSettingAsync: vi.fn(async () => null),
    mqttPacketLog: {
      insertPacket: vi.fn(async () => undefined),
    },
    mqttOkToMqttViolations: {
      insertViolation: vi.fn(async () => undefined),
    },
    coverageReceptions: {
      recordReception: recordReceptionMock,
    },
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: new Proxy(
    {},
    {
      get(_target, prop) {
        return (...args: unknown[]) => {
          emitCalls.push({ method: String(prop), args });
        };
      },
    },
  ),
}));

vi.mock('./services/autoDeleteByDistanceService.js', () => ({
  autoDeleteByDistanceService: {
    applyInlineDistanceCheck: (...args: unknown[]) => applyInlineDistanceCheckMock(...args),
  },
}));

// Fail-open: no registered radio sources, so isOwnNodeNum() is always false.
vi.mock('./sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getAllManagers: () => [] },
}));

let positionPayload: Record<string, unknown> = { latitudeI: 399_000_000, longitudeI: -751_000_000, altitude: 100 };

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn((portnum: number) => {
      if (portnum === PortNum.POSITION_APP) return positionPayload;
      return null;
    }),
    getPortNumName: vi.fn(() => 'POSITION_APP'),
  },
}));

import { ingestServiceEnvelope, _resetMqttIngestCachesForTest } from './mqttIngestion.js';
import { __resetCoverageMqttPositionCacheForTest } from './utils/coverageMqtt.js';
import { __resetCoverageMqttCacheForTest } from './services/coverageMqttSettings.js';
import { resetMqttPositionDedupe } from './utils/mqttPositionHistory.js';
import type { ServiceEnvelopeShape } from './mqttPacketFilter.js';

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';
const FROM_NUM = 0x11111111;
const GATEWAY_1 = '!00000001';
const GATEWAY_1_NUM = 0x00000001;
const GATEWAY_2 = '!00000002';
const GATEWAY_3 = '!00000003';

/** Map of sourceId -> whether coverage_mqtt_enabled is on for that source. */
let enabledSources: Record<string, boolean> = {};

function envFor(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId,
    packet: {
      id: 0x12345678,
      from: FROM_NUM,
      to: 0xffffffff,
      channel: 0,
      rxTime: Math.floor(Date.now() / 1000) - 5,
      rxSnr: -5.5,
      rxRssi: -80,
      hopStart: 3,
      hopLimit: 2,
      relayNode: 0x42,
      decoded: { portnum: PortNum.POSITION_APP, payload: new Uint8Array([0]), bitfield: 1 },
      ...overrides,
    } as ServiceEnvelopeShape['packet'],
  };
}

async function ingest(sourceId: string, envelope: ServiceEnvelopeShape) {
  return ingestServiceEnvelope({ sourceId, envelope });
}


function positionRows(sourceId?: string) {
  return insertTelemetryAsyncMock.mock.calls
    .filter((c: any[]) => sourceId == null || c[1] === sourceId)
    .map((c: any[]) => c[0]);
}

describe('MQTT ingestion - position history (#5364/#5365 P3)', () => {
  beforeEach(() => {
    insertTelemetryAsyncMock.mockReset();
    insertTelemetryAsyncMock.mockResolvedValue(undefined);
    getNodeMock.mockReset();
    getNodeMock.mockResolvedValue(null);
    isIgnoredCachedMock.mockReset();
    isIgnoredCachedMock.mockReturnValue(false);
    upsertNodeAsyncMock.mockClear();
    applyInlineDistanceCheckMock.mockReset();
    applyInlineDistanceCheckMock.mockResolvedValue('kept');
    emitCalls.length = 0;
    positionPayload = { latitudeI: 399_000_000, longitudeI: -751_000_000, altitude: 100, time: 1_790_000_000 };
    enabledSources = {};
    getSettingForSourceMock.mockReset();
    getSettingForSourceMock.mockImplementation(async (sourceId: string, key: string) => {
      if (key === COVERAGE_MQTT_ENABLED_SETTING) return enabledSources[sourceId] ? '1' : null;
      return null;
    });
    _resetMqttIngestCachesForTest();
    __resetCoverageMqttCacheForTest();
    __resetCoverageMqttPositionCacheForTest();
    resetMqttPositionDedupe();
  });

  it('stores lat, lon and alt rows matching the TCP shape', async () => {
    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await vi.waitFor(() => expect(insertTelemetryAsyncMock).toHaveBeenCalledTimes(3));
    const rows = positionRows(SOURCE_A);
    expect(rows.map((r: any) => r.telemetryType)).toEqual(['latitude', 'longitude', 'altitude']);
    const [lat, lon, alt] = rows;
    expect(lat).toMatchObject({ nodeNum: FROM_NUM, value: 39.9, unit: '°', packetId: 0x12345678, packetTimestamp: 1_790_000_000_000 });
    expect(lon.value).toBeCloseTo(-75.1);
    expect(alt).toMatchObject({ value: 100, unit: 'm' });
    expect(lat.timestamp).toBe(lon.timestamp);
    expect(lat.timestamp).toBe(alt.timestamp);
  });

  it('a fix with no altitude stores only lat and lon', async () => {
    positionPayload = { latitudeI: 399_000_000, longitudeI: -751_000_000 };
    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await vi.waitFor(() => expect(insertTelemetryAsyncMock).toHaveBeenCalledTimes(2));
    expect(positionRows().map((r: any) => r.telemetryType)).toEqual(['latitude', 'longitude']);
  });

  it('the same packet relayed by three gateways is stored once', async () => {
    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await ingest(SOURCE_A, envFor(GATEWAY_2));
    await ingest(SOURCE_A, envFor(GATEWAY_3));
    await vi.waitFor(() => expect(insertTelemetryAsyncMock).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(insertTelemetryAsyncMock).toHaveBeenCalledTimes(3);
  });

  it('dedupe is per source: the same packet on two sources is stored on each', async () => {
    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await ingest(SOURCE_B, envFor(GATEWAY_1));
    await vi.waitFor(() => expect(insertTelemetryAsyncMock).toHaveBeenCalledTimes(6));
    expect(positionRows(SOURCE_A)).toHaveLength(3);
    expect(positionRows(SOURCE_B)).toHaveLength(3);
  });

  it('a new packet id from the same node is stored again', async () => {
    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await ingest(SOURCE_A, envFor(GATEWAY_1, { id: 0x12345679 }));
    await vi.waitFor(() => expect(insertTelemetryAsyncMock).toHaveBeenCalledTimes(6));
  });

  it('a bogus (Null Island) fix stores nothing', async () => {
    positionPayload = { latitudeI: 0, longitudeI: 0, altitude: 100 };
    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await new Promise((r) => setTimeout(r, 20));
    expect(insertTelemetryAsyncMock).not.toHaveBeenCalled();
  });

  it('a distance-dropped fix stores nothing', async () => {
    applyInlineDistanceCheckMock.mockResolvedValue('deleted');
    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await new Promise((r) => setTimeout(r, 20));
    expect(insertTelemetryAsyncMock).not.toHaveBeenCalled();
  });

  it('an insert failure never changes the ingest result or skips the node upsert', async () => {
    insertTelemetryAsyncMock.mockRejectedValue(new Error('boom'));
    const res = await ingest(SOURCE_A, envFor(GATEWAY_1));
    expect(res.ingested).toBe(true);
    await vi.waitFor(() => expect(upsertNodeAsyncMock).toHaveBeenCalled());
  });
});
