/**
 * Ingestion-hook tests for the MQTT Packet Monitor.
 *
 * Drives the real `ingestServiceEnvelope` wrapper (exported from
 * `mqttIngestion.ts`) and asserts it logs every gateway copy exactly once,
 * with the correct `ingestOutcome`/`encrypted`/`decryptedBy`, via
 * `databaseService.mqttPacketLog.insertPacket`. The write is fire-and-forget
 * (`void mqttPacketLogService.logEnvelope(...)`), so every assertion awaits
 * a flush of the pending microtasks first.
 *
 * See docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE1_SPEC.md §4.5.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const settingsStore: Record<string, string> = {};

vi.mock('../services/database.js', () => ({
  default: {
    upsertNode: vi.fn(),
    upsertNodeAsync: vi.fn(async () => undefined),
    insertMessage: vi.fn(),
    insertTelemetry: vi.fn(),
    insertTelemetryAsync: vi.fn(async () => undefined),
    insertTraceroute: vi.fn(),
    insertTracerouteAsync: vi.fn(async () => undefined),
    insertRouteSegment: vi.fn(),
    insertRouteSegmentAsync: vi.fn(async () => undefined),
    nodes: {
      getNode: vi.fn(async () => null),
      getNodesByNums: vi.fn(async () => new Map()),
      upsertNode: vi.fn(async () => undefined),
    },
    neighbors: {
      deleteNeighborInfoForNode: vi.fn(async () => undefined),
      insertNeighborInfoBatch: vi.fn(async () => undefined),
    },
    messages: {
      getMessage: vi.fn(async () => null),
      insertMessage: vi.fn(async (_msg: any, _sourceId?: string) => true),
    },
    channels: {
      upsertChannel: vi.fn(async () => undefined),
    },
    channelDatabase: {
      findOrCreatePassiveByNameAsync: vi.fn(async () => undefined),
      findOrCreateByNameAndHashAsync: vi.fn(async () => undefined),
      // Used by channelDecryptionService's cache refresh — empty by
      // default so decryption fails closed unless a test seeds a channel.
      getEnabledAsync: vi.fn(async () => []),
      incrementDecryptedCountAsync: vi.fn(async () => undefined),
    },
    getSettingAsync: vi.fn(async (key: string) => settingsStore[key] ?? null),
    mqttPacketLog: {
      insertPacket: vi.fn(async () => undefined),
    },
    // Geo-ignore epic (#4115): the ingest pipeline gates on the per-source
    // ignore list and auto-ignores out-of-bbox positions.
    ignoredNodes: {
      isIgnoredCached: vi.fn(() => false),
      addGeoIgnoreAsync: vi.fn(async () => true),
      liftGeoIgnoreAsync: vi.fn(async () => true),
    },
    deleteNodeAsync: vi.fn(async () => undefined),
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn((portnum: number, payload: Uint8Array) => {
      if (portnum === 1 /* TEXT_MESSAGE_APP */) {
        return new TextDecoder('utf-8').decode(payload);
      }
      return null;
    }),
    getPortNumName: vi.fn((portnum: number) => (portnum === 1 ? 'TEXT_MESSAGE_APP' : `UNKNOWN_${portnum}`)),
  },
}));

vi.mock('./protobufLoader.js', () => ({
  getProtobufRoot: vi.fn(() => null),
}));

import { ingestServiceEnvelope, _resetMqttIngestCachesForTest } from './mqttIngestion.js';
import { MqttPacketFilter, type ServiceEnvelopeShape } from './mqttPacketFilter.js';
import databaseService from '../services/database.js';
import { channelDecryptionService } from './services/channelDecryptionService.js';
import mqttPacketLogService from './services/mqttPacketLogService.js';
import * as protobufLoader from './protobufLoader.js';
import { PortNum } from './constants/meshtastic.js';

const NODE_A = 0x11111111;

