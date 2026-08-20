/**
 * Tests for the Meshtastic "Heard-By" re-flood ingest hook (issue #4816,
 * Phase 4 WP2).
 *
 * A re-flood is our OWN outgoing channel packet, rebroadcast by a neighbour
 * and overheard back by us — the exact inverse of the local-node spoof case
 * (#2584): `from == localNode`, RF markers present, but the packet `id` IS
 * one we recently originated (`sentPacketIds`), so it's a benign echo, not an
 * impersonation. `maybeRecordHeardReflood()` records that echo (relay byte +
 * SNR) via `databaseService.meshtasticHeardRepeaters.recordHeardRepeater()`
 * so the Delivery Details modal can surface it — independent of whether
 * packet logging is enabled (see meshtasticHeardRepeaters repo header).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransportMechanism } from './constants/meshtastic.js';

// Stub the TCP transport so constructing a manager never touches a real socket
vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    isConnected = () => true;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

const { recordHeardRepeaterMock, getNodeMock, upsertNodeAsyncMock } = vi.hoisted(() => ({
  recordHeardRepeaterMock: vi.fn().mockResolvedValue({}),
  getNodeMock: vi.fn().mockResolvedValue(null),
  upsertNodeAsyncMock: vi.fn().mockResolvedValue(undefined),
}));

// Mirrors the mocking shape used by meshtasticManager.mqttProxyDedup.test.ts —
// just enough of DatabaseService for a manager to construct and for
// processMeshPacket's node-extraction path to run without touching a real DB.
vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    upsertNodeAsync: upsertNodeAsyncMock,
    sources: {
      getSource: vi.fn().mockResolvedValue(null),
    },
    nodes: {
      getNode: getNodeMock,
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
      updateNodeMessageHops: vi.fn().mockResolvedValue(undefined),
    },
    telemetry: {
      insertTelemetry: vi.fn().mockResolvedValue(undefined),
    },
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
    meshtasticHeardRepeaters: {
      recordHeardRepeater: recordHeardRepeaterMock,
    },
  };
  return { default: shared, databaseService: shared };
});

// Stub packet-log service — isEnabled() false throughout, exactly the
// scenario the hook must keep working under (it lives outside this gate).
vi.mock('./services/packetLogService.js', () => {
  const svc = { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() };
  return { default: svc, packetLogService: svc };
});
vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: { isEnabled: () => false, tryDecrypt: vi.fn() },
}));
vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    getPortNumName: (n: number) => `PORT_${n}`,
    normalizePortNum: (n: any) => (typeof n === 'number' ? n : 0),
    processPayload: vi.fn(),
  };
  return { default: svc, meshtasticProtobufService: svc };
});

import { MeshtasticManager } from './meshtasticManager.js';

const SOURCE_ID = 'src-1';
const LOCAL_NODE_NUM = 0x11223344;
const PACKET_ID = 0xaabbccdd;

function makeManager(): MeshtasticManager {
  const mgr = new MeshtasticManager(SOURCE_ID, { host: '127.0.0.1', port: 4403 });
  (mgr as any).localNodeInfo = {
    nodeNum: LOCAL_NODE_NUM,
    nodeId: `!${LOCAL_NODE_NUM.toString(16)}`,
    longName: 'Local Node',
    shortName: 'LOCL',
  };
  return mgr;
}

/** A packet that carries genuine RF-reception markers (arrived over the air). */
function rfReceivedPacket(overrides: Record<string, any> = {}) {
  return {
    from: LOCAL_NODE_NUM,
    id: PACKET_ID,
    to: 0xffffffff,
    channel: 0,
    relayNode: 0x42,
    rxSnr: -5.5,
    hopStart: 3,
    hopLimit: 2,
    transportMechanism: TransportMechanism.LORA,
    viaMqtt: false,
    ...overrides,
  };
}

/** A packet with NO RF markers at all — a genuine local transmission. */
function genuineLocalTxPacket(overrides: Record<string, any> = {}) {
  return {
    from: LOCAL_NODE_NUM,
    id: PACKET_ID,
    to: 0xffffffff,
    channel: 0,
    relayNode: 0x42,
    transportMechanism: TransportMechanism.INTERNAL,
    viaMqtt: false,
    ...overrides,
  };
}

