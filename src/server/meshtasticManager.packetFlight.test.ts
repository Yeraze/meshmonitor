/**
 * Live packet traffic (#4835): processMeshPacket emits a `packet:flight` for a
 * live reception, with the Packet Monitor log OFF (packetLogService.isEnabled
 * is mocked false for this whole suite), and only while a map watches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { dataEventEmitter, type DataEvent } from './services/dataEventEmitter.js';
import { watchPacketFlights, resetPacketFlightWatchers } from './services/packetFlightWatchers.js';
import packetLogService from './services/packetLogService.js';

const SOURCE_ID = 'src-1';
const LOCAL_NODE_NUM = 0x11223344;

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

const REMOTE = 0x55667788;

function remotePacket(overrides: Record<string, any> = {}) {
  return {
    from: REMOTE,
    id: 0x01020304,
    to: 0xffffffff,
    channel: 0,
    relayNode: 0x99,
    rxSnr: 4.5,
    rxRssi: -88,
    rxTime: Math.floor(Date.now() / 1000),
    hopStart: 3,
    hopLimit: 1,
    transportMechanism: TransportMechanism.LORA,
    viaMqtt: false,
    decoded: { portnum: 1, payload: new TextEncoder().encode('secret words') },
    ...overrides,
  };
}

describe('MeshtasticManager: packet:flight (#4835)', () => {
  let events: DataEvent[];
  const listener = (e: DataEvent) => events.push(e);

  beforeEach(() => {
    events = [];
    resetPacketFlightWatchers();
    dataEventEmitter.on('data', listener);
  });
  afterEach(() => {
    dataEventEmitter.off('data', listener);
    resetPacketFlightWatchers();
  });

  const flights = () => events.filter((e) => e.type === 'packet:flight');

  it('emits a flight for a live reception with packet logging off', async () => {
    watchPacketFlights('sock-1', SOURCE_ID);
    await (makeManager() as any).processMeshPacket(remotePacket());
    expect(await (packetLogService as any).isEnabled()).toBe(false);
    expect(flights()).toHaveLength(1);
    const evt = flights()[0];
    expect(evt.sourceId).toBe(SOURCE_ID);
    expect(evt.data).toEqual({
      sourceId: SOURCE_ID,
      protocol: 'meshtastic',
      receivedAt: expect.any(Number),
      from: REMOTE,
      to: LOCAL_NODE_NUM,
      relay: 0x99,
      hopsUsed: 2,
      kind: 'PORT_1',
      snr: 4.5,
      rssi: -88,
    });
    // No packet content rides along.
    expect(JSON.stringify(evt.data)).not.toContain('secret');
  });

  it('emits nothing while no map watches the source', async () => {
    await (makeManager() as any).processMeshPacket(remotePacket());
    expect(flights()).toHaveLength(0);
  });

  it('emits nothing for another source\'s watcher', async () => {
    watchPacketFlights('sock-1', 'some-other-source');
    await (makeManager() as any).processMeshPacket(remotePacket());
    expect(flights()).toHaveLength(0);
  });

  it('skips our own packets and Store & Forward replays', async () => {
    watchPacketFlights('sock-1', SOURCE_ID);
    const mgr = makeManager();
    await (mgr as any).processMeshPacket(remotePacket({ from: LOCAL_NODE_NUM }));
    await (mgr as any).processMeshPacket(remotePacket({ id: 0x0a0b0c0d }), { viaStoreForward: true });
    expect(flights()).toHaveLength(0);
  });

  it('marks a packet the node got over its MQTT uplink', async () => {
    watchPacketFlights('sock-1', SOURCE_ID);
    await (makeManager() as any).processMeshPacket(remotePacket({ transportMechanism: TransportMechanism.MQTT, viaMqtt: true }));
    expect(flights()).toHaveLength(1);
    expect((flights()[0].data as any).viaMqtt).toBe(true);
  });
});
