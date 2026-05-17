import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { connect, type MqttClient } from 'mqtt';
import { Aedes } from 'aedes';
import { createServer, type Server } from 'net';

const upsertNode = vi.fn();
const insertMessage = vi.fn().mockReturnValue(true);
const insertTelemetry = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    upsertNode: (...a: unknown[]) => upsertNode(...a),
    insertMessage: (...a: unknown[]) => insertMessage(...a),
    insertTelemetry: (...a: unknown[]) => insertTelemetry(...a),
  },
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

// A bare upstream broker for the bridge to connect to — no auth so tests
// don't need to ship creds through MqttBrokerClient.
async function startUpstream(port: number): Promise<{ aedes: Aedes; server: Server }> {
  const aedes = await Aedes.createBroker({ id: 'upstream' });
  const server = createServer((socket) => {
    aedes.handle(socket);
  });
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

describe('MqttBridgeManager', () => {
  let upstreamPort: number;
  let localPort: number;
  let upstream: { aedes: Aedes; server: Server };
  let broker: MqttBrokerManager;
  let bridge: MqttBridgeManager;
  let upstreamClient: MqttClient | null = null;

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    upsertNode.mockClear();
    insertMessage.mockClear();
    insertTelemetry.mockClear();

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
    if (upstreamClient) {
      await new Promise<void>((r) => upstreamClient!.end(true, {}, () => r()));
      upstreamClient = null;
    }
    // Stop every manager the registry knows about — guarantees no state
    // leaks into the next test.
    await sourceManagerRegistry.stopAll();
    await stopUpstream(upstream);
  });

  it('passes downlink packets through filter and ingests + republishes to local broker', async () => {
    bridge = new MqttBridgeManager('test-bridge', 'Bridge', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/CA/#'],
      downlinkFilters: {
        topics: { block: ['msh/CA/QC/#'] },
        geo: { minLat: 43, maxLat: 45, minLng: -80, maxLng: -77 },
      },
    });
    await sourceManagerRegistry.addManager(bridge);

    upstreamClient = connect(`mqtt://127.0.0.1:${upstreamPort}`, { reconnectPeriod: 0 });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('upstream connect timeout')), 3000);
      upstreamClient!.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });

    // Subscribe to the local broker so we can confirm republish.
    const localClient = connect(`mqtt://127.0.0.1:${localPort}`, {
      username: 'u',
      password: 'p',
      reconnectPeriod: 0,
    });
    const localMessages: Array<{ topic: string; payload: Buffer }> = [];
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('local connect timeout')), 3000);
      localClient.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      localClient.subscribe('msh/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
    localClient.on('message', (topic, payload) => {
      localMessages.push({ topic, payload });
    });

    // Inside the bbox, allowed by topic → should pass.
    const inBboxEnvelope = buildPositionEnvelope({
      from: 0x11111111,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!11111111',
      packetId: 0x10000001,
    });

    // Outside the bbox → should drop on postFilterPosition.
    const outBboxEnvelope = buildPositionEnvelope({
      from: 0x22222222,
      latI: 420_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!22222222',
      packetId: 0x10000002,
    });

    // Blocked topic → should drop in preFilter.
    const blockedEnvelope = buildPositionEnvelope({
      from: 0x33333333,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!33333333',
      packetId: 0x10000003,
    });

    upstreamClient.publish('msh/CA/ON/PTBO', inBboxEnvelope);
    upstreamClient.publish('msh/CA/ON/PTBO', outBboxEnvelope);
    upstreamClient.publish('msh/CA/QC/MTL', blockedEnvelope);

    // Let the messages flow.
    await new Promise((r) => setTimeout(r, 500));

    const status = bridge.getStatus();
    expect(status.downlinkIn).toBeGreaterThanOrEqual(3);
    // Only the in-bbox passes filtering AND ingests.
    expect(status.downlinkIngested).toBe(1);
    expect(status.downlinkDrops.topic).toBeGreaterThanOrEqual(1);
    expect(status.downlinkDrops.geo).toBeGreaterThanOrEqual(1);

    // Republish: only the in-bbox should make it to the local broker.
    const republishedFromBridge = localMessages.filter((m) => m.topic === 'msh/CA/ON/PTBO');
    expect(republishedFromBridge.length).toBe(1);

    await new Promise<void>((r) => localClient.end(true, {}, () => r()));
  });

  it('honors deferred parent broker attach (bridge starts before broker)', async () => {
    // Remove the broker first so the bridge has to wait.
    await sourceManagerRegistry.removeManager(broker.sourceId);

    bridge = new MqttBridgeManager('test-bridge', 'Bridge', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/#'],
    });
    await sourceManagerRegistry.addManager(bridge);
    expect(bridge.getStatus().parentBrokerAttached).toBe(false);

    // Now register the broker — bridge should auto-attach.
    await sourceManagerRegistry.addManager(broker);
    // Wait a tick for event dispatch.
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.getStatus().parentBrokerAttached).toBe(true);
  });
});
