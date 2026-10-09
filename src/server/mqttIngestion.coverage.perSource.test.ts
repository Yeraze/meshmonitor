/**
 * Per-source isolation for the Coverage Report MQTT gateway-reception
 * recording hook (#5277 P2, §3, exit criterion: "opt-in off on source A
 * never records for source B").
 *
 * Like `mqttIngestion.perSource.test.ts`, this exercises the REAL singleton
 * `databaseService` against its `:memory:` SQLite backend — only per-source
 * isolation proven against real repository code, real `sourceId` scoping,
 * and a real settings table is meaningful here. Only `meshtasticProtobufService`
 * is mocked (protobuf decode isn't what's under test).
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

// In-bbox default POSITION payload — matches mqttIngestion.perSource.test.ts's
// ON_BBOX convention so no geo filter is even needed here.
vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn((portnum: number) => {
      if (portnum === 3 /* POSITION_APP */) {
        return { latitudeI: 399_000_000, longitudeI: -751_000_000, altitude: 100 };
      }
      return null;
    }),
  },
}));

import { ingestServiceEnvelope } from './mqttIngestion.js';
import { nodeNumToId, type ServiceEnvelopeShape } from './mqttPacketFilter.js';
import { __resetCoverageMqttCacheForTest } from './services/coverageMqttSettings.js';
import { __resetCoverageMqttPositionCacheForTest } from './utils/coverageMqtt.js';
import { COVERAGE_MQTT_ENABLED_SETTING } from '../utils/coverage.js';
import databaseService from '../services/database.js';

const SRC_A = 'coverage-ps-src-a';
const SRC_B = 'coverage-ps-src-b';
const FROM_NUM = 0x10500001;
const GATEWAY_NUM = 0x10500002;
const GATEWAY_ID = nodeNumToId(GATEWAY_NUM);

function envFor(gatewayId: string, packetId: number): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId,
    packet: {
      id: packetId,
      from: FROM_NUM,
      to: 0xffffffff,
      channel: 0,
      rxTime: Math.floor(Date.now() / 1000) - 5,
      rxSnr: -6,
      rxRssi: -85,
      hopStart: 3,
      hopLimit: 2,
      relayNode: 0x42,
      decoded: { portnum: 3 /* POSITION_APP */, payload: new Uint8Array([0]), bitfield: 1 },
    },
  };
}

