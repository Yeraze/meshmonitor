/**
 * Tests for the Coverage Report RF-reception recording hook (#5277 Phase 1
 * WP2): `maybeRecordCoverageReception()`, called non-blocking from
 * `processPositionMessageProtobuf` for every position packet. Records one
 * row per (packet, path, receiver) into `coverage_receptions` via
 * `databaseService.coverageReceptions.recordReception()`.
 *
 * Modelled on `meshtasticManager.heardReflood.test.ts`: the private method
 * is called directly (bypassing the full `processMeshPacket` pipeline) so
 * the guard predicate and value derivation can be exercised in isolation,
 * matching how `maybeRecordHeardReflood` is tested.
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

const { recordReceptionMock, getNodeMock, upsertNodeAsyncMock } = vi.hoisted(() => ({
  recordReceptionMock: vi.fn().mockResolvedValue(true),
  getNodeMock: vi.fn().mockResolvedValue(null),
  upsertNodeAsyncMock: vi.fn().mockResolvedValue(undefined),
}));

// Every dataEventEmitter method call is recorded here regardless of name, so
// "no coverage emit" can be asserted without hardcoding one method name.
const emitCalls: Array<{ method: string; args: unknown[] }> = [];

// Mirrors the mocking shape used by meshtasticManager.heardReflood.test.ts —
// just enough of DatabaseService for a manager to construct.
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
      recordHeardRepeater: vi.fn().mockResolvedValue({}),
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
      get: (_target, prop: string) => (...args: unknown[]) => {
        emitCalls.push({ method: prop, args });
      },
    },
  ),
}));

// Stub packet-log service — isEnabled() false throughout.
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
const SENDER_NODE_NUM = 0x55667788;
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

function makeManagerNoLocalNode(): MeshtasticManager {
  return new MeshtasticManager(SOURCE_ID, { host: '127.0.0.1', port: 4403 });
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** A position-carrying packet with genuine RF-reception markers. */
function rfPacket(overrides: Record<string, any> = {}) {
  return {
    from: SENDER_NODE_NUM,
    id: PACKET_ID,
    to: 0xffffffff,
    channel: 0,
    relayNode: 0x42,
    rxSnr: -5.5,
    rxRssi: -80,
    hopStart: 3,
    hopLimit: 2,
    transportMechanism: TransportMechanism.LORA,
    viaMqtt: false,
    rxTime: nowSec(),
    decoded: { bitfield: 1 },
    ...overrides,
  };
}

const COORDS = { latitude: 40.0, longitude: -75.0 };
const POSITION = { altitude: 100 };
const PRECISION_BITS = 16;
const CHANNEL_INDEX = 0;

async function callHook(
  mgr: MeshtasticManager,
  packetOverrides: Record<string, any> = {},
  context?: any,
) {
  const packet = rfPacket(packetOverrides);
  return (mgr as any).maybeRecordCoverageReception(
    packet,
    COORDS,
    POSITION,
    PRECISION_BITS,
    CHANNEL_INDEX,
    context,
  );
}