function envFor(overrides: Partial<{
  from: number;
  portnum: number;
  gatewayId: string;
  encrypted: Uint8Array;
  decoded: { portnum: number; payload: Uint8Array; emoji?: number; replyId?: number };
  id: number;
}> = {}): ServiceEnvelopeShape {
  const { from = NODE_A, portnum, gatewayId = '!00000001', encrypted, id = 0x12345678 } = overrides;
  const decoded =
    overrides.decoded !== undefined
      ? overrides.decoded
      : encrypted
        ? undefined
        : { portnum: portnum ?? 1, payload: new TextEncoder().encode('hello world') };
  return {
    channelId: 'LongFast',
    gatewayId,
    packet: {
      id,
      from,
      to: 0xffffffff,
      channel: 8,
      ...(decoded ? { decoded } : {}),
      ...(encrypted ? { encrypted } : {}),
    },
  };
}

/** Flush the microtask + one macrotask boundary so the fire-and-forget logEnvelope() write lands. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('MQTT Packet Monitor — ingestion hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does not remove implementations set via mockReturnValue —
    // re-pin the ignore gate to "not ignored" so per-test overrides don't leak.
    (databaseService.ignoredNodes.isIgnoredCached as any).mockReturnValue(false);
    _resetMqttIngestCachesForTest();
    channelDecryptionService.invalidateCache();
    channelDecryptionService.setEnabled(true);
    for (const key of Object.keys(settingsStore)) delete settingsStore[key];
    settingsStore['mqtt_packet_log_enabled'] = '1';
    mqttPacketLogService.resetEnabledCache();
  });

  it('logs an ingested TEXT_MESSAGE_APP copy with the right fields', async () => {
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor({ portnum: 1, gatewayId: '!00000001' }),
    });
    expect(result.ingested).toBe(true);

    await flush();
    expect(databaseService.mqttPacketLog.insertPacket).toHaveBeenCalledTimes(1);
    const row = (databaseService.mqttPacketLog.insertPacket as any).mock.calls[0][0];
    expect(row.ingestOutcome).toBe('ingested');
    expect(row.encrypted).toBe(0);
    expect(row.portnumName).toBe('TEXT_MESSAGE_APP');
    expect(row.payloadPreview).toBe('hello world');
    expect(row.sourceId).toBe('bridge-1');
    expect(row.gatewayId).toBe('!00000001');
  });

  it('logs an encrypted, undecryptable copy as ingestOutcome=encrypted', async () => {
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor({ encrypted: new Uint8Array([9, 9, 9, 9]) }),
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('encrypted');

    await flush();
    expect(databaseService.mqttPacketLog.insertPacket).toHaveBeenCalledTimes(1);
    const row = (databaseService.mqttPacketLog.insertPacket as any).mock.calls[0][0];
    expect(row.ingestOutcome).toBe('encrypted');
    expect(row.encrypted).toBe(1);
    expect(row.decryptedBy).toBeNull();
    expect(row.portnum).toBeNull();
  });

  it('logs an ignored-sender copy with portnum still populated (decode happened before the gate)', async () => {
    (databaseService.ignoredNodes.isIgnoredCached as any).mockReturnValue(true);
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor({ from: 0x22222222, portnum: 1 }), // ignored sender, non-position
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('ignored');

    await flush();
    expect(databaseService.mqttPacketLog.insertPacket).toHaveBeenCalledTimes(1);
    const row = (databaseService.mqttPacketLog.insertPacket as any).mock.calls[0][0];
    expect(row.ingestOutcome).toBe('ignored');
    expect(row.portnum).toBe(1);
  });

  it('logs a geo-ignored copy when an out-of-bbox POSITION triggers the auto-ignore', async () => {
    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => ({
      latitudeI: 492_000_000, // Vancouver — far outside the Ontario bbox below
      longitudeI: -1_230_000_000,
    }));
    const filter = new MqttPacketFilter({ geo: { minLat: 43, maxLat: 45, minLng: -80, maxLng: -77 } });
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor({ from: 0x22222222, portnum: PortNum.POSITION_APP }),
      filter,
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('geo-ignored');

    await flush();
    expect(databaseService.mqttPacketLog.insertPacket).toHaveBeenCalledTimes(1);
    const row = (databaseService.mqttPacketLog.insertPacket as any).mock.calls[0][0];
    expect(row.ingestOutcome).toBe('geo-ignored');
    expect(row.portnum).toBe(PortNum.POSITION_APP);
  });

  it('logs an unsupported-portnum copy', async () => {
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor({ portnum: 9999, decoded: { portnum: 9999, payload: new Uint8Array([1]) } }),
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('unsupported-portnum');

    await flush();
    expect(databaseService.mqttPacketLog.insertPacket).toHaveBeenCalledTimes(1);
    const row = (databaseService.mqttPacketLog.insertPacket as any).mock.calls[0][0];
    expect(row.ingestOutcome).toBe('unsupported-portnum');
  });

  it('logs a server-decrypted copy with decryptedBy=server and ingestOutcome=ingested', async () => {
    // Seed a channel_database row so channelDecryptionService's cache is non-empty.
    const psk = Buffer.from('0123456789abcdef').toString('base64'); // 16-byte AES-128 key
    (databaseService.channelDatabase.getEnabledAsync as any).mockResolvedValue([
      { id: 5, name: 'LongFast', psk, pskLength: 16, enforceNameValidation: false, sortOrder: 0 },
    ]);
    // Mock the protobuf root so isValidProtobuf() accepts the (real AES,
    // mocked-decode) "decrypted" bytes without needing a real Data-protobuf
    // ciphertext — only the decode step is faked, decryption itself is real.
    const mockDataType = { decode: vi.fn(() => ({ portnum: 1, payload: Buffer.from('decrypted!') })) };
    const mockRoot = { lookupType: vi.fn(() => mockDataType) };
    (protobufLoader.getProtobufRoot as any).mockReturnValue(mockRoot);

    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor({ encrypted: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }),
    });
    expect(result.ingested).toBe(true);

    await flush();
    expect(databaseService.mqttPacketLog.insertPacket).toHaveBeenCalledTimes(1);
    const row = (databaseService.mqttPacketLog.insertPacket as any).mock.calls[0][0];
    expect(row.ingestOutcome).toBe('ingested');
    expect(row.encrypted).toBe(1);
    expect(row.decryptedBy).toBe('server');
    expect(row.portnumName).toBe('TEXT_MESSAGE_APP');
  });

  it('logs one row per gateway for the same packet (multi-gateway)', async () => {
    const shared = { id: 0xabcdef01, from: NODE_A, portnum: PortNum.TEXT_MESSAGE_APP };
    await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor({ ...shared, gatewayId: '!11111111' }),
    });
    await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor({ ...shared, gatewayId: '!22222222' }),
    });

    await flush();
    expect(databaseService.mqttPacketLog.insertPacket).toHaveBeenCalledTimes(2);
    const calls = (databaseService.mqttPacketLog.insertPacket as any).mock.calls;
    const gatewayIds = calls.map((c: any[]) => c[0].gatewayId).sort();
    expect(gatewayIds).toEqual(['!11111111', '!22222222']);
    const gatewayNodeNums = calls.map((c: any[]) => c[0].gatewayNodeNum).sort((a: number, b: number) => a - b);
    expect(gatewayNodeNums).toEqual([0x11111111, 0x22222222]);
    // Same underlying packet on both rows.
    for (const c of calls) {
      expect(c[0].packetId).toBe(0xabcdef01);
      expect(c[0].fromNode).toBe(NODE_A);
    }
  });

  it('does not log when mqtt_packet_log_enabled is unset (disabled)', async () => {
    delete settingsStore['mqtt_packet_log_enabled'];
    mqttPacketLogService.resetEnabledCache();

    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor({ portnum: 1 }),
    });
    expect(result.ingested).toBe(true);

    await flush();
    expect(databaseService.mqttPacketLog.insertPacket).not.toHaveBeenCalled();
  });
});
