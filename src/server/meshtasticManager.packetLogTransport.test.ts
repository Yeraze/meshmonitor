/**
 * Tests for the RX packet_log transport_mechanism stamp (#5101 WP1 bug (b)).
 *
 * `processMeshPacket`'s RX `packetLogService.logPacket()` call used to stamp
 * `meshPacket.transportMechanism ?? TransportMechanism.LORA`, which silently
 * classified a packet with no explicit mechanism but `viaMqtt: true` as RF
 * (LORA), even though it arrived over the node's MQTT uplink. The fix routes
 * the value through `resolveRadioPacketTransport()` (already used by the
 * per-source-node transport stamp a few lines below, and by the TX writer)
 * so the packet_log RX write and the node transport stamp agree, while an
 * explicit mechanism value (including 0/INTERNAL) is still preserved.
 *
 * Template: meshtasticManager.heardReflood.test.ts — same minimal
 * `databaseService`/`tcpTransport`/`channelDecryptionService`/
 * `meshtasticProtobufService` mock shape, driving the real RX entry point
 * (`processMeshPacket`) directly. Unlike that suite, `packetLogService` is
 * mocked `isEnabled() -> true` here so the RX write actually runs, and
 * `logPacket` is the spy under test.
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

const { upsertNodeAsyncMock } = vi.hoisted(() => ({
  upsertNodeAsyncMock: vi.fn().mockResolvedValue(undefined),
}));

// Mirrors the mocking shape used by meshtasticManager.heardReflood.test.ts —
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
      getNode: vi.fn().mockResolvedValue(null),
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
  };
  return { default: shared, databaseService: shared };
});

// Enabled, unlike heardReflood.test.ts — this suite exercises the gated RX
// packet_log write. logPacket is the spy under test.
const { logPacketMock } = vi.hoisted(() => ({
  logPacketMock: vi.fn(),
}));
vi.mock('./services/packetLogService.js', () => {
  const svc = { isEnabled: vi.fn().mockResolvedValue(true), logPacket: logPacketMock };
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
// Deliberately NOT the local node — keeps shouldExcludeFromPacketLog and
// isPhantomInternalPacket (both gated on fromNum === localNodeNum) out of
// the way, so every case below reaches the packet_log write under test
// regardless of its transport_mechanism / viaMqtt combination.
const REMOTE_NODE_NUM = 0x22334455;

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

function basePacket(id: number, overrides: Record<string, any> = {}) {
  return {
    from: REMOTE_NODE_NUM,
    id,
    to: 0xffffffff,
    channel: 0,
    ...overrides,
  };
}

describe('MeshtasticManager — RX packet_log transport_mechanism stamp (#5101)', () => {
  beforeEach(() => {
    logPacketMock.mockClear();
    upsertNodeAsyncMock.mockClear();
  });

  function loggedTransportMechanism(): number | undefined {
    expect(logPacketMock).toHaveBeenCalledTimes(1);
    return logPacketMock.mock.calls[0][0].transport_mechanism;
  }

  it('stamps MQTT (5) for a packet with no explicit mechanism but viaMqtt=true', async () => {
    const mgr = makeManager();
    const packet = basePacket(0xaaaa0001, { transportMechanism: undefined, viaMqtt: true });

    await (mgr as any).processMeshPacket(packet);

    expect(loggedTransportMechanism()).toBe(TransportMechanism.MQTT);
    expect(TransportMechanism.MQTT).toBe(5);
  });

  it('stamps LoRa (1) for a packet with neither an explicit mechanism nor viaMqtt', async () => {
    const mgr = makeManager();
    const packet = basePacket(0xaaaa0002, { transportMechanism: undefined, viaMqtt: false });

    await (mgr as any).processMeshPacket(packet);

    expect(loggedTransportMechanism()).toBe(TransportMechanism.LORA);
    expect(TransportMechanism.LORA).toBe(1);
  });

  it('preserves an explicit INTERNAL (0) mechanism rather than defaulting to LoRa', async () => {
    const mgr = makeManager();
    // fromNum !== localNodeNum, so isPhantomInternalPacket cannot exclude
    // this row even though the mechanism is INTERNAL.
    const packet = basePacket(0xaaaa0003, { transportMechanism: TransportMechanism.INTERNAL, viaMqtt: false });

    await (mgr as any).processMeshPacket(packet);

    expect(loggedTransportMechanism()).toBe(TransportMechanism.INTERNAL);
    expect(TransportMechanism.INTERNAL).toBe(0);
  });

  it('preserves an explicit MULTICAST_UDP (6) mechanism', async () => {
    const mgr = makeManager();
    const packet = basePacket(0xaaaa0004, { transportMechanism: TransportMechanism.MULTICAST_UDP, viaMqtt: false });

    await (mgr as any).processMeshPacket(packet);

    expect(loggedTransportMechanism()).toBe(TransportMechanism.MULTICAST_UDP);
    expect(TransportMechanism.MULTICAST_UDP).toBe(6);
  });
});