describe('MeshtasticManager — Coverage Report RF-reception recording hook (#5277 P1 WP2)', () => {
  beforeEach(() => {
    recordReceptionMock.mockClear();
    recordReceptionMock.mockResolvedValue(true);
    getNodeMock.mockClear();
    getNodeMock.mockResolvedValue({
      nodeNum: LOCAL_NODE_NUM,
      latitude: 39.9,
      longitude: -75.1,
      positionOverrideEnabled: false,
      latitudeOverride: null,
      longitudeOverride: null,
    });
    upsertNodeAsyncMock.mockClear();
    emitCalls.length = 0;
  });

  it('records the full payload for a genuine RF reception', async () => {
    const mgr = makeManager();
    await callHook(mgr);

    expect(recordReceptionMock).toHaveBeenCalledTimes(1);
    expect(recordReceptionMock).toHaveBeenCalledWith({
      sourceId: SOURCE_ID,
      protocol: 'meshtastic',
      receiverKind: 'local',
      receiverId: `!${LOCAL_NODE_NUM.toString(16).padStart(8, '0')}`,
      receiverNodeNum: LOCAL_NODE_NUM,
      receiverLatitude: 39.9,
      receiverLongitude: -75.1,
      senderId: `!${SENDER_NODE_NUM.toString(16).padStart(8, '0')}`,
      senderNodeNum: SENDER_NODE_NUM,
      packetKey: String(PACKET_ID),
      packetId: PACKET_ID,
      pathKey: 'r66:h1', // relayNode 0x42=66, hopsAway = hopStart(3)-hopLimit(2)=1
      latitude: COORDS.latitude,
      longitude: COORDS.longitude,
      altitude: 100,
      precisionBits: PRECISION_BITS,
      snr: -5.5,
      rssi: -80,
      hopStart: 3,
      hopLimit: 2,
      hopsAway: 1,
      relayNode: 0x42,
      transportMechanism: TransportMechanism.LORA,
      channel: CHANNEL_INDEX,
      rxTime: expect.any(Number),
      receivedAt: expect.any(Number),
    });
  });

  describe('skip cases', () => {
    it('does not record when there is no local node yet', async () => {
      const mgr = makeManagerNoLocalNode();
      await callHook(mgr);
      expect(recordReceptionMock).not.toHaveBeenCalled();
    });

    it('does not record our own position (from == local node)', async () => {
      const mgr = makeManager();
      await callHook(mgr, { from: LOCAL_NODE_NUM });
      expect(recordReceptionMock).not.toHaveBeenCalled();
    });

    it('does not record when viaMqtt is true', async () => {
      const mgr = makeManager();
      await callHook(mgr, { viaMqtt: true });
      expect(recordReceptionMock).not.toHaveBeenCalled();
    });

    it('does not record an MQTT-transport packet', async () => {
      const mgr = makeManager();
      await callHook(mgr, { transportMechanism: TransportMechanism.MQTT });
      expect(recordReceptionMock).not.toHaveBeenCalled();
    });

    it('does not record a Multicast UDP packet', async () => {
      const mgr = makeManager();
      await callHook(mgr, { transportMechanism: TransportMechanism.MULTICAST_UDP });
      expect(recordReceptionMock).not.toHaveBeenCalled();
    });

    it('does not record a Store & Forward replay', async () => {
      const mgr = makeManager();
      await callHook(mgr, {}, { viaStoreForward: true });
      expect(recordReceptionMock).not.toHaveBeenCalled();
    });

    it('does not record a Virtual Node request-originated packet', async () => {
      const mgr = makeManager();
      await callHook(mgr, {}, { virtualNodeRequestId: 42 });
      expect(recordReceptionMock).not.toHaveBeenCalled();
    });

    it('does not record when packetId is 0', async () => {
      const mgr = makeManager();
      await callHook(mgr, { id: 0 });
      expect(recordReceptionMock).not.toHaveBeenCalled();
    });

    it('does not record when packetId is missing', async () => {
      const mgr = makeManager();
      await callHook(mgr, { id: undefined });
      expect(recordReceptionMock).not.toHaveBeenCalled();
    });

    it('does not record when rxTime is 11 minutes old (stale replay)', async () => {
      const mgr = makeManager();
      await callHook(mgr, { rxTime: nowSec() - 11 * 60 });
      expect(recordReceptionMock).not.toHaveBeenCalled();
    });
  });

  describe('value derivation', () => {
    it('keeps an explicit 0 RSSI', async () => {
      const mgr = makeManager();
      await callHook(mgr, { rxRssi: 0 });
      expect(recordReceptionMock).toHaveBeenCalledWith(expect.objectContaining({ rssi: 0 }));
    });

    it('normalizes SNR -128 (the firmware "no SNR" sentinel) to null', async () => {
      const mgr = makeManager();
      await callHook(mgr, { rxSnr: -128 });
      expect(recordReceptionMock).toHaveBeenCalledWith(expect.objectContaining({ snr: null }));
    });

    it('a true zero-hop packet (0/0 with a wire-present bitfield) records hopsAway 0, pathKey r0:h0', async () => {
      const mgr = makeManager();
      await callHook(mgr, { hopStart: 0, hopLimit: 0, relayNode: 0, decoded: { bitfield: 0 } });
      expect(recordReceptionMock).toHaveBeenCalledWith(
        expect.objectContaining({ hopsAway: 0, pathKey: 'r0:h0' }),
      );
    });

    it('the same 0/0 packet WITHOUT a bitfield records hopsAway null', async () => {
      const mgr = makeManager();
      await callHook(mgr, { hopStart: 0, hopLimit: 0, relayNode: 0, decoded: {} });
      expect(recordReceptionMock).toHaveBeenCalledWith(
        expect.objectContaining({ hopsAway: null, pathKey: 'r0:h-' }),
      );
    });

    it('the same packet heard via two different relays gives two calls with different pathKeys', async () => {
      const mgr = makeManager();
      await callHook(mgr, { relayNode: 0x11 });
      await callHook(mgr, { relayNode: 0x22 });

      expect(recordReceptionMock).toHaveBeenCalledTimes(2);
      const pathKeys = recordReceptionMock.mock.calls.map((call: any[]) => call[0].pathKey);
      expect(pathKeys[0]).not.toBe(pathKeys[1]);
    });
  });

  it('swallows a repository failure without throwing (never breaks the RX path)', async () => {
    const mgr = makeManager();
    recordReceptionMock.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(callHook(mgr)).resolves.toBeUndefined();
    expect(recordReceptionMock).toHaveBeenCalledTimes(1);
  });

  it('never emits on dataEventEmitter', async () => {
    const mgr = makeManager();
    await callHook(mgr);
    expect(emitCalls).toEqual([]);
  });

  describe('refreshCoverageReceiverPos caching (60s)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not call the node lookup again for a second reception within 60s', async () => {
      const mgr = makeManager();
      await callHook(mgr);
      await callHook(mgr, { id: PACKET_ID + 1 });

      expect(getNodeMock).toHaveBeenCalledTimes(1);
      expect(recordReceptionMock).toHaveBeenCalledTimes(2);
    });

    it('calls the node lookup again once the 60s cache has expired', async () => {
      const mgr = makeManager();
      await callHook(mgr);

      vi.setSystemTime(new Date('2024-01-01T00:01:01.000Z')); // +61s
      await callHook(mgr, { id: PACKET_ID + 1 });

      expect(getNodeMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the previous cached position on a lookup failure, and still records the reception', async () => {
      const mgr = makeManager();
      await callHook(mgr);
      expect(recordReceptionMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ receiverLatitude: 39.9, receiverLongitude: -75.1 }),
      );

      vi.setSystemTime(new Date('2024-01-01T00:01:01.000Z')); // +61s, cache expired
      getNodeMock.mockRejectedValueOnce(new Error('db unavailable'));
      await callHook(mgr, { id: PACKET_ID + 1 });

      expect(getNodeMock).toHaveBeenCalledTimes(2);
      expect(recordReceptionMock).toHaveBeenCalledTimes(2);
      // Lookup failed, so the stale 39.9/-75.1 snapshot from the first call
      // is kept — and the reception is still recorded with it, never dropped.
      expect(recordReceptionMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ receiverLatitude: 39.9, receiverLongitude: -75.1 }),
      );
    });
  });
});
