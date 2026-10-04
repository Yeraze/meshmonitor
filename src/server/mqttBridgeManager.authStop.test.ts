/**
 * MQTT bridge — stop an upstream client after repeated rejected logins.
 *
 * Before this, a bridge with a wrong username or password retried the login
 * every ~60 s for as long as the process lived, on the subscriber client and on
 * every per-gateway publisher. Now each client counts on its own, and five
 * rejections in a row stop that client:
 *
 * - the subscriber stopping halts the bridge's intake;
 * - a refused gateway publisher stops only that gateway.
 *
 * A stopped client drops its uplink packets (counted, never queued, never
 * replayed), and `reconnectAuthStopped()` rebuilds only what stopped.
 *
 * These run the REAL `MqttBrokerClient`, coordinator and publisher pool against
 * a fake `mqtt.js`, so the fake plays the broker and the real reconnect timers
 * are what is under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const registry = vi.hoisted(() => ({ managers: new Map<string, unknown>() }));

vi.mock('../services/database.js', () => ({
  default: { ignoredNodes: { isIgnoredCached: () => false } },
}));
vi.mock('./sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => registry.managers.get(id),
    on: vi.fn(),
    off: vi.fn(),
  },
}));
vi.mock('./mqttIngestion.js', () => ({
  bootstrapMqttChannelDatabase: vi.fn().mockResolvedValue(undefined),
  ingestServiceEnvelope: vi.fn().mockResolvedValue({ ingested: true }),
}));
vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    // The tests hand the bridge JSON in place of protobuf bytes.
    decodeServiceEnvelope: (payload: Buffer) => JSON.parse(payload.toString()),
    processPayload: vi.fn(),
  },
}));
vi.mock('./services/distanceDeleteScheduler.js', () => ({
  DistanceDeleteScheduler: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
  },
}));
vi.mock('./services/mqttGeoSweepService.js', () => ({
  mqttGeoSweepService: { runSweep: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('mqtt', () => ({
  connect: vi.fn((_url: string, opts: { clientId: string }) => {
    const c = new EventEmitter() as any;
    c.clientId = opts.clientId;
    c.subscribe = vi.fn((_t: string[], _o: unknown, cb?: any) => cb && cb(null, [], {}));
    c.publish = vi.fn((_t: string, _p: Buffer, _o: unknown, cb?: any) => cb && cb());
    c.end = vi.fn((_f: boolean, _o: unknown, cb?: any) => cb && cb());
    c.reconnect = vi.fn();
    return c;
  }),
}));

import { connect } from 'mqtt';
import { logger } from '../utils/logger.js';
import {
  MqttBridgeManager,
  BRIDGE_AUTH_STOPPED_MESSAGE,
  BRIDGE_MAX_AUTH_FAILURES,
  type MqttBridgeSourceConfig,
} from './mqttBridgeManager.js';

const USERNAME = 'bridge-user-name';
const PASSWORD = 'bridge-pass-word';
const BROKER_HOST = 'bridge-broker.example';
const BROKER_TEXT = 'Connection refused: Bad username or password';

/** The parent broker's own gateway: the subscriber logs in under this id. */
const BROKER_NODE = 0x0000b0b0;
const SUBSCRIBER_ID = '!0000b0b0';
const GW_A = '!0000aaaa';
const GW_B = '!0000bbbb';

const sockets = (): any[] => (connect as any).mock.results.map((r: any) => r.value);
const socketsFor = (clientId: string) => sockets().filter((s) => s.clientId === clientId);
const lastSocketFor = (clientId: string) => socketsFor(clientId).at(-1);
/** Logins a client id has tried: one per socket plus that socket's reconnects. */
const attemptsFor = (clientId: string) =>
  socketsFor(clientId).reduce((n, s) => n + 1 + s.reconnect.mock.calls.length, 0);

function reject(sock: any, code = 4) {
  sock.emit('error', Object.assign(new Error(BROKER_TEXT), { code }));
  sock.emit('close');
}
function accept(sock: any) {
  sock.emit('connect');
}
const flush = () => vi.advanceTimersByTimeAsync(0);

