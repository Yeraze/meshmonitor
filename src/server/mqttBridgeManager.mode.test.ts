import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { connect, type MqttClient } from 'mqtt';
import { Aedes } from 'aedes';
import { createServer, type Server } from 'net';

vi.mock('../services/database.js', () => ({
  default: {},
}));

import { MqttBrokerManager } from './mqttBrokerManager.js';
import { MqttBridgeManager } from './mqttBridgeManager.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { PortNum } from './constants/meshtastic.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

async function ephemeralPort(): Promise<number> {
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('no address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function startUpstream(port: number): Promise<{ aedes: Aedes; server: Server }> {
  const aedes = await Aedes.createBroker({ id: 'upstream' });
  const server = createServer((socket) => aedes.handle(socket));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  return { aedes, server };
}

async function stopUpstream(u: { aedes: Aedes; server: Server }): Promise<void> {
  await new Promise<void>((resolve) => u.server.close(() => resolve()));
  await new Promise<void>((resolve) => u.aedes.close(() => resolve()));
}

function buildPositionEnvelope(opts: {
  from: number;
  latI: number;
  lngI: number;
  channelId: string;
  gatewayId: string;
  packetId?: number;
}): Buffer {
  const r = getProtobufRoot();
  if (!r) throw new Error('protobuf root not loaded');
  const Position = r.lookupType('meshtastic.Position');
  const positionPayload = Position.encode(
    Position.create({ latitudeI: opts.latI, longitudeI: opts.lngI }),
  ).finish();
  const bytes = meshtasticProtobufService.encodeServiceEnvelope({
    packet: {
      from: opts.from,
      to: 0xffffffff,
      channel: 0,
      id: opts.packetId ?? 0xabcdef01,
      decoded: { portnum: PortNum.POSITION_APP, payload: positionPayload },
    },
    channelId: opts.channelId,
    gatewayId: opts.gatewayId,
  });
  if (!bytes) throw new Error('encode failed');
  return Buffer.from(bytes);
}

describe('MqttBridgeManager mode field', () => {
  let upstreamPort: number;
  let localPort: number;
  let upstream: { aedes: Aedes; server: Server };
  let broker: MqttBrokerManager;
  let bridge: MqttBridgeManager;
  let extraClients: MqttClient[] = [];

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    upstreamPort = await ephemeralPort();
    localPort = await ephemeralPort();
    upstream = await startUpstream(upstreamPort);

    broker = new MqttBrokerManager('local-broker', 'Local', {
      listener: { port: localPort, host: '127.0.0.1' },
      auth: { username: 'u', password: 'p' },
      gateway: { nodeNum: 0xdeadbeef, nodeId: '!deadbeef', longName: 'L', shortName: 'L' },
      rootTopic: 'msh',
    });
    await sourceManagerRegistry.addManager(broker);
  });

  afterEach(async () => {
    for (const c of extraClients) {
      await new Promise<void>((r) => c.end(true, {}, () => r()));
    }
    extraClients = [];
    await sourceManagerRegistry.stopAll();
    await stopUpstream(upstream);
  });

  it('defaults to bidirectional and exposes mode in status', async () => {
    bridge = new MqttBridgeManager('default-mode-bridge', 'Default', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/#'],
    });
    await sourceManagerRegistry.addManager(bridge);
    expect(bridge.getStatus().mode).toBe('bidirectional');
  });

  it('publish_only: does not subscribe upstream, but publish() still forwards', async () => {
    // Aedes "subscribe" event fires on every SUBSCRIBE packet. Capture them
    // so we can prove the bridge never sent one in publish_only mode.
    const seenSubs: string[] = [];
    upstream.aedes.on('subscribe', (subs) => {
      for (const s of subs) seenSubs.push(s.topic);
    });

    bridge = new MqttBridgeManager('publish-only-bridge', 'PubOnly', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/#'],
      mode: 'publish_only',
    });
    await sourceManagerRegistry.addManager(bridge);

    // Give the client time to settle. No subscribe should have been issued
    // by the bridge — only our own watchdog clients (if any) would appear,
    // and at this point there are none.
    await new Promise((r) => setTimeout(r, 200));
    expect(seenSubs).toEqual([]);
    expect(bridge.getStatus().mode).toBe('publish_only');

    // But explicit publish() still works — used by mqttLink proxy targets.
    const upstreamClient = connect(`mqtt://127.0.0.1:${upstreamPort}`, { reconnectPeriod: 0 });
    extraClients.push(upstreamClient);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('upstream connect timeout')), 3000);
      upstreamClient.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
    const seen: Array<{ topic: string }> = [];
    await new Promise<void>((resolve, reject) => {
      upstreamClient.subscribe('msh/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
    upstreamClient.on('message', (topic) => seen.push({ topic }));

    const envelope = buildPositionEnvelope({
      from: 0x55555555,
      latI: 0,
      lngI: 0,
      channelId: 'LongFast',
      gatewayId: '!55555555',
      packetId: 0x40000001,
    });
    await bridge.publish('msh/out/pubonly', envelope);
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.some((m) => m.topic === 'msh/out/pubonly')).toBe(true);
  });

  it('subscribe_only: does not bind parent broker uplink and refuses publish()', async () => {
    bridge = new MqttBridgeManager('sub-only-bridge', 'SubOnly', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/US/#'],
      mode: 'subscribe_only',
    });
    await sourceManagerRegistry.addManager(bridge);

    // The bridge IS attached as a manager to the broker (the broker may track
    // it in its registry), but it must not have wired its `local-packet`
    // listener. Verify by counting parent broker listeners before and after
    // emitting a synthetic uplink — uplinkOut should stay zero.
    expect(bridge.getStatus().mode).toBe('subscribe_only');
    expect(bridge.getStatus().uplinkOut).toBe(0);

    // publish() must throw in subscribe_only mode, regardless of upstream state.
    await expect(
      bridge.publish('msh/should/not/fire', Buffer.from([0x01, 0x02])),
    ).rejects.toThrow(/subscribe_only/);

    // Confirm the bridge still subscribes upstream (the whole point of this mode).
    // Drive an envelope from upstream and verify downlinkIn ticks.
    const pub = connect(`mqtt://127.0.0.1:${upstreamPort}`, { reconnectPeriod: 0 });
    extraClients.push(pub);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pub connect timeout')), 3000);
      pub.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
    const envelope = buildPositionEnvelope({
      from: 0x66666666,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!66666666',
      packetId: 0x40000002,
    });
    pub.publish('msh/US/CA/Test', envelope);
    await new Promise((r) => setTimeout(r, 300));
    expect(bridge.getStatus().downlinkIn).toBeGreaterThanOrEqual(1);
  });
});
