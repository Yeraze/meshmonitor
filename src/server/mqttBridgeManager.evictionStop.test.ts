/**
 * MQTT bridge — #5893.
 *
 * - `single` mode takes an optional `upstream.clientId` (`!xxxxxxxx`), used
 *   verbatim with no random suffix, so a strict broker accepts the login.
 * - A client the broker keeps evicting (duplicate Client ID, per-username
 *   connection cap) stops after 5 evictions in 10 minutes instead of looping
 *   for ever, and says why on the status. A save (new manager) or a manual
 *   reconnect resumes it.
 * - An uplink packet that arrives while the subscriber is down is counted in
 *   `uplinkDisconnectedDrops` and logged once per episode, not dropped silently.
 *
 * Runs the REAL MqttBrokerClient, coordinator and pool against a fake mqtt.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const registry = vi.hoisted(() => ({
  managers: new Map<string, unknown>(),
  listeners: new Map<string, Array<(m: unknown) => void>>(),
}));

vi.mock('../services/database.js', () => ({
  default: { ignoredNodes: { isIgnoredCached: () => false } },
}));
vi.mock('./sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => registry.managers.get(id),
    getAllManagers: () => Array.from(registry.managers.values()),
    on: (event: string, fn: (m: unknown) => void) => {
      const list = registry.listeners.get(event) ?? [];
      list.push(fn);
      registry.listeners.set(event, list);
    },
    off: (event: string, fn: (m: unknown) => void) => {
      const list = registry.listeners.get(event) ?? [];
      registry.listeners.set(event, list.filter((f) => f !== fn));
    },
  },
}));
vi.mock('./mqttIngestion.js', () => ({
  bootstrapMqttChannelDatabase: vi.fn().mockResolvedValue(undefined),
  ingestServiceEnvelope: vi.fn().mockResolvedValue({ ingested: true }),
}));
vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
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
  BRIDGE_EVICTION_STOPPED_MESSAGE,
  BRIDGE_MAX_EVICTIONS,
  normalizeBridgeClientId,
  type MqttBridgeSourceConfig,
} from './mqttBridgeManager.js';

const BROKER_NODE = 0x0000b0b0;
const SUBSCRIBER_ID = '!0000b0b0';
const GW_A = '!0000aaaa';

const sockets = (): any[] => (connect as any).mock.results.map((r: any) => r.value);
const socketsFor = (clientId: string) => sockets().filter((s) => s.clientId === clientId);
const lastSocketFor = (clientId: string) => socketsFor(clientId).at(-1);
const attemptsFor = (clientId: string) =>
  socketsFor(clientId).reduce((n, s) => n + 1 + s.reconnect.mock.calls.length, 0);
const flush = () => vi.advanceTimersByTimeAsync(0);
const infoLines = () => (logger.info as any).mock.calls.map((c: unknown[]) => String(c[0]));

function makeParentBroker() {
  const parent = new EventEmitter() as any;
  parent.sourceId = 'parent-broker';
  parent.sourceType = 'mqtt_broker';
  parent.getLocalNodeInfo = () => ({ nodeNum: BROKER_NODE });
  parent.publish = vi.fn().mockResolvedValue(undefined);
  parent.markSkipRaise = vi.fn();
  parent.markBridgeOrigin = vi.fn();
  parent.bridgeOriginOf = vi.fn().mockReturnValue(null);
  return parent;
}

const baseConfig = (over: Partial<MqttBridgeSourceConfig> = {}): MqttBridgeSourceConfig => ({
  brokerSourceId: 'parent-broker',
  upstream: { url: 'mqtt://strict-broker.example:1883', username: 'u', password: 'p' },
  subscriptions: ['msh/US/#'],
  ignoreOkToMqtt: true,
  ...over,
});

let packetSeq = 0;
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

/** The broker accepts the session, then closes it 500 ms later: an eviction. */
async function evict(sock: any) {
  sock.emit('connect');
  await vi.advanceTimersByTimeAsync(500);
  sock.emit('close');
  await flush();
}

