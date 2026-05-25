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

  it('runs standalone without a parent broker: emits local-packet on downlink and publish() forwards upstream (#3134)', async () => {
    // Standalone bridge — no brokerSourceId. Doesn't need (or use) the
    // local broker fixture.
    bridge = new MqttBridgeManager('standalone-bridge', 'Standalone', {
      // brokerSourceId intentionally omitted
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/#'],
    });
    await sourceManagerRegistry.addManager(bridge);

    expect(bridge.getStatus().parentBrokerAttached).toBe(false);

    // Capture local-packet emissions so we can prove the client-proxy
    // event path works without a parent broker.
    const localPackets: Array<{ topic: string; clientId: string | null }> = [];
    bridge.on('local-packet', (p: { topic: string; clientId: string | null }) => {
      localPackets.push({ topic: p.topic, clientId: p.clientId });
    });

    // A separate client subscribing to upstream lets us assert that
    // bridge.publish() actually reaches the upstream broker.
    upstreamClient = connect(`mqtt://127.0.0.1:${upstreamPort}`, { reconnectPeriod: 0 });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('upstream connect timeout')), 3000);
      upstreamClient!.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
    const upstreamSeen: Array<{ topic: string; payload: Buffer }> = [];
    await new Promise<void>((resolve, reject) => {
      upstreamClient!.subscribe('msh/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
    upstreamClient.on('message', (topic, payload) => {
      upstreamSeen.push({ topic, payload });
    });

    // Drive downlink: a *different* upstream publisher emits a packet
    // the bridge has subscribed to.
    const pub = connect(`mqtt://127.0.0.1:${upstreamPort}`, { reconnectPeriod: 0 });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pub connect timeout')), 3000);
      pub.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });

    const envelope = buildPositionEnvelope({
      from: 0xaabbccdd,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!aabbccdd',
      packetId: 0x20000001,
    });
    pub.publish('msh/CA/ON/PTBO', envelope);
    await new Promise((r) => setTimeout(r, 300));

    expect(localPackets.length).toBeGreaterThanOrEqual(1);
    expect(localPackets[0].topic).toBe('msh/CA/ON/PTBO');
    expect(localPackets[0].clientId).toBeNull();

    // And the explicit publish() path forwards straight upstream.
    const outboundEnvelope = buildPositionEnvelope({
      from: 0x11223344,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!11223344',
      packetId: 0x20000002,
    });
    await bridge.publish('msh/proxy/out', outboundEnvelope);
    await new Promise((r) => setTimeout(r, 300));

    expect(upstreamSeen.some((m) => m.topic === 'msh/proxy/out')).toBe(true);

    await new Promise<void>((r) => pub.end(true, {}, () => r()));
  });

  it('publish() throws when bridge is not connected to upstream (#3134)', async () => {
    bridge = new MqttBridgeManager('disconnected-bridge', 'Disconnected', {
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/#'],
    });
    // Don't start the bridge — client is null.
    await expect(bridge.publish('msh/x', Buffer.from([1, 2, 3]))).rejects.toThrow(/not connected to upstream/);
  });

  // ---------------------------------------------------------------------------
  // Topic rewriting (#3166): bridge between meshes that use different MQTT
  // roots (e.g. msh/US/TX ↔ msh/US/LA). The pure helper is covered by
  // mqttBridgeManager.topicRewrite.test.ts — these tests verify the
  // integration: republish topics, echo cache keying, and no-loop behavior.
  // ---------------------------------------------------------------------------

  it('downlink rewrite republishes under the rewritten topic on the parent broker', async () => {
    bridge = new MqttBridgeManager('rewrite-bridge', 'Rewrite', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/US/TX/#'],
      downlinkTopicRewrite: { from: 'msh/US/TX', to: 'msh/US/LA' },
    });
    await sourceManagerRegistry.addManager(bridge);

    // A local broker subscriber sees what the bridge republishes locally.
    const localClient = connect(`mqtt://127.0.0.1:${localPort}`, {
      username: 'u',
      password: 'p',
      reconnectPeriod: 0,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('local connect timeout')), 3000);
      localClient.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
    const localMessages: Array<{ topic: string; payload: Buffer }> = [];
    await new Promise<void>((resolve, reject) => {
      localClient.subscribe('msh/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
    localClient.on('message', (topic, payload) => {
      localMessages.push({ topic, payload });
    });

    // Publish to upstream as if from a TX-rooted mesh.
    const pub = connect(`mqtt://127.0.0.1:${upstreamPort}`, { reconnectPeriod: 0 });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pub connect timeout')), 3000);
      pub.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });

    const envelope = buildPositionEnvelope({
      from: 0x11111111,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!11111111',
      packetId: 0x30000001,
    });
    pub.publish('msh/US/TX/2/e/Foo', envelope);
    await new Promise((r) => setTimeout(r, 400));

    // Local broker should see the REWRITTEN topic (msh/US/LA), not the
    // original msh/US/TX.
    expect(localMessages.some((m) => m.topic === 'msh/US/LA/2/e/Foo')).toBe(true);
    expect(localMessages.some((m) => m.topic === 'msh/US/TX/2/e/Foo')).toBe(false);

    await new Promise<void>((r) => localClient.end(true, {}, () => r()));
    await new Promise<void>((r) => pub.end(true, {}, () => r()));
  });

  it('uplink rewrite publishes upstream under the rewritten topic', async () => {
    bridge = new MqttBridgeManager('uplink-rewrite-bridge', 'UplinkRewrite', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/US/TX/#'], // subscribe to TX so the upstream→local loop test below works
      uplinkTopicRewrite: { from: 'msh/US/LA', to: 'msh/US/TX' },
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
    const upstreamSeen: Array<{ topic: string; payload: Buffer }> = [];
    await new Promise<void>((resolve, reject) => {
      upstreamClient!.subscribe('msh/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
    upstreamClient.on('message', (topic, payload) => {
      upstreamSeen.push({ topic, payload });
    });

    // Local device publishes to the local broker on the LA root — bridge
    // picks it up via the parent broker's local-packet event and uplinks
    // it with the topic rewritten to TX.
    const localPublisher = connect(`mqtt://127.0.0.1:${localPort}`, {
      username: 'u',
      password: 'p',
      reconnectPeriod: 0,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('local connect timeout')), 3000);
      localPublisher.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });

    const envelope = buildPositionEnvelope({
      from: 0x22222222,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!22222222',
      packetId: 0x30000002,
    });
    localPublisher.publish('msh/US/LA/2/e/Foo', envelope);
    await new Promise((r) => setTimeout(r, 400));

    // Upstream should see msh/US/TX/2/e/Foo (rewritten), not msh/US/LA.
    expect(upstreamSeen.some((m) => m.topic === 'msh/US/TX/2/e/Foo')).toBe(true);
    expect(upstreamSeen.some((m) => m.topic === 'msh/US/LA/2/e/Foo')).toBe(false);

    await new Promise<void>((r) => localPublisher.end(true, {}, () => r()));
  });

  it('bidirectional rewrite suppresses the echo loop (no runaway republish)', async () => {
    bridge = new MqttBridgeManager('loop-bridge', 'Loop', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/US/TX/#'],
      downlinkTopicRewrite: { from: 'msh/US/TX', to: 'msh/US/LA' },
      uplinkTopicRewrite: { from: 'msh/US/LA', to: 'msh/US/TX' },
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
    const upstreamSeen: Array<{ topic: string; payload: Buffer }> = [];
    await new Promise<void>((resolve, reject) => {
      upstreamClient!.subscribe('msh/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
    upstreamClient.on('message', (topic, payload) => {
      upstreamSeen.push({ topic, payload });
    });

    // A separate upstream publisher emits a TX packet — the bridge ingests,
    // rewrites to LA, and republishes locally. The parent broker's
    // local-packet event then runs through the uplink path which rewrites
    // back to TX. Without echo suppression this would loop forever; with
    // it, the upstream broker should only see the original packet a
    // bounded number of times (1: the original publish; if the loop
    // suppression were broken, we'd see many more).
    const pub = connect(`mqtt://127.0.0.1:${upstreamPort}`, { reconnectPeriod: 0 });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pub connect timeout')), 3000);
      pub.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
    const envelope = buildPositionEnvelope({
      from: 0x33333333,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!33333333',
      packetId: 0x30000003,
    });
    pub.publish('msh/US/TX/2/e/Foo', envelope);

    // Give the system 1s to settle. A broken loop would emit hundreds of
    // messages in that window.
    await new Promise((r) => setTimeout(r, 1000));

    // Count appearances on upstream of THIS packet (any topic). Cap at a
    // small number — 1 original + at most 1 echo before suppression kicks
    // in is fine; 10+ would indicate runaway.
    const matchingPayloads = upstreamSeen.filter((m) => Buffer.compare(m.payload, envelope) === 0);
    expect(matchingPayloads.length).toBeLessThan(5);

    // Also confirm the bridge's uplinkOut counter is bounded (not 100+).
    expect(bridge.getStatus().uplinkOut).toBeLessThan(5);

    await new Promise<void>((r) => pub.end(true, {}, () => r()));
  });

  it('no rewrite configured: republish topic matches the original (regression guard)', async () => {
    bridge = new MqttBridgeManager('no-rewrite-bridge', 'NoRewrite', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/#'],
      // No rewrite fields — must behave exactly like the pre-#3166 bridge.
    });
    await sourceManagerRegistry.addManager(bridge);

    const localClient = connect(`mqtt://127.0.0.1:${localPort}`, {
      username: 'u',
      password: 'p',
      reconnectPeriod: 0,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('local connect timeout')), 3000);
      localClient.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
    const localMessages: Array<{ topic: string }> = [];
    await new Promise<void>((resolve, reject) => {
      localClient.subscribe('msh/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
    localClient.on('message', (topic) => {
      localMessages.push({ topic });
    });

    const pub = connect(`mqtt://127.0.0.1:${upstreamPort}`, { reconnectPeriod: 0 });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pub connect timeout')), 3000);
      pub.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
    const envelope = buildPositionEnvelope({
      from: 0x44444444,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!44444444',
      packetId: 0x30000004,
    });
    pub.publish('msh/CA/ON/PTBO', envelope);
    await new Promise((r) => setTimeout(r, 300));

    expect(localMessages.some((m) => m.topic === 'msh/CA/ON/PTBO')).toBe(true);

    await new Promise<void>((r) => localClient.end(true, {}, () => r()));
    await new Promise<void>((r) => pub.end(true, {}, () => r()));
  });

  it('rewrite prefix mismatch falls through to original topic (no-op for non-matching prefixes)', async () => {
    bridge = new MqttBridgeManager('mismatch-bridge', 'Mismatch', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/#'],
      // Rewrite TX→LA, but the inbound packet is on CA — should pass through.
      downlinkTopicRewrite: { from: 'msh/US/TX', to: 'msh/US/LA' },
    });
    await sourceManagerRegistry.addManager(bridge);

    const localClient = connect(`mqtt://127.0.0.1:${localPort}`, {
      username: 'u',
      password: 'p',
      reconnectPeriod: 0,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('local connect timeout')), 3000);
      localClient.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
    const localMessages: Array<{ topic: string }> = [];
    await new Promise<void>((resolve, reject) => {
      localClient.subscribe('msh/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
    localClient.on('message', (topic) => {
      localMessages.push({ topic });
    });

    const pub = connect(`mqtt://127.0.0.1:${upstreamPort}`, { reconnectPeriod: 0 });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pub connect timeout')), 3000);
      pub.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
    const envelope = buildPositionEnvelope({
      from: 0x55555555,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!55555555',
      packetId: 0x30000005,
    });
    pub.publish('msh/CA/ON/PTBO', envelope);
    await new Promise((r) => setTimeout(r, 300));

    // CA topic doesn't match the TX→LA rule — must pass through unchanged.
    expect(localMessages.some((m) => m.topic === 'msh/CA/ON/PTBO')).toBe(true);
    expect(localMessages.some((m) => m.topic.startsWith('msh/US/LA'))).toBe(false);

    await new Promise<void>((r) => localClient.end(true, {}, () => r()));
    await new Promise<void>((r) => pub.end(true, {}, () => r()));
  });
});