/** A stand-in for the parent `mqtt_broker` manager: the path to the mesh. */
function makeParentBroker() {
  const parent = new EventEmitter() as any;
  parent.sourceId = 'parent-broker';
  parent.sourceType = 'mqtt_broker';
  parent.getLocalNodeInfo = () => ({ nodeNum: BROKER_NODE });
  parent.publish = vi.fn().mockResolvedValue(undefined);
  return parent;
}

const baseConfig = (over: Partial<MqttBridgeSourceConfig> = {}): MqttBridgeSourceConfig => ({
  brokerSourceId: 'parent-broker',
  upstream: { url: `mqtts://${BROKER_HOST}:8883`, username: USERNAME, password: PASSWORD },
  subscriptions: ['msh/US/#'],
  ignoreOkToMqtt: true,
  ...over,
});

let packetSeq = 0;
/** A packet a local gateway heard, as the parent broker hands it to the bridge. */
function localPacket(gatewayId: string) {
  packetSeq += 1;
  return {
    topic: `msh/US/2/e/LongFast/${gatewayId}`,
    payload: Buffer.from(`uplink-${packetSeq}`),
    retained: false,
    envelope: { gatewayId, packet: { id: packetSeq, from: 0x1234 } },
    clientId: 'local-device',
  };
}

/** A packet arriving from the upstream broker. */
function upstreamMessage(sock: any, id: number) {
  const topic = 'msh/US/2/e/LongFast/!0000ffff';
  const payload = Buffer.from(JSON.stringify({ gatewayId: '!0000ffff', packet: { id, from: 0x9999 } }));
  sock.emit('message', topic, payload, { retain: false });
}

