/**
 * Aircraft age-out D3 lift on the MQTT path. An aged-out aircraft is
 * DB-ignored with reason 'aircraft'; the POSITION case's ignore gate used to
 * drop its fix before the post-upsert hook could lift the ignore, so an
 * aged-out aircraft could never come back on an MQTT source. The lift now
 * runs before the gate. Harness copied from
 * `mqttIngestion.positionHistory.test.ts` (database mocked wholesale).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortNum } from './constants/meshtastic.js';

const {
  recordReceptionMock,
  getNodeMock,
  getSettingForSourceMock,
  isIgnoredCachedMock,
  upsertNodeAsyncMock,
  applyInlineDistanceCheckMock,
  insertTelemetryAsyncMock,
  liftIfLivePositionMock,
  handlePositionReceptionMock,
} = vi.hoisted(() => ({
  recordReceptionMock: vi.fn().mockResolvedValue(true),
  getNodeMock: vi.fn().mockResolvedValue(null),
  getSettingForSourceMock: vi.fn().mockResolvedValue(null),
  isIgnoredCachedMock: vi.fn().mockReturnValue(false),
  upsertNodeAsyncMock: vi.fn().mockResolvedValue(undefined),
  applyInlineDistanceCheckMock: vi.fn().mockResolvedValue('kept'),
  insertTelemetryAsyncMock: vi.fn().mockResolvedValue(undefined),
  liftIfLivePositionMock: vi.fn().mockResolvedValue(false),
  handlePositionReceptionMock: vi.fn(),
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

vi.mock('./services/aircraftAgeOutService.js', () => ({
  aircraftAgeOutService: {
    liftIfLivePosition: (...args: unknown[]) => liftIfLivePositionMock(...args),
    handlePositionReception: (...args: unknown[]) => handlePositionReceptionMock(...args),
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
const FROM_NUM = 0x11111111;
const GATEWAY_1 = '!00000001';


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


describe('MQTT ingestion - aircraft age-out lift before the ignore gate', () => {
  /** nodeNums currently on the (mocked) ignore list for SOURCE_A. */
  let ignored: Set<number>;

  beforeEach(() => {
    ignored = new Set();
    isIgnoredCachedMock.mockReset();
    isIgnoredCachedMock.mockImplementation((n: number) => ignored.has(n));
    upsertNodeAsyncMock.mockClear();
    insertTelemetryAsyncMock.mockClear();
    getNodeMock.mockResolvedValue(null);
    getSettingForSourceMock.mockResolvedValue(null);
    applyInlineDistanceCheckMock.mockResolvedValue('kept');
    liftIfLivePositionMock.mockReset();
    handlePositionReceptionMock.mockReset();
    positionPayload = { latitudeI: 399_000_000, longitudeI: -751_000_000, altitude: 10_000 };
    _resetMqttIngestCachesForTest();
    __resetCoverageMqttCacheForTest();
    __resetCoverageMqttPositionCacheForTest();
    resetMqttPositionDedupe();
  });

  it('a lifted aged-out aircraft ingests its live fix and reaches the post-upsert hook', async () => {
    ignored.add(FROM_NUM);
    liftIfLivePositionMock.mockImplementation(async (_s: string, n: number) => {
      ignored.delete(n);
      return true;
    });
    const env = envFor(GATEWAY_1);
    const result = await ingest(SOURCE_A, env);

    expect(liftIfLivePositionMock).toHaveBeenCalledWith(SOURCE_A, FROM_NUM, env.packet!.rxTime, expect.any(Number));
    expect(result).toMatchObject({ ingested: true });
    expect(upsertNodeAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ nodeNum: FROM_NUM, altitude: 10_000 }));
    await vi.waitFor(() => expect(handlePositionReceptionMock).toHaveBeenCalled());
  });

  it('an ignore the lift declines (manual, geo, or a replayed fix) still drops the position', async () => {
    ignored.add(FROM_NUM);
    liftIfLivePositionMock.mockResolvedValue(false);
    const result = await ingest(SOURCE_A, envFor(GATEWAY_1));

    expect(liftIfLivePositionMock).toHaveBeenCalled();
    expect(result).toMatchObject({ ingested: false, reason: 'ignored' });
    expect(upsertNodeAsyncMock).not.toHaveBeenCalled();
  });

  it('a bogus (0,0) fix from an ignored sender never attempts the lift', async () => {
    ignored.add(FROM_NUM);
    positionPayload = { latitudeI: 0, longitudeI: 0, altitude: 10_000 };
    const result = await ingest(SOURCE_A, envFor(GATEWAY_1));

    expect(liftIfLivePositionMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ingested: false, reason: 'ignored' });
  });

  it('a sender that is not ignored skips the lift entirely', async () => {
    const result = await ingest(SOURCE_A, envFor(GATEWAY_1));

    expect(liftIfLivePositionMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ingested: true });
  });
});