describe('ingestServiceEnvelope — Coverage Report MQTT recording, per-source isolation (#5277 P2)', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
    await databaseService.sources.deleteSource(SRC_A).catch(() => {});
    await databaseService.sources.deleteSource(SRC_B).catch(() => {});
    await databaseService.sources.createSource({ id: SRC_A, name: 'Coverage PS A', type: 'mqtt_broker', config: {}, enabled: true });
    await databaseService.sources.createSource({ id: SRC_B, name: 'Coverage PS B', type: 'mqtt_broker', config: {}, enabled: true });

    // Opt-in ON for A, left unset (off) for B.
    await databaseService.settings.setSourceSetting(SRC_A, COVERAGE_MQTT_ENABLED_SETTING, '1');

    // A gateway node row for the SAME physical nodeNum on BOTH sources, with
    // DIFFERENT positions — proves the shared position cache is keyed by
    // (sourceId, nodeNum) and never leaks source B's snapshot into A's rows.
    await databaseService.upsertNodeAsync({
      nodeNum: GATEWAY_NUM,
      nodeId: GATEWAY_ID,
      longName: 'Gateway On A',
      shortName: 'GWA',
      hwModel: 1,
      latitude: 40.0,
      longitude: -76.0,
      lastHeard: Math.floor(Date.now() / 1000),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, SRC_A);
    await databaseService.upsertNodeAsync({
      nodeNum: GATEWAY_NUM,
      nodeId: GATEWAY_ID,
      longName: 'Gateway On B (must never be read by A)',
      shortName: 'GWB',
      hwModel: 1,
      latitude: 10.0,
      longitude: 10.0,
      lastHeard: Math.floor(Date.now() / 1000),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, SRC_B);
  });

  afterAll(async () => {
    await databaseService.coverageReceptions.deleteForSource(SRC_A).catch(() => {});
    await databaseService.coverageReceptions.deleteForSource(SRC_B).catch(() => {});
    await databaseService.sources.deleteSource(SRC_A).catch(() => {});
    await databaseService.sources.deleteSource(SRC_B).catch(() => {});
  });

  afterEach(() => {
    __resetCoverageMqttCacheForTest();
    __resetCoverageMqttPositionCacheForTest();
  });

  it('source A (opt-in on) records a row scoped to A, with A\'s own gateway snapshot', async () => {
    const packetId = 0xc0000001;
    const result = await ingestServiceEnvelope({ sourceId: SRC_A, envelope: envFor(GATEWAY_ID, packetId) });
    expect(result.ingested).toBe(true);

    await vi.waitFor(async () => {
      const page = await databaseService.coverageReceptions.getReceptions({
        sourceIds: [SRC_A],
        sinceMs: 0,
        untilMs: Date.now() + 1000,
        pageSize: 50,
      });
      expect(page.items.some((r) => r.packetId === packetId)).toBe(true);
    });

    const page = await databaseService.coverageReceptions.getReceptions({
      sourceIds: [SRC_A],
      sinceMs: 0,
      untilMs: Date.now() + 1000,
      pageSize: 50,
    });
    const row = page.items.find((r) => r.packetId === packetId);
    expect(row?.sourceId).toBe(SRC_A);
    expect(row?.receiverKind).toBe('mqtt_gateway');
    expect(row?.receiverId).toBe(GATEWAY_ID);
    // Must reflect A's OWN gateway snapshot (40.0/-76.0), never B's (10.0/10.0).
    expect(row?.receiverLatitude).toBe(40.0);
    expect(row?.receiverLongitude).toBe(-76.0);
  });

  it('source B (opt-in off) never records the same envelope shape', async () => {
    const packetId = 0xc0000002;
    const result = await ingestServiceEnvelope({ sourceId: SRC_B, envelope: envFor(GATEWAY_ID, packetId) });
    expect(result.ingested).toBe(true);

    // Give any stray fire-and-forget write a moment, then confirm nothing landed.
    await new Promise((r) => setTimeout(r, 50));
    const page = await databaseService.coverageReceptions.getReceptions({
      sourceIds: [SRC_B],
      sinceMs: 0,
      untilMs: Date.now() + 1000,
      pageSize: 50,
    });
    expect(page.items.some((r) => r.packetId === packetId)).toBe(false);
  });

  it('B never appears when reading only A\'s sourceIds, and vice versa', async () => {
    const packetIdA = 0xc0000003;
    const packetIdB = 0xc0000004;
    await ingestServiceEnvelope({ sourceId: SRC_A, envelope: envFor(GATEWAY_ID, packetIdA) });
    await ingestServiceEnvelope({ sourceId: SRC_B, envelope: envFor(GATEWAY_ID, packetIdB) });

    await vi.waitFor(async () => {
      const page = await databaseService.coverageReceptions.getReceptions({
        sourceIds: [SRC_A],
        sinceMs: 0,
        untilMs: Date.now() + 1000,
        pageSize: 50,
      });
      expect(page.items.some((r) => r.packetId === packetIdA)).toBe(true);
    });

    const onlyA = await databaseService.coverageReceptions.getReceptions({
      sourceIds: [SRC_A],
      sinceMs: 0,
      untilMs: Date.now() + 1000,
      pageSize: 50,
    });
    expect(onlyA.items.every((r) => r.sourceId === SRC_A)).toBe(true);
    expect(onlyA.items.some((r) => r.packetId === packetIdB)).toBe(false);
  });
});
