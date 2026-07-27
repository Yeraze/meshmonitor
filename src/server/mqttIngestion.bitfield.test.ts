/**
 * Regression guard for §2(b) of MQTT_OK_TO_MQTT_PHASE1_SPEC.md (#4114):
 * `Data.bitfield` must survive `ingestServiceEnvelopeInner`'s server-side
 * decrypt path (`mqttIngestion.ts` ~:190-205), which synthesizes
 * `packet.decoded` from `channelDecryptionService.tryDecrypt(...)`.
 *
 * Before this change the synthesized `decoded` object dropped `bitfield`
 * even though `DecryptionResult.bitfield` already carried it — which meant
 * `detectOkToMqttViolation` (and the uplink evaluator) could never see the
 * originator's `ok_to_mqtt` bit for any encrypted MQTT reception. This file
 * proves the bit is (a) mutated onto the input envelope in place and (b)
 * visible on the row handed to `mqttPacketLogService.logEnvelope`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const settingsStore: Record<string, string> = {};

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: vi.fn(async () => undefined),
    nodes: {
      getNode: vi.fn(async () => null),
      getNodesByNums: vi.fn(async () => new Map()),
      upsertNode: vi.fn(async () => undefined),
    },
    ignoredNodes: {
      isIgnoredCached: vi.fn(() => false),
      addGeoIgnoreAsync: vi.fn(async () => true),
      liftGeoIgnoreAsync: vi.fn(async () => false),
    },
    messages: {
      getMessage: vi.fn(async () => null),
      insertMessage: vi.fn(async (_msg: any, _sourceId?: string) => true),
    },
    channelDatabase: {
      findOrCreateByNameAndHashAsync: vi.fn(async () => undefined),
      getEnabledAsync: vi.fn(async () => []),
    },
    getSettingAsync: vi.fn(async (key: string) => settingsStore[key] ?? null),
    mqttPacketLog: {
      insertPacket: vi.fn(async () => undefined),
    },
    mqttOkToMqttViolations: {
      insertViolation: vi.fn(async () => undefined),
    },
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

// Mock the decryption service directly rather than exercising real AES —
// this file's job is to prove `bitfield` survives the synthesis step in
// mqttIngestion.ts, not to re-test decryption itself (covered elsewhere).
const tryDecryptMock = vi.fn();
vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: {
    isEnabled: vi.fn(() => true),
    tryDecrypt: (...args: any[]) => tryDecryptMock(...args),
  },
}));

import { ingestServiceEnvelope, _resetMqttIngestCachesForTest } from './mqttIngestion.js';
import type { ServiceEnvelopeShape } from './mqttPacketFilter.js';
import databaseService from '../services/database.js';
import mqttPacketLogService from './services/mqttPacketLogService.js';

const NODE_A = 0x11111111;

function encryptedEnvelope(): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId: '!00000001',
    packet: {
      id: 0x12345678,
      from: NODE_A,
      to: 0xffffffff,
      channel: 8,
      encrypted: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    },
  };
}

/** Flush the microtask + one macrotask boundary so the fire-and-forget logEnvelope() write lands. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('mqttIngestion — bitfield survives server-side decrypt (#4114 §2(b))', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMqttIngestCachesForTest();
    for (const key of Object.keys(settingsStore)) delete settingsStore[key];
    settingsStore['mqtt_packet_log_enabled'] = '1';
    mqttPacketLogService.resetEnabledCache();
    mqttPacketLogService.resetViolationEnabledCache();
  });

  it('propagates decrypt-result bitfield=0 onto packet.decoded and the logged row', async () => {
    tryDecryptMock.mockResolvedValue({
      success: true,
      portnum: 1,
      payload: new TextEncoder().encode('hello'),
      bitfield: 0,
      channelDatabaseId: 1,
    });
    const envelope = encryptedEnvelope();

    const result = await ingestServiceEnvelope({ sourceId: 'bridge-1', envelope });
    expect(result.ingested).toBe(true);
    // Mutated onto the input envelope in place.
    expect(envelope.packet?.decoded?.bitfield).toBe(0);

    await flush();
    expect(databaseService.mqttPacketLog.insertPacket).toHaveBeenCalledTimes(1);
    const row = (databaseService.mqttPacketLog.insertPacket as any).mock.calls[0][0];
    expect(row.bitfield).toBe(0);
  });

  it('propagates decrypt-result bitfield=1 onto packet.decoded and the logged row', async () => {
    tryDecryptMock.mockResolvedValue({
      success: true,
      portnum: 1,
      payload: new TextEncoder().encode('hello'),
      bitfield: 1,
      channelDatabaseId: 1,
    });
    const envelope = encryptedEnvelope();

    const result = await ingestServiceEnvelope({ sourceId: 'bridge-1', envelope });
    expect(result.ingested).toBe(true);
    expect(envelope.packet?.decoded?.bitfield).toBe(1);

    await flush();
    const row = (databaseService.mqttPacketLog.insertPacket as any).mock.calls[0][0];
    expect(row.bitfield).toBe(1);
  });

  it('row.bitfield is null when the decrypt result omits bitfield', async () => {
    tryDecryptMock.mockResolvedValue({
      success: true,
      portnum: 1,
      payload: new TextEncoder().encode('hello'),
      channelDatabaseId: 1,
      // bitfield intentionally omitted
    });
    const envelope = encryptedEnvelope();

    const result = await ingestServiceEnvelope({ sourceId: 'bridge-1', envelope });
    expect(result.ingested).toBe(true);
    expect(envelope.packet?.decoded?.bitfield).toBeUndefined();

    await flush();
    const row = (databaseService.mqttPacketLog.insertPacket as any).mock.calls[0][0];
    expect(row.bitfield).toBeNull();
  });

  it('plaintext path (already-decoded packet, no decrypt) carries the wire bitfield through untouched', async () => {
    const envelope: ServiceEnvelopeShape = {
      channelId: 'LongFast',
      gatewayId: '!00000001',
      packet: {
        id: 0x12345678,
        from: NODE_A,
        to: 0xffffffff,
        channel: 8,
        decoded: {
          portnum: 1,
          payload: new TextEncoder().encode('hello'),
          bitfield: 1,
        },
      },
    };

    const result = await ingestServiceEnvelope({ sourceId: 'bridge-1', envelope });
    expect(result.ingested).toBe(true);
    // tryDecrypt must not even be called on the plaintext path.
    expect(tryDecryptMock).not.toHaveBeenCalled();
    expect(envelope.packet?.decoded?.bitfield).toBe(1);

    await flush();
    const row = (databaseService.mqttPacketLog.insertPacket as any).mock.calls[0][0];
    expect(row.bitfield).toBe(1);
  });
});