describe('normalizeBridgeClientId', () => {
  it('accepts 8 hex digits with or without !, any case, and lowercases', () => {
    expect(normalizeBridgeClientId('!A1B2C3D4')).toBe('!a1b2c3d4');
    expect(normalizeBridgeClientId('a1b2c3d4')).toBe('!a1b2c3d4');
    expect(normalizeBridgeClientId('  !0000beef ')).toBe('!0000beef');
  });
  it('treats blank as unset', () => {
    expect(normalizeBridgeClientId(undefined)).toBeUndefined();
    expect(normalizeBridgeClientId(null)).toBeUndefined();
    expect(normalizeBridgeClientId('')).toBeUndefined();
    expect(normalizeBridgeClientId('   ')).toBeUndefined();
  });
  it('rejects anything else', () => {
    for (const bad of ['!a1b2c3d', '!a1b2c3d4e', 'mm-bridge-x', '!g1b2c3d4', '!!a1b2c3d4', 12345678]) {
      expect(normalizeBridgeClientId(bad)).toBeNull();
    }
  });
});

describe('MqttBridgeManager — #5893', () => {
  let parent: ReturnType<typeof makeParentBroker>;
  let bridge: MqttBridgeManager | null;
  const extra: MqttBridgeManager[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    registry.managers.clear();
    registry.listeners.clear();
    parent = makeParentBroker();
    registry.managers.set('parent-broker', parent);
    bridge = null;
  });

  afterEach(async () => {
    await bridge?.stop();
    for (const b of extra.splice(0)) await b.stop();
    vi.useRealTimers();
  });

  async function startBridge(config = baseConfig(), id = 'bridge-1') {
    const b = new MqttBridgeManager(id, 'Bridge', config);
    const starting = b.start();
    await flush();
    const sock = sockets().at(-1);
    sock.emit('connect');
    await starting;
    return { b, sock };
  }

  describe('single-mode Client ID', () => {
    it('connects with exactly the configured !xxxxxxxx, no random suffix', async () => {
      const { b } = await startBridge(
        baseConfig({
          forwardingMode: 'single',
          upstream: { url: 'mqtt://strict-broker.example:1883', clientId: '!A1B2C3D4' },
        }),
      );
      bridge = b;
      expect((connect as any).mock.calls).toHaveLength(1);
      expect((connect as any).mock.calls[0][1].clientId).toBe('!a1b2c3d4');
    });

    it('keeps the mm-bridge-<sourceId>-<random> default when unset', async () => {
      const { b } = await startBridge(baseConfig({ forwardingMode: 'single' }));
      bridge = b;
      expect((connect as any).mock.calls[0][1].clientId).toMatch(/^mm-bridge-bridge-1-[a-z0-9]+$/);
    });

    it('falls back to the default for an invalid stored value', async () => {
      const { b } = await startBridge(
        baseConfig({
          forwardingMode: 'single',
          upstream: { url: 'mqtt://strict-broker.example:1883', clientId: 'not-hex' },
        }),
      );
      bridge = b;
      expect((connect as any).mock.calls[0][1].clientId).toMatch(/^mm-bridge-bridge-1-/);
    });

    it('is ignored in per_gateway mode (subscriber uses the broker gateway id)', async () => {
      const { b } = await startBridge(
        baseConfig({ upstream: { url: 'mqtt://strict-broker.example:1883', clientId: '!a1b2c3d4' } }),
      );
      bridge = b;
      expect((connect as any).mock.calls[0][1].clientId).toBe(SUBSCRIBER_ID);
    });
  });

  describe('eviction stop', () => {
    it(`stops after ${BRIDGE_MAX_EVICTIONS} evictions in 10 minutes, not after ${BRIDGE_MAX_EVICTIONS - 1}`, async () => {
      const { b, sock } = await startBridge();
      bridge = b;
      // The first session (from start) is evicted too.
      await vi.advanceTimersByTimeAsync(500);
      sock.emit('close');
      await flush();
      for (let i = 1; i < BRIDGE_MAX_EVICTIONS - 1; i++) {
        await vi.advanceTimersByTimeAsync(20_000);
        await evict(sock);
      }
      // Four evictions: still retrying.
      expect(b.getStatus().evictionStopped).toBe(false);
      expect(b.hasAuthStop()).toBe(false);

      await vi.advanceTimersByTimeAsync(20_000);
      await evict(sock);

      const status = b.getStatus();
      expect(status).toMatchObject({
        connected: false,
        evictionStopped: true,
        lastError: BRIDGE_EVICTION_STOPPED_MESSAGE,
        permissionMessage: BRIDGE_EVICTION_STOPPED_MESSAGE,
      });
      expect(b.hasAuthStop()).toBe(true);

      // No further CONNECTs, ever.
      const attempts = attemptsFor(SUBSCRIBER_ID);
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(attemptsFor(SUBSCRIBER_ID)).toBe(attempts);
      expect(sock.end).toHaveBeenCalledWith(true, {}, expect.any(Function));
    });

    it('does not stop when the evictions are spread over more than 10 minutes', async () => {
      const { b, sock } = await startBridge();
      bridge = b;
      for (let i = 0; i < BRIDGE_MAX_EVICTIONS * 2; i++) {
        await vi.advanceTimersByTimeAsync(500);
        sock.emit('close');
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        sock.emit('connect');
      }
      expect(b.getStatus().evictionStopped).toBe(false);
    });

    it('a manual reconnect resumes a stopped subscriber with a fresh client', async () => {
      const { b, sock } = await startBridge();
      bridge = b;
      await vi.advanceTimersByTimeAsync(500);
      sock.emit('close');
      for (let i = 1; i < BRIDGE_MAX_EVICTIONS; i++) {
        await vi.advanceTimersByTimeAsync(20_000);
        await evict(sock);
      }
      expect(b.getStatus().evictionStopped).toBe(true);

      const before = socketsFor(SUBSCRIBER_ID).length;
      const reconnecting = b.reconnectAuthStopped();
      await flush();
      lastSocketFor(SUBSCRIBER_ID).emit('connect');
      const result = await reconnecting;
      expect(result.subscriber).toBe(true);
      expect(socketsFor(SUBSCRIBER_ID).length).toBe(before + 1);
      expect(b.getStatus()).toMatchObject({ evictionStopped: false, connected: true });
    });

    it('a save (a new manager) and a restart start a fresh count', async () => {
      const first = await startBridge();
      await vi.advanceTimersByTimeAsync(500);
      first.sock.emit('close');
      for (let i = 1; i < BRIDGE_MAX_EVICTIONS; i++) {
        await vi.advanceTimersByTimeAsync(20_000);
        await evict(first.sock);
      }
      expect(first.b.getStatus().evictionStopped).toBe(true);
      await first.b.stop();

      const second = await startBridge();
      bridge = second.b;
      expect(second.b.getStatus()).toMatchObject({ evictionStopped: false, connected: true });
    });

    it('stops a per-gateway publisher on its own and counts its drops', async () => {
      const { b } = await startBridge();
      bridge = b;
      parent.emit('local-packet', localPacket(GW_A));
      await flush();
      const gw = lastSocketFor(GW_A);
      for (let i = 0; i < BRIDGE_MAX_EVICTIONS; i++) {
        await vi.advanceTimersByTimeAsync(20_000);
        await evict(gw);
      }
      const status = b.getStatus();
      expect(status.evictionStopped).toBe(false);
      expect(status.connected).toBe(true);
      expect(status.evictionStoppedGateways).toEqual([GW_A]);
      expect(status.evictionStoppedGatewayCount).toBe(1);
      expect(b.hasAuthStop()).toBe(true);

      const before = b.getStatus().uplinkDisconnectedDrops;
      parent.emit('local-packet', localPacket(GW_A));
      await flush();
      expect(b.getStatus().uplinkDisconnectedDrops).toBe(before + 1);
      // The stopped gateway made no new CONNECT for that packet.
      expect(socketsFor(GW_A)).toHaveLength(1);
    });
  });

  describe('uplink while disconnected', () => {
    it('counts each drop and logs once per disconnected episode', async () => {
      const { b, sock } = await startBridge(baseConfig({ forwardingMode: 'single' }));
      bridge = b;
      // Drop the connection after a long, healthy session (not an eviction).
      await vi.advanceTimersByTimeAsync(200_000);
      sock.emit('close');
      await flush();

      for (let i = 0; i < 3; i++) {
        parent.emit('local-packet', localPacket(GW_A));
        await flush();
      }
      expect(b.getStatus().uplinkDisconnectedDrops).toBe(3);
      expect(sock.publish).not.toHaveBeenCalled();
      const dropLines = () => infoLines().filter((l: string) => l.includes('dropping uplink packets'));
      expect(dropLines()).toHaveLength(1);

      // Reconnect, then a new episode logs again.
      sock.emit('connect');
      await vi.advanceTimersByTimeAsync(200_000);
      sock.emit('close');
      parent.emit('local-packet', localPacket(GW_A));
      await flush();
      expect(b.getStatus().uplinkDisconnectedDrops).toBe(4);
      expect(dropLines()).toHaveLength(2);
    });
  });

  describe('shared upstream warning', () => {
    it('warns when two per_gateway bridges share parent broker + upstream URL', async () => {
      const one = await startBridge(baseConfig(), 'bridge-1');
      registry.managers.set('bridge-1', one.b);
      extra.push(one.b);
      expect(one.b.getStatus().sharedUpstreamWarning).toBeNull();

      const two = await startBridge(baseConfig(), 'bridge-2');
      registry.managers.set('bridge-2', two.b);
      extra.push(two.b);
      expect(two.b.getStatus().sharedUpstreamWarning).toMatch(/same parent broker and upstream URL/);
      expect(one.b.getStatus().sharedUpstreamWarning).toMatch(/1 other bridge/);
      expect((logger.warn as any).mock.calls.some((c: unknown[]) =>
        String(c[0]).includes('bridge-2') && String(c[0]).includes('same parent broker'))).toBe(true);
    });

    it('does not warn for single mode or a different upstream', async () => {
      const one = await startBridge(baseConfig(), 'bridge-1');
      registry.managers.set('bridge-1', one.b);
      extra.push(one.b);
      const two = await startBridge(baseConfig({ forwardingMode: 'single' }), 'bridge-2');
      registry.managers.set('bridge-2', two.b);
      extra.push(two.b);
      const three = await startBridge(
        baseConfig({ upstream: { url: 'mqtt://other.example:1883' } }),
        'bridge-3',
      );
      registry.managers.set('bridge-3', three.b);
      extra.push(three.b);
      expect(one.b.getStatus().sharedUpstreamWarning).toBeNull();
      expect(two.b.getStatus().sharedUpstreamWarning).toBeNull();
      expect(three.b.getStatus().sharedUpstreamWarning).toBeNull();
    });
  });

  describe('late parent attach', () => {
    it('reconnects the subscriber under the gateway id and builds the pool', async () => {
      registry.managers.delete('parent-broker');
      const { b, sock } = await startBridge();
      bridge = b;
      expect(sock.clientId).toMatch(/^mm-bridge-bridge-1-/);
      expect(b.getStatus().parentBrokerAttached).toBe(false);

      registry.managers.set('parent-broker', parent);
      for (const fn of registry.listeners.get('manager-started') ?? []) fn(parent);
      await flush();
      lastSocketFor(SUBSCRIBER_ID).emit('connect');
      await flush();

      expect(sock.end).toHaveBeenCalled();
      expect(b.getStatus()).toMatchObject({ parentBrokerAttached: true, connected: true });
      parent.emit('local-packet', localPacket(GW_A));
      await flush();
      expect(socketsFor(GW_A)).toHaveLength(1);
    });
  });
});
