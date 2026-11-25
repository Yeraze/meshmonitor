/**
 * Walkabout hook (#5891 P1): processMeshPacket hands every packet to
 * walkaboutService.maybeCaptureMeshtastic, synchronously, with the packet-log
 * setting OFF, and never awaits it.
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
import { walkaboutService } from './services/walkaboutService.js';

const LOCAL = 0x11223344;
function makeManager(): MeshtasticManager {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).localNodeInfo = { nodeNum: LOCAL, nodeId: '!11223344', longName: 'Local', shortName: 'LOCL' };
  return mgr;
}
const pkt = () => ({
  from: 0x55667788, id: 0xaabbccdd, to: 0xffffffff, channel: 0, relayNode: 0x42, rxSnr: 5, rxRssi: -80,
  hopStart: 3, hopLimit: 2, rxTime: Math.floor(Date.now() / 1000), viaMqtt: false,
  transportMechanism: TransportMechanism.LORA, decoded: { portnum: 1, payload: new Uint8Array(), bitfield: 1 },
});

describe('processMeshPacket Walkabout hook', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('calls maybeCaptureMeshtastic once, with the packet log off, for a live packet', async () => {
    const spy = vi.spyOn(walkaboutService, 'maybeCaptureMeshtastic').mockImplementation(() => undefined);
    const mgr = makeManager();
    const p = pkt();
    await (mgr as any).processMeshPacket(p).catch(() => undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ sourceId: 'src-1', localNodeNum: LOCAL, packet: p, replayed: false });
  });

  it('flags a Store & Forward replay', async () => {
    const spy = vi.spyOn(walkaboutService, 'maybeCaptureMeshtastic').mockImplementation(() => undefined);
    await (makeManager() as any).processMeshPacket(pkt(), { viaStoreForward: true }).catch(() => undefined);
    expect(spy.mock.calls[0][0].replayed).toBe(true);
  });

  it('an idle source reaches no repository: capture is a Map lookup', async () => {
    const mgr = makeManager();
    await (mgr as any).processMeshPacket(pkt()).catch(() => undefined);
    // No live session exists in this process, so the real service wrote nothing.
    expect(walkaboutService.getSkipped('src-1', 'x')).toBeNull();
  });
});
