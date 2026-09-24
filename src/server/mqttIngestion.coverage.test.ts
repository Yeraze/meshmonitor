/**
 * Coverage Report MQTT recording hook, wired through `ingestServiceEnvelope`
 * (#5277 P2, §2.6 / §3). Mocks `../services/database.js` wholesale (the
 * `mqttIngestion.bitfield.test.ts` pattern) so the opt-in flag, the
 * per-gateway snapshot, and the actual `recordReception` write can all be
 * asserted deterministically without a real DB.
 *
 * The coverage hook is fire-and-forget (`void maybeRecordMqttCoverageReception(...)`
 * inside the POSITION_APP case), so assertions on `recordReceptionMock` use
 * `vi.waitFor` rather than reading immediately after `ingestServiceEnvelope`
 * resolves (mirrors the fire-and-forget guidance in
 * `mqttIngestion.perSource.test.ts`).
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
} = vi.hoisted(() => ({
  recordReceptionMock: vi.fn().mockResolvedValue(true),
  getNodeMock: vi.fn().mockResolvedValue(null),
  getSettingForSourceMock: vi.fn().mockResolvedValue(null),
  isIgnoredCachedMock: vi.fn().mockReturnValue(false),
  upsertNodeAsyncMock: vi.fn().mockResolvedValue(undefined),
  applyInlineDistanceCheckMock: vi.fn().mockResolvedValue('kept'),
}));

// Every dataEventEmitter method call is recorded here regardless of name —
// the coverage hook must never emit (mesh-impact checklist §0).
const emitCalls: Array<{ method: string; args: unknown[] }> = [];

vi.mock('../services/database.js', () => {
  const shared = {
    upsertNodeAsync: upsertNodeAsyncMock,
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
import { __resetCoverageMqttCacheForTest, invalidateCoverageMqttEnabled } from './services/coverageMqttSettings.js';
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

describe('MQTT ingestion — Coverage Report gateway-reception recording (#5277 P2)', () => {
  beforeEach(() => {
    recordReceptionMock.mockClear();
    recordReceptionMock.mockResolvedValue(true);
    getNodeMock.mockReset();
    getNodeMock.mockResolvedValue(null);
    isIgnoredCachedMock.mockReset();
    isIgnoredCachedMock.mockReturnValue(false);
    upsertNodeAsyncMock.mockClear();
    applyInlineDistanceCheckMock.mockReset();
    applyInlineDistanceCheckMock.mockResolvedValue('kept');
    emitCalls.length = 0;
    positionPayload = { latitudeI: 399_000_000, longitudeI: -751_000_000, altitude: 100 };
    enabledSources = { [SOURCE_A]: true };
    getSettingForSourceMock.mockReset();
    getSettingForSourceMock.mockImplementation(async (sourceId: string, key: string) => {
      if (key === COVERAGE_MQTT_ENABLED_SETTING) return enabledSources[sourceId] ? '1' : null;
      return null;
    });
    _resetMqttIngestCachesForTest();
    __resetCoverageMqttCacheForTest();
    __resetCoverageMqttPositionCacheForTest();
  });

  it('opt-in off (default) never calls recordReception', async () => {
    enabledSources[SOURCE_A] = false;
    const result = await ingest(SOURCE_A, envFor(GATEWAY_1));
    expect(result.ingested).toBe(true);

    // Give any stray fire-and-forget microtasks a chance to run, then assert
    // nothing landed.
    await new Promise((r) => setTimeout(r, 20));
    expect(recordReceptionMock).not.toHaveBeenCalled();
  });

  it('when on, records one row per distinct gateway for the same packet', async () => {
    await ingest(SOURCE_A, envFor(GATEWAY_1, { rxSnr: -5, rxRssi: -70 }));
    await ingest(SOURCE_A, envFor(GATEWAY_2, { rxSnr: -8, rxRssi: -90 }));
    await ingest(SOURCE_A, envFor(GATEWAY_3, { rxSnr: -3, rxRssi: -60 }));

    await vi.waitFor(() => expect(recordReceptionMock).toHaveBeenCalledTimes(3));

    const receiverIds = recordReceptionMock.mock.calls.map((c: any[]) => c[0].receiverId);
    expect(new Set(receiverIds).size).toBe(3);
    expect(receiverIds).toEqual(['!00000001', '!00000002', '!00000003']);

    const snrs = recordReceptionMock.mock.calls.map((c: any[]) => c[0].snr);
    expect(snrs).toEqual([-5, -8, -3]);
    const rssis = recordReceptionMock.mock.calls.map((c: any[]) => c[0].rssi);
    expect(rssis).toEqual([-70, -90, -60]);

    for (const call of recordReceptionMock.mock.calls) {
      expect(call[0].sourceId).toBe(SOURCE_A);
      expect(call[0].receiverKind).toBe('mqtt_gateway');
    }
  });

  it("the gateway's snapshot comes from the nodes table of THAT source", async () => {
    getNodeMock.mockImplementation(async (nodeNum: number, sourceId?: string) => {
      if (nodeNum === GATEWAY_1_NUM && sourceId === SOURCE_A) {
        return {
          latitude: 40.1,
          longitude: -76.2,
          positionOverrideEnabled: false,
          latitudeOverride: null,
          longitudeOverride: null,
        };
      }
      return null;
    });

    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await vi.waitFor(() => expect(recordReceptionMock).toHaveBeenCalledTimes(1));

    expect(recordReceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ receiverLatitude: 40.1, receiverLongitude: -76.2 }),
    );
    expect(getNodeMock).toHaveBeenCalledWith(GATEWAY_1_NUM, SOURCE_A);
  });

  it('a gateway with no node row records null coordinates rather than skipping', async () => {
    getNodeMock.mockResolvedValue(null);

    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await vi.waitFor(() => expect(recordReceptionMock).toHaveBeenCalledTimes(1));

    expect(recordReceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ receiverLatitude: null, receiverLongitude: null }),
    );
  });

  it('a geo-out fix records nothing', async () => {
    // No filter passed => classifyPosition returns 'no-geo' by default; use a
    // bogus (0,0) fix instead to exercise the "never records a fix the node
    // table refused" gate — geo-ignore itself is covered by the pre-existing
    // MQTT Geo-Ignore epic tests. See "a bogus fix" case below for the
    // canonical "never reaches the hook" proof shared by both gates.
    positionPayload = { latitudeI: 0, longitudeI: 0 };
    const result = await ingest(SOURCE_A, envFor(GATEWAY_1));
    expect(result.ingested).toBe(true); // bogus fix still refreshes lastHeard
    await new Promise((r) => setTimeout(r, 20));
    expect(recordReceptionMock).not.toHaveBeenCalled();
  });

  it('an ignored sender records nothing', async () => {
    isIgnoredCachedMock.mockReturnValue(true);
    const result = await ingest(SOURCE_A, envFor(GATEWAY_1));
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('ignored');
    await new Promise((r) => setTimeout(r, 20));
    expect(recordReceptionMock).not.toHaveBeenCalled();
  });

  it('a distance-dropped fix records nothing', async () => {
    applyInlineDistanceCheckMock.mockResolvedValue('deleted');
    const result = await ingest(SOURCE_A, envFor(GATEWAY_1));
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('distance');
    await new Promise((r) => setTimeout(r, 20));
    expect(recordReceptionMock).not.toHaveBeenCalled();
  });

  it('a repo throw never changes the ingest result or skips the node upsert', async () => {
    recordReceptionMock.mockRejectedValueOnce(new Error('db unavailable'));

    const result = await ingest(SOURCE_A, envFor(GATEWAY_1));
    expect(result.ingested).toBe(true);
    await vi.waitFor(() => expect(recordReceptionMock).toHaveBeenCalledTimes(1));
    expect(upsertNodeAsyncMock).toHaveBeenCalled();
  });

  it('never emits on dataEventEmitter', async () => {
    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await vi.waitFor(() => expect(recordReceptionMock).toHaveBeenCalledTimes(1));
    expect(emitCalls).toEqual([]);
  });

  it('a settings flip takes effect after invalidateCoverageMqttEnabled, with no restart', async () => {
    enabledSources[SOURCE_A] = false;
    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await new Promise((r) => setTimeout(r, 20));
    expect(recordReceptionMock).not.toHaveBeenCalled();

    enabledSources[SOURCE_A] = true;
    invalidateCoverageMqttEnabled(SOURCE_A);

    await ingest(SOURCE_A, envFor(GATEWAY_1, { id: 0x12345679 }));
    await vi.waitFor(() => expect(recordReceptionMock).toHaveBeenCalledTimes(1));
  });

  it('per-source: source B stays off while source A is on for the same envelope shape', async () => {
    enabledSources = { [SOURCE_A]: true, [SOURCE_B]: false };

    await ingest(SOURCE_A, envFor(GATEWAY_1));
    await ingest(SOURCE_B, envFor(GATEWAY_1, { id: 0x22222222 }));

    await vi.waitFor(() => expect(recordReceptionMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(recordReceptionMock).toHaveBeenCalledTimes(1);
    expect(recordReceptionMock).toHaveBeenCalledWith(expect.objectContaining({ sourceId: SOURCE_A }));
  });
});