describe('MeshtasticManager — Heard-By re-flood ingest hook (#4816 Phase 4 WP2)', () => {
  beforeEach(() => {
    recordHeardRepeaterMock.mockClear();
    recordHeardRepeaterMock.mockResolvedValue({});
    getNodeMock.mockClear();
    upsertNodeAsyncMock.mockClear();
  });

  describe('maybeRecordHeardReflood() guard predicate', () => {
    it('records a genuine re-flood: from==local, recently sent by us, RF markers, relay byte present', async () => {
      const mgr = makeManager();
      (mgr as any).sentPacketIds.record(PACKET_ID);
      const packet = rfReceivedPacket();

      const spoof = (mgr as any).assessLocalSpoof(packet);
      expect(spoof).toEqual({ isGenuineLocalTx: false, spoofSuspected: false });

      await (mgr as any).maybeRecordHeardReflood(packet, spoof);

      expect(recordHeardRepeaterMock).toHaveBeenCalledTimes(1);
      expect(recordHeardRepeaterMock).toHaveBeenCalledWith({
        sourceId: SOURCE_ID,
        messageId: `${SOURCE_ID}_${LOCAL_NODE_NUM}_${PACKET_ID}`,
        relayByte: 0x42,
        snr: -5.5,
        heardAt: expect.any(Number),
      });
    });

    it('does NOT record a spoof: from==local, RF markers, but NOT recently sent by us', async () => {
      const mgr = makeManager();
      // deliberately do not record PACKET_ID in sentPacketIds
      const packet = rfReceivedPacket();

      const spoof = (mgr as any).assessLocalSpoof(packet);
      expect(spoof.spoofSuspected).toBe(true);
      expect(spoof.isGenuineLocalTx).toBe(false);

      await (mgr as any).maybeRecordHeardReflood(packet, spoof);

      expect(recordHeardRepeaterMock).not.toHaveBeenCalled();
    });

    it('does NOT record a genuine local TX (isGenuineLocalTx=true)', async () => {
      const mgr = makeManager();
      (mgr as any).sentPacketIds.record(PACKET_ID);
      const packet = genuineLocalTxPacket();

      const spoof = (mgr as any).assessLocalSpoof(packet);
      expect(spoof.isGenuineLocalTx).toBe(true);

      await (mgr as any).maybeRecordHeardReflood(packet, spoof);

      expect(recordHeardRepeaterMock).not.toHaveBeenCalled();
    });

    it('does NOT record when relayNode is 0 (unknown relayer)', async () => {
      const mgr = makeManager();
      (mgr as any).sentPacketIds.record(PACKET_ID);
      const packet = rfReceivedPacket({ relayNode: 0 });

      const spoof = (mgr as any).assessLocalSpoof(packet);
      await (mgr as any).maybeRecordHeardReflood(packet, spoof);

      expect(recordHeardRepeaterMock).not.toHaveBeenCalled();
    });

    it('does NOT record when relayNode is absent (null/undefined)', async () => {
      const mgr = makeManager();
      (mgr as any).sentPacketIds.record(PACKET_ID);
      const packet = rfReceivedPacket({ relayNode: undefined });

      const spoof = (mgr as any).assessLocalSpoof(packet);
      await (mgr as any).maybeRecordHeardReflood(packet, spoof);

      expect(recordHeardRepeaterMock).not.toHaveBeenCalled();
    });

    it('does NOT record an MQTT-bridge echo of our own packet', async () => {
      const mgr = makeManager();
      (mgr as any).sentPacketIds.record(PACKET_ID);
      const packet = rfReceivedPacket({ viaMqtt: true, transportMechanism: TransportMechanism.MQTT });

      const spoof = (mgr as any).assessLocalSpoof(packet);
      await (mgr as any).maybeRecordHeardReflood(packet, spoof);

      expect(recordHeardRepeaterMock).not.toHaveBeenCalled();
    });

    it('swallows a recordHeardRepeater failure without throwing', async () => {
      const mgr = makeManager();
      (mgr as any).sentPacketIds.record(PACKET_ID);
      recordHeardRepeaterMock.mockRejectedValueOnce(new Error('db unavailable'));
      const packet = rfReceivedPacket();

      const spoof = (mgr as any).assessLocalSpoof(packet);
      await expect((mgr as any).maybeRecordHeardReflood(packet, spoof)).resolves.toBeUndefined();

      expect(recordHeardRepeaterMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('sent-id <-> re-flood-id linkage', () => {
    it('the id recorded via sentPacketIds.record() at send time is the same id that identifies the re-flood', async () => {
      const mgr = makeManager();
      // Mirrors the send path (meshtasticManager.ts ~L9561): the outgoing
      // packet's protobuf `id` is what gets recorded into sentPacketIds.
      const outgoingMessageId = PACKET_ID;
      (mgr as any).sentPacketIds.record(outgoingMessageId);

      // A re-flood echoes that exact id back as MeshPacket.id.
      const reflood = rfReceivedPacket({ id: outgoingMessageId });
      expect((mgr as any).sentPacketIds.has(reflood.id)).toBe(true);

      const spoof = (mgr as any).assessLocalSpoof(reflood);
      await (mgr as any).maybeRecordHeardReflood(reflood, spoof);

      // messageId format `${sourceId}_${fromNum}_${packetId}` matches the
      // sent message's row id `${sourceId}_${localNodeNum}_${messageId}`
      // (meshtasticManager.ts ~L9606) exactly when fromNum === localNodeNum
      // and packetId === the id we originated.
      expect(recordHeardRepeaterMock).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: `${SOURCE_ID}_${LOCAL_NODE_NUM}_${outgoingMessageId}`,
        }),
      );
    });
  });

  describe('processMeshPacket() integration — hook fires outside the packet-log gate', () => {
    it('records the re-flood even though packet_log_enabled resolves false', async () => {
      const mgr = makeManager();
      (mgr as any).sentPacketIds.record(PACKET_ID);
      const packet = rfReceivedPacket();

      // Drive the real RX entry point directly (packetLogService.isEnabled()
      // is mocked false for this whole suite — see the vi.mock above).
      await (mgr as any).processMeshPacket(packet);

      expect(recordHeardRepeaterMock).toHaveBeenCalledTimes(1);
      expect(recordHeardRepeaterMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: SOURCE_ID,
          messageId: `${SOURCE_ID}_${LOCAL_NODE_NUM}_${PACKET_ID}`,
          relayByte: 0x42,
          snr: -5.5,
        }),
      );
      // Packet processing continued normally past the hook (node upsert ran).
      expect(upsertNodeAsyncMock).toHaveBeenCalled();
    });
  });
});