describe('MqttBridgeManager — auth stop per upstream client', () => {
  let parent: ReturnType<typeof makeParentBroker>;
  let bridge: MqttBridgeManager;
  let localPackets: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    registry.managers.clear();
    parent = makeParentBroker();
    registry.managers.set('parent-broker', parent);
    localPackets = [];
  });

  afterEach(async () => {
    await bridge?.stop();
    vi.useRealTimers();
  });

  /** Start a bridge whose subscriber's first login is answered by `first`. */
  async function startBridge(first: 'accept' | 'reject', config = baseConfig()) {
    bridge = new MqttBridgeManager('bridge-1', 'Upstream Bridge', config);
    bridge.on('local-packet', (p) => localPackets.push(p));
    const starting = bridge.start();
    await flush();
    const sock = sockets().at(-1);
    if (first === 'accept') accept(sock);
    else reject(sock);
    await starting;
    return sock;
  }

  /** Drive a once-rejected client id to the stop. */
  async function rejectUntilStopped(clientId: string, already = 1) {
    for (let i = already; i < BRIDGE_MAX_AUTH_FAILURES; i++) {
      await vi.advanceTimersByTimeAsync(70_000); // past the 60 s cap plus jitter
      reject(lastSocketFor(clientId));
    }
    await flush();
  }

  async function uplink(gatewayId: string) {
    parent.emit('local-packet', localPacket(gatewayId));
    await flush();
  }

  /** Subscriber connected; gateway A's publisher refused until it stops. */
  async function withGatewayAStopped() {
    await startBridge('accept');
    await uplink(GW_A); // creates the pool entry
    await uplink(GW_B);
    accept(lastSocketFor(GW_B));
    reject(lastSocketFor(GW_A), 5);
    await rejectUntilStopped(GW_A);
  }

  describe('subscriber client', () => {
    it('stops after 5 rejected logins and makes no 6th attempt', async () => {
      await startBridge('reject');
      expect(bridge.getStatus().authStopped).toBe(false);

      await rejectUntilStopped(SUBSCRIBER_ID);

      expect(attemptsFor(SUBSCRIBER_ID)).toBe(BRIDGE_MAX_AUTH_FAILURES);
      expect(bridge.getStatus()).toMatchObject({
        connected: false,
        authStopped: true,
        permissionMessage: BRIDGE_AUTH_STOPPED_MESSAGE,
        lastError: BRIDGE_AUTH_STOPPED_MESSAGE,
      });

      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(attemptsFor(SUBSCRIBER_ID)).toBe(BRIDGE_MAX_AUTH_FAILURES);
      expect(lastSocketFor(SUBSCRIBER_ID).end).toHaveBeenCalledWith(true, {}, expect.any(Function));
    });

    it('a successful login resets the count', async () => {
      await startBridge('reject');
      for (let i = 1; i < BRIDGE_MAX_AUTH_FAILURES - 1; i++) {
        await vi.advanceTimersByTimeAsync(70_000);
        reject(lastSocketFor(SUBSCRIBER_ID));
      }
      // Four rejections so far. The fifth attempt is accepted, then drops.
      await vi.advanceTimersByTimeAsync(70_000);
      accept(lastSocketFor(SUBSCRIBER_ID));
      lastSocketFor(SUBSCRIBER_ID).emit('close');

      for (let i = 0; i < BRIDGE_MAX_AUTH_FAILURES - 1; i++) {
        await vi.advanceTimersByTimeAsync(70_000);
        reject(lastSocketFor(SUBSCRIBER_ID));
      }
      expect(bridge.getStatus().authStopped).toBe(false);

      await vi.advanceTimersByTimeAsync(70_000);
      reject(lastSocketFor(SUBSCRIBER_ID));
      await flush();
      expect(bridge.getStatus().authStopped).toBe(true);
    });

    it('other errors keep the backoff and never stop the bridge', async () => {
      const sock = await startBridge('accept');
      for (let i = 0; i < 12; i++) {
        sock.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
        sock.emit('close');
        await vi.advanceTimersByTimeAsync(70_000);
      }
      expect(bridge.getStatus().authStopped).toBe(false);
      expect(sock.reconnect).toHaveBeenCalledTimes(12);
    });

    it('halts intake but leaves working gateway publishers publishing', async () => {
      await startBridge('reject');
      await rejectUntilStopped(SUBSCRIBER_ID);

      await uplink(GW_A);
      accept(lastSocketFor(GW_A));
      await uplink(GW_A);

      expect(lastSocketFor(GW_A).publish).toHaveBeenCalledTimes(2);
      expect(bridge.getStatus()).toMatchObject({ authStopped: true, uplinkOut: 2, authStoppedGatewayCount: 0 });
    });

    it('drops the uplink it would carry itself, counts it, and logs once', async () => {
      await startBridge('reject');
      await rejectUntilStopped(SUBSCRIBER_ID);
      const stoppedSocket = lastSocketFor(SUBSCRIBER_ID);
      (logger.warn as any).mockClear();

      // Packets heard by the broker's own gateway ride the subscriber client.
      for (let i = 0; i < 40; i++) await uplink(SUBSCRIBER_ID);
      // So does the client-proxy path. It must not throw: a throw is one
      // warning per packet in the caller.
      await expect(bridge.publish('msh/US/t', Buffer.from('proxy'))).resolves.toBeUndefined();

      expect(stoppedSocket.publish).not.toHaveBeenCalled();
      expect(bridge.getStatus()).toMatchObject({ uplinkOut: 0, uplinkAuthStoppedDrops: 41 });
      const dropLines = (logger.warn as any).mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes('dropping the uplink packets'),
      );
      expect(dropLines).toHaveLength(1);
    });

    it('reconnectAuthStopped gives 5 fresh attempts, then stops again', async () => {
      await startBridge('reject');
      await rejectUntilStopped(SUBSCRIBER_ID);

      const reconnecting = bridge.reconnectAuthStopped();
      await flush();
      expect(socketsFor(SUBSCRIBER_ID)).toHaveLength(2);
      reject(lastSocketFor(SUBSCRIBER_ID));
      await expect(reconnecting).resolves.toEqual({ subscriber: true, gateways: 0 });
      expect(bridge.getStatus().authStopped).toBe(false);

      await rejectUntilStopped(SUBSCRIBER_ID);
      expect(bridge.getStatus().authStopped).toBe(true);
      expect(attemptsFor(SUBSCRIBER_ID)).toBe(BRIDGE_MAX_AUTH_FAILURES * 2);
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(attemptsFor(SUBSCRIBER_ID)).toBe(BRIDGE_MAX_AUTH_FAILURES * 2);
    });

    it('reconnectAuthStopped brings intake back once the broker accepts', async () => {
      await startBridge('reject');
      await rejectUntilStopped(SUBSCRIBER_ID);

      const reconnecting = bridge.reconnectAuthStopped();
      await flush();
      const sock = lastSocketFor(SUBSCRIBER_ID);
      accept(sock);
      await reconnecting;

      expect(bridge.getStatus()).toMatchObject({ connected: true, authStopped: false, permissionMessage: null });
      expect(sock.subscribe).toHaveBeenCalledWith(['msh/US/#'], { qos: 0 }, expect.any(Function));
      upstreamMessage(sock, 7001);
      await flush();
      expect(bridge.getStatus().downlinkIn).toBe(1);
    });

    it('reconnectAuthStopped leaves a healthy bridge alone', async () => {
      const sock = await startBridge('accept');
      const before = sockets().length;

      await expect(bridge.reconnectAuthStopped()).resolves.toEqual({ subscriber: false, gateways: 0 });
      expect(sockets().length).toBe(before);
      expect(sock.end).not.toHaveBeenCalled();
      expect(sock.reconnect).not.toHaveBeenCalled();
    });

    it('reconnectAuthStopped leaves a still-retrying bridge alone', async () => {
      await startBridge('reject');
      const before = sockets().length;

      await expect(bridge.reconnectAuthStopped()).resolves.toEqual({ subscriber: false, gateways: 0 });
      expect(sockets().length).toBe(before);
      expect(attemptsFor(SUBSCRIBER_ID)).toBe(1);
    });

    it('applies to a standalone bridge with no parent broker', async () => {
      registry.managers.clear();
      await startBridge('reject', baseConfig({ brokerSourceId: undefined }));
      const id = sockets().at(-1).clientId as string;
      expect(id.startsWith('mm-bridge-bridge-1-')).toBe(true);

      await rejectUntilStopped(id);
      expect(bridge.getStatus().authStopped).toBe(true);
      expect(attemptsFor(id)).toBe(BRIDGE_MAX_AUTH_FAILURES);
    });
  });

  describe('per-gateway publishers', () => {
    it('one refused gateway stops alone; the subscriber and the other gateway keep working', async () => {
      await withGatewayAStopped();

      expect(bridge.getStatus()).toMatchObject({
        connected: true,
        authStopped: false,
        authStoppedGateways: [GW_A],
        authStoppedGatewayCount: 1,
      });
      expect(attemptsFor(GW_A)).toBe(BRIDGE_MAX_AUTH_FAILURES);
      expect(lastSocketFor(SUBSCRIBER_ID).end).not.toHaveBeenCalled();
      expect(lastSocketFor(GW_B).end).not.toHaveBeenCalled();

      const before = bridge.getStatus().uplinkOut;
      await uplink(GW_B);
      expect(bridge.getStatus().uplinkOut).toBe(before + 1);
    });

    it('drops the stopped gateway\'s packets without counting them as sent', async () => {
      await withGatewayAStopped();
      const stoppedSocket = lastSocketFor(GW_A);
      const publishesBefore = stoppedSocket.publish.mock.calls.length;
      const outBefore = bridge.getStatus().uplinkOut;
      const errorBefore = bridge.getStatus().lastError;

      for (let i = 0; i < 25; i++) await uplink(GW_A);

      expect(stoppedSocket.publish.mock.calls.length).toBe(publishesBefore);
      expect(socketsFor(GW_A)).toHaveLength(1);
      const status = bridge.getStatus();
      expect(status.uplinkOut).toBe(outBefore);
      expect(status.uplinkAuthStoppedDrops).toBe(25);
      // A drop is not a publish failure: nothing for a caller to retry on.
      expect(status.lastError).toBe(errorBefore);
    });

    it('reconnectAuthStopped restarts only the stopped gateway', async () => {
      await withGatewayAStopped();
      const subscriber = lastSocketFor(SUBSCRIBER_ID);
      const gatewayB = lastSocketFor(GW_B);

      await expect(bridge.reconnectAuthStopped()).resolves.toEqual({ subscriber: false, gateways: 1 });

      expect(socketsFor(GW_A)).toHaveLength(2);
      expect(socketsFor(GW_B)).toHaveLength(1);
      expect(socketsFor(SUBSCRIBER_ID)).toHaveLength(1);
      expect(subscriber.end).not.toHaveBeenCalled();
      expect(gatewayB.end).not.toHaveBeenCalled();
      expect(bridge.getStatus().authStoppedGatewayCount).toBe(0);

      accept(lastSocketFor(GW_A));
      await uplink(GW_A);
      expect(lastSocketFor(GW_A).publish).toHaveBeenCalledTimes(1);
    });
  });

  describe('status never carries credentials, the broker host, or the broker\'s words', () => {
    it('for a stopped subscriber', async () => {
      await startBridge('reject');
      await rejectUntilStopped(SUBSCRIBER_ID);

      const text = JSON.stringify(bridge.getStatus());
      expect(text).not.toContain(USERNAME);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(BROKER_HOST);
      expect(text).not.toContain(BROKER_TEXT);
    });

    it('for a stopped gateway', async () => {
      await withGatewayAStopped();

      const text = JSON.stringify(bridge.getStatus());
      expect(text).not.toContain(USERNAME);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(BROKER_HOST);
      expect(text).not.toContain(BROKER_TEXT);
    });
  });

  describe('RF egress: a stop and a restart put nothing extra on the mesh', () => {
    // The bridge reaches the mesh two ways: it republishes a downlink packet to
    // the parent broker (whose devices transmit it), and it emits
    // `local-packet` for a client-proxy device. Both are counted here.
    const egress = () => parent.publish.mock.calls.length + localPackets.length;

    it('subscriber stop + restart: only packets the broker really sends go out, once each', async () => {
      const sock = await startBridge('accept');
      upstreamMessage(sock, 9001);
      await flush();
      expect(egress()).toBe(2); // one republish + one local-packet for one packet

      // The broker starts refusing the login; the bridge stops.
      for (let i = 0; i < BRIDGE_MAX_AUTH_FAILURES; i++) {
        reject(lastSocketFor(SUBSCRIBER_ID));
        await vi.advanceTimersByTimeAsync(70_000);
      }
      expect(bridge.getStatus().authStopped).toBe(true);
      // Uplink arriving while stopped is dropped, not turned into egress.
      for (let i = 0; i < 10; i++) await uplink(SUBSCRIBER_ID);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(egress()).toBe(2);

      const reconnecting = bridge.reconnectAuthStopped();
      await flush();
      const fresh = lastSocketFor(SUBSCRIBER_ID);
      accept(fresh);
      await reconnecting;
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      // The restart itself transmitted nothing, and replayed nothing.
      expect(egress()).toBe(2);
      expect(fresh.publish).not.toHaveBeenCalled();

      upstreamMessage(fresh, 9002);
      await flush();
      expect(egress()).toBe(4);
    });

    it('gateway stop + restart: no egress at all, and dropped uplink is not replayed', async () => {
      await withGatewayAStopped();
      for (let i = 0; i < 10; i++) await uplink(GW_A);
      expect(egress()).toBe(0);

      await bridge.reconnectAuthStopped();
      const fresh = lastSocketFor(GW_A);
      accept(fresh);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(egress()).toBe(0);
      // The ten dropped packets are gone: the new client was handed none.
      expect(fresh.publish).not.toHaveBeenCalled();
    });
  });

  it('stop() clears the state, and a new start is a fresh set of attempts', async () => {
    await startBridge('reject');
    await rejectUntilStopped(SUBSCRIBER_ID);
    await bridge.stop();
    expect(bridge.getStatus().authStopped).toBe(false);

    const starting = bridge.start();
    await flush();
    accept(sockets().at(-1));
    await starting;
    expect(bridge.getStatus()).toMatchObject({ connected: true, authStopped: false });
  });
});
