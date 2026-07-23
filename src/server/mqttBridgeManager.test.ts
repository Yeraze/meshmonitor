import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { connect, type MqttClient } from 'mqtt';
import { Aedes } from 'aedes';
import { createServer, type Server } from 'net';

const upsertNode = vi.fn();
const insertTelemetry = vi.fn();
const insertMessage = vi.fn(async () => true);
const deleteNode = vi.fn(async () => ({
  messagesDeleted: 0,
  broadcastMessagesDeleted: 0,
  traceroutesDeleted: 0,
  telemetryDeleted: 0,
  nodeDeleted: true,
}));
const getNode = vi.fn(async () => null);

// Stateful fake for ignored_nodes (Phase 2 geo-ignore). Mirrors the real
// IgnoredNodesRepository's cache-key shape (`${sourceId}:${nodeNum}`) and its
// reason semantics (geo-ignore is insert-if-absent; lift only removes
// reason='geo', never 'manual') closely enough for the bridge-path coverage
// below. See src/server/mqttBrokerManager.test.ts for the sibling fake used
// by the broker-path (manual-ignore-only) tests.
const ignoredRecords = new Map<string, { reason: 'manual' | 'geo' }>();
function ignoreKey(nodeNum: number, sourceId: string): string {
  return `${sourceId}:${nodeNum}`;
}
const isIgnoredCached = vi.fn((nodeNum: number, sourceId: string) =>
  ignoredRecords.has(ignoreKey(nodeNum, sourceId)));
const addGeoIgnoreAsync = vi.fn(async (nodeNum: number, sourceId: string) => {
  const key = ignoreKey(nodeNum, sourceId);
  if (ignoredRecords.has(key)) return false;
  ignoredRecords.set(key, { reason: 'geo' });
  return true;
});
const liftGeoIgnoreAsync = vi.fn(async (nodeNum: number, sourceId: string) => {
  const key = ignoreKey(nodeNum, sourceId);
  const rec = ignoredRecords.get(key);
  if (!rec || rec.reason !== 'geo') return false;
  ignoredRecords.delete(key);
  return true;
});
const isNodeIgnoredAsync = vi.fn(async (nodeNum: number, sourceId: string) =>
  ignoredRecords.has(ignoreKey(nodeNum, sourceId)));
const getIgnoredNodesAsync = vi.fn(async (sourceId?: string) =>
  Array.from(ignoredRecords.entries())
    .filter(([key]) => !sourceId || key.startsWith(`${sourceId}:`))
    .map(([key, rec]) => {
      // Split on the LAST colon — nodeNum is the trailing numeric segment
      // (mirrors the real cacheKey contract), so a colon-bearing sourceId
      // can't skew the parse.
      const colon = key.lastIndexOf(':');
      return {
        nodeNum: Number(key.slice(colon + 1)),
        sourceId: key.slice(0, colon),
        reason: rec.reason,
      };
    }));

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: async (...a: unknown[]) => upsertNode(...a),
    insertTelemetryAsync: async (...a: unknown[]) => insertTelemetry(...a),
    insertTracerouteAsync: vi.fn(async () => undefined),
    insertRouteSegmentAsync: vi.fn(async () => undefined),
    deleteNodeAsync: async (...a: unknown[]) => deleteNode(...a),
    nodes: {
      getNode: async (...a: unknown[]) => getNode(...a),
    },
    messages: {
      insertMessage: async (...a: unknown[]) => insertMessage(...a),
      getMessage: vi.fn(async () => null),
    },
    ignoredNodes: {
      isIgnoredCached: (...a: unknown[]) => isIgnoredCached(...(a as [number, string])),
      addGeoIgnoreAsync: async (...a: unknown[]) => addGeoIgnoreAsync(...(a as [number, string])),
      liftGeoIgnoreAsync: async (...a: unknown[]) => liftGeoIgnoreAsync(...(a as [number, string])),
      isNodeIgnoredAsync: async (...a: unknown[]) => isNodeIgnoredAsync(...(a as [number, string])),
      getIgnoredNodesAsync: async (...a: unknown[]) => getIgnoredNodesAsync(...(a as [string | undefined])),
    },
    // Inline auto-delete-by-distance (#3900) reads per-source settings on each
    // POSITION packet. Return null so the feature reads as disabled and the
    // inline check is a no-op for this suite.
    settings: {
      getSettingForSource: async () => null,
    },
    setNodeIgnoredAsync: vi.fn(async () => undefined),
  },
}));

// mqttGeoSweepService is mocked at the module level (rather than let a real
// sweep run) because `start()` now fires a sweep on every single test in
// this file via `sourceManagerRegistry.addManager()`, and the database mock
// above has no `nodes.getAllNodes` — a real sweep would throw on every test.
// The dedicated "geo sweep integration" block below asserts on this mock's
// call args instead of on sweep side effects.
const runSweep = vi.fn(async () => ({
  sourceId: 'unset',
  timestamp: Date.now(),
  scanned: 0,
  ignored: 0,
  purged: 0,
  lifted: 0,
  durationMs: 0,
}));

vi.mock('./services/mqttGeoSweepService.js', () => ({
  mqttGeoSweepService: { runSweep: (...a: unknown[]) => runSweep(...a) },
}));

import { MqttBrokerManager } from './mqttBrokerManager.js';
import { MqttBridgeManager } from './mqttBridgeManager.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import databaseService from '../services/database.js';
import { PortNum } from './constants/meshtastic.js';
import type { GeoSweepStats } from './services/mqttGeoSweepService.js';
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
  /**
   * `Data.bitfield` value. Defaults to 1 (ok_to_mqtt bit set) so existing
   * tests pass the bridge's ok_to_mqtt gate without explicit opt-in. The
   * gate test below uses bitfield=0 to verify the drop path.
   */
  bitfield?: number;
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
      decoded: {
        portnum: PortNum.POSITION_APP,
        payload: positionPayload,
        bitfield: opts.bitfield ?? 1,
      },
    },
    channelId: opts.channelId,
    gatewayId: opts.gatewayId,
  });
  if (!bytes) throw new Error('encode failed');
  return Buffer.from(bytes);
}

function buildNodeInfoEnvelope(opts: {
  from: number;
  longName: string;
  shortName: string;
  channelId: string;
  gatewayId: string;
  packetId?: number;
}): Buffer {
  const r = getProtobufRoot();
  if (!r) throw new Error('protobuf root not loaded');
  const User = r.lookupType('meshtastic.User');
  const userPayload = User.encode(
    User.create({ longName: opts.longName, shortName: opts.shortName, hwModel: 9 }),
  ).finish();
  const bytes = meshtasticProtobufService.encodeServiceEnvelope({
    packet: {
      from: opts.from,
      to: 0xffffffff,
      channel: 0,
      id: opts.packetId ?? 0xabcdef02,
      decoded: { portnum: PortNum.NODEINFO_APP, payload: userPayload, bitfield: 1 },
    },
    channelId: opts.channelId,
    gatewayId: opts.gatewayId,
  });
  if (!bytes) throw new Error('encode failed');
  return Buffer.from(bytes);
}

function buildTextEnvelope(opts: {
  from: number;
  text: string;
  channelId: string;
  gatewayId: string;
  packetId?: number;
}): Buffer {
  const textPayload = new TextEncoder().encode(opts.text);
  const bytes = meshtasticProtobufService.encodeServiceEnvelope({
    packet: {
      from: opts.from,
      to: 0xffffffff,
      channel: 0,
      id: opts.packetId ?? 0xabcdef03,
      decoded: { portnum: PortNum.TEXT_MESSAGE_APP, payload: textPayload, bitfield: 1 },
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
    insertTelemetry.mockClear();
    insertMessage.mockClear();
    deleteNode.mockClear();
    getNode.mockClear();
    isIgnoredCached.mockClear();
    addGeoIgnoreAsync.mockClear();
    liftGeoIgnoreAsync.mockClear();
    isNodeIgnoredAsync.mockClear();
    getIgnoredNodesAsync.mockClear();
    ignoredRecords.clear();
    runSweep.mockClear();

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

  // ---------------------------------------------------------------------------
  // Geo-ignore gating (MQTT Geo-Ignore epic, Phase 2, #4115). MqttPacketFilter
  // no longer tracks node membership — handleDownlink instead consults
  // databaseService.ignoredNodes (isIgnoredCached / addGeoIgnoreAsync /
  // liftGeoIgnoreAsync / isNodeIgnoredAsync), which ingestServiceEnvelope
  // populates on POSITION evaluation. These tests replace the old
  // "fail-closed membership" coverage with the new fail-open-by-default +
  // ignore-list model.
  // ---------------------------------------------------------------------------

  async function connectUpstream(): Promise<void> {
    upstreamClient = connect(`mqtt://127.0.0.1:${upstreamPort}`, { reconnectPeriod: 0 });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('upstream connect timeout')), 3000);
      upstreamClient!.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async function connectLocalSubscriber(): Promise<{
    client: MqttClient;
    messages: Array<{ topic: string; payload: Buffer }>;
  }> {
    const client = connect(`mqtt://127.0.0.1:${localPort}`, {
      username: 'u',
      password: 'p',
      reconnectPeriod: 0,
    });
    const messages: Array<{ topic: string; payload: Buffer }> = [];
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('local connect timeout')), 3000);
      client.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      client.subscribe('msh/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
    client.on('message', (topic, payload) => {
      messages.push({ topic, payload });
    });
    return { client, messages };
  }

  const GEO_BBOX = { minLat: 43, maxLat: 45, minLng: -80, maxLng: -77 };

  it('#4115: with a bbox configured, a NODEINFO from a never-seen sender still ingests (fail-open)', async () => {
    bridge = new MqttBridgeManager('test-bridge', 'Bridge', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/CA/#'],
      downlinkFilters: { geo: GEO_BBOX },
    });
    await sourceManagerRegistry.addManager(bridge);
    await connectUpstream();

    const NEVER_SEEN = 0xf68f52d8;
    const envelope = buildNodeInfoEnvelope({
      from: NEVER_SEEN,
      longName: 'New Node',
      shortName: 'NEW',
      channelId: 'LongFast',
      gatewayId: '!f68f52d8',
      packetId: 0x50000001,
    });
    upstreamClient!.publish('msh/CA/ON/PTBO', envelope);

    await vi.waitFor(() => {
      expect(bridge.getStatus().downlinkIngested).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    expect(upsertNode).toHaveBeenCalled();
  });

  it('drops an out-of-bbox POSITION, geo-ignores the sender (reason: geo), and does not republish', async () => {
    bridge = new MqttBridgeManager('test-bridge', 'Bridge', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/CA/#'],
      downlinkFilters: { geo: GEO_BBOX },
    });
    await sourceManagerRegistry.addManager(bridge);
    await connectUpstream();
    const { client: localClient, messages: localMessages } = await connectLocalSubscriber();

    const OUT_NODE = 0x22222222;
    const outBboxEnvelope = buildPositionEnvelope({
      from: OUT_NODE,
      latI: 420_000_000, // outside GEO_BBOX (minLat 43)
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!22222222',
      packetId: 0x10000002,
    });
    upstreamClient!.publish('msh/CA/ON/PTBO', outBboxEnvelope);

    await vi.waitFor(async () => {
      expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(OUT_NODE, 'test-bridge')).toBe(true);
    }, { timeout: 3000 });

    const records = await databaseService.ignoredNodes.getIgnoredNodesAsync('test-bridge');
    const rec = records.find((r) => r.nodeNum === OUT_NODE);
    expect(rec?.reason).toBe('geo');

    expect(bridge.getStatus().downlinkDrops.geo).toBe(1);

    // Give any (incorrect) republish a moment to land before asserting absence.
    await new Promise((r) => setTimeout(r, 200));
    expect(localMessages.some((m) => m.topic === 'msh/CA/ON/PTBO')).toBe(false);

    await new Promise<void>((r) => localClient.end(true, {}, () => r()));
  });

  it('ingests and republishes an in-bbox POSITION normally', async () => {
    bridge = new MqttBridgeManager('test-bridge', 'Bridge', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/CA/#'],
      downlinkFilters: { geo: GEO_BBOX },
    });
    await sourceManagerRegistry.addManager(bridge);
    await connectUpstream();
    const { client: localClient, messages: localMessages } = await connectLocalSubscriber();

    const IN_NODE = 0x11111111;
    const inBboxEnvelope = buildPositionEnvelope({
      from: IN_NODE,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!11111111',
      packetId: 0x10000001,
    });
    upstreamClient!.publish('msh/CA/ON/PTBO', inBboxEnvelope);

    await vi.waitFor(() => {
      expect(bridge.getStatus().downlinkIngested).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    await vi.waitFor(() => {
      expect(localMessages.some((m) => m.topic === 'msh/CA/ON/PTBO')).toBe(true);
    }, { timeout: 3000 });
    expect(bridge.getStatus().downlinkDrops.geo).toBe(0);

    await new Promise<void>((r) => localClient.end(true, {}, () => r()));
  });

  it('drops subsequent TEXT from a geo-ignored sender: not ingested, not republished, no local-packet emit', async () => {
    bridge = new MqttBridgeManager('test-bridge', 'Bridge', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/CA/#'],
      downlinkFilters: { geo: GEO_BBOX },
    });
    await sourceManagerRegistry.addManager(bridge);
    await connectUpstream();
    const { client: localClient, messages: localMessages } = await connectLocalSubscriber();

    const localPackets: Array<{ topic: string }> = [];
    bridge.on('local-packet', (p: { topic: string }) => {
      localPackets.push({ topic: p.topic });
    });

    const OUT_NODE = 0x22222222;
    const outBboxEnvelope = buildPositionEnvelope({
      from: OUT_NODE,
      latI: 420_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!22222222',
      packetId: 0x10000002,
    });
    upstreamClient!.publish('msh/CA/ON/PTBO', outBboxEnvelope);

    // Wait for the POSITION to actually land the geo-ignore (async) so the
    // subsequent TEXT packet's synchronous isIgnoredCached() check sees it.
    await vi.waitFor(async () => {
      expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(OUT_NODE, 'test-bridge')).toBe(true);
    }, { timeout: 3000 });

    // Snapshot counters after the (already-ignored-by-the-time-it-lands)
    // POSITION packet — its own local-packet emission raced the async
    // ignore write and may have already fired once; what matters is that
    // the FOLLOWING TEXT packet adds nothing further.
    const ingestedBefore = bridge.getStatus().downlinkIngested;
    const localPacketsBefore = localPackets.length;
    const localMessagesBefore = localMessages.length;

    const textEnvelope = buildTextEnvelope({
      from: OUT_NODE,
      text: 'hello from an ignored sender',
      channelId: 'LongFast',
      gatewayId: '!22222222',
      packetId: 0x10000010,
    });
    upstreamClient!.publish('msh/CA/ON/PTBO', textEnvelope);

    // Let the (non-)flow settle.
    await new Promise((r) => setTimeout(r, 300));

    expect(bridge.getStatus().downlinkIngested).toBe(ingestedBefore);
    expect(localPackets.length).toBe(localPacketsBefore);
    expect(localMessages.length).toBe(localMessagesBefore);
    expect(insertMessage).not.toHaveBeenCalled();

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

  it('in default per_gateway mode, dispatches uplink publishes through a per-gateway upstream connection', async () => {
    // Record every CONNECT and every publish the upstream broker sees so
    // we can prove the bridge opened a connection whose clientId matches
    // the envelope's gateway_id, not the legacy `mm-bridge-…` prefix.
    const connects: string[] = [];
    const publishesByClient: Array<{ clientId: string | null; topic: string }> = [];
    upstream.aedes.on('client', (c) => connects.push(c.id));
    upstream.aedes.on('publish', (packet, client) => {
      if (!client) return;
      publishesByClient.push({ clientId: client.id, topic: packet.topic });
    });

    bridge = new MqttBridgeManager('per-gw-bridge', 'PerGW', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      // No explicit forwardingMode — should default to per_gateway.
      subscriptions: [],
      mode: 'publish_only',
    });
    await sourceManagerRegistry.addManager(bridge);

    // A local Meshtastic client publishes through the embedded broker;
    // gateway_id is intentionally DIFFERENT from the broker's own
    // !deadbeef so the pool has to create a new entry.
    const localClient = connect(`mqtt://127.0.0.1:${localPort}`, {
      username: 'u',
      password: 'p',
      reconnectPeriod: 0,
      clientId: '!11111111', // a local gateway node connecting to our embedded broker
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('local connect timeout')), 3000);
      localClient.once('connect', () => {
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
    localClient.publish('msh/CA/ON/PTBO', envelope);

    // Wait for the uplink chain: local → embedded broker → bridge.handleUplink
    // → pool.publish → upstream Aedes records the publish.
    await new Promise((r) => setTimeout(r, 600));

    // The bridge's subscriber connected as the broker's gateway nodeId.
    expect(connects).toContain('!deadbeef');
    // The pool opened a separate per-gateway connection for the local node.
    expect(connects).toContain('!11111111');

    // The uplink publish rode the per-gateway connection, not the subscriber.
    const fromGateway = publishesByClient.filter((p) => p.clientId === '!11111111');
    expect(fromGateway.length).toBeGreaterThanOrEqual(1);
    expect(fromGateway[0].topic).toBe('msh/CA/ON/PTBO');

    // Status surface reports the publisher pool entry.
    const status = bridge.getStatus();
    expect(status.forwardingMode).toBe('per_gateway');
    expect(Object.keys(status.publishers)).toContain('!11111111');

    await new Promise<void>((r) => localClient.end(true, {}, () => r()));
  });

  it('in single mode, uplink rides the legacy `mm-bridge-…` connection with no publisher pool', async () => {
    const connects: string[] = [];
    upstream.aedes.on('client', (c) => connects.push(c.id));

    bridge = new MqttBridgeManager('single-bridge', 'Single', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: [],
      mode: 'publish_only',
      forwardingMode: 'single',
    });
    await sourceManagerRegistry.addManager(bridge);

    const localClient = connect(`mqtt://127.0.0.1:${localPort}`, {
      username: 'u',
      password: 'p',
      reconnectPeriod: 0,
      clientId: '!22222222',
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('local connect timeout')), 3000);
      localClient.once('connect', () => {
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
    localClient.publish('msh/CA/ON/PTBO', envelope);

    await new Promise((r) => setTimeout(r, 400));

    // Only the legacy `mm-bridge-…` prefix shows up — no per-gateway
    // connections were ever created.
    expect(connects.some((id) => id.startsWith('mm-bridge-single-bridge-'))).toBe(true);
    expect(connects).not.toContain('!22222222');

    const status = bridge.getStatus();
    expect(status.forwardingMode).toBe('single');
    expect(status.publishers).toEqual({});

    await new Promise<void>((r) => localClient.end(true, {}, () => r()));
  });

  it('honors ok_to_mqtt: drops uplink packets whose Data.bitfield bit 0 is unset', async () => {
    const publishesByClient: Array<{ clientId: string | null; topic: string }> = [];
    upstream.aedes.on('publish', (packet, client) => {
      if (!client) return;
      publishesByClient.push({ clientId: client.id, topic: packet.topic });
    });

    bridge = new MqttBridgeManager('ok-bit-bridge', 'OkBit', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: [],
      mode: 'publish_only',
    });
    await sourceManagerRegistry.addManager(bridge);

    const localClient = connect(`mqtt://127.0.0.1:${localPort}`, {
      username: 'u',
      password: 'p',
      reconnectPeriod: 0,
      clientId: '!11111111',
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('local connect timeout')), 3000);
      localClient.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });

    // bit 0 unset → originator opted out of MQTT relay → bridge must drop.
    const optOutEnvelope = buildPositionEnvelope({
      from: 0x11111111,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!11111111',
      packetId: 0x40000001,
      bitfield: 0,
    });
    // bit 0 set → opt-in → bridge must republish.
    const optInEnvelope = buildPositionEnvelope({
      from: 0x11111111,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!11111111',
      packetId: 0x40000002,
      bitfield: 1,
    });

    localClient.publish('msh/CA/ON/PTBO', optOutEnvelope);
    localClient.publish('msh/CA/ON/PTBO', optInEnvelope);

    await new Promise((r) => setTimeout(r, 500));

    // Only the opt-in packet should have reached the upstream broker.
    const upstreamPublishes = publishesByClient.filter((p) => p.topic === 'msh/CA/ON/PTBO');
    expect(upstreamPublishes.length).toBe(1);

    // Drop counter recorded the opt-out packet.
    expect(bridge.getStatus().uplinkOkToMqttDrops).toBeGreaterThanOrEqual(1);

    await new Promise<void>((r) => localClient.end(true, {}, () => r()));
  });

  it('ignoreOkToMqtt: true uplinks packets regardless of the bit', async () => {
    const publishesByClient: Array<{ clientId: string | null; topic: string }> = [];
    upstream.aedes.on('publish', (packet, client) => {
      if (!client) return;
      publishesByClient.push({ clientId: client.id, topic: packet.topic });
    });

    bridge = new MqttBridgeManager('ignore-ok-bridge', 'IgnoreOk', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: [],
      mode: 'publish_only',
      ignoreOkToMqtt: true,
    });
    await sourceManagerRegistry.addManager(bridge);

    const localClient = connect(`mqtt://127.0.0.1:${localPort}`, {
      username: 'u',
      password: 'p',
      reconnectPeriod: 0,
      clientId: '!22222222',
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('local connect timeout')), 3000);
      localClient.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
    });

    // bit 0 unset — but the override bypasses the gate.
    const optOutEnvelope = buildPositionEnvelope({
      from: 0x22222222,
      latI: 440_000_000,
      lngI: -780_000_000,
      channelId: 'LongFast',
      gatewayId: '!22222222',
      packetId: 0x40000003,
      bitfield: 0,
    });
    localClient.publish('msh/CA/ON/PTBO', optOutEnvelope);

    await new Promise((r) => setTimeout(r, 500));

    // Despite bit 0 being unset, the packet was forwarded upstream.
    expect(publishesByClient.some((p) => p.topic === 'msh/CA/ON/PTBO')).toBe(true);
    // And the drop counter stayed at zero.
    expect(bridge.getStatus().uplinkOkToMqttDrops).toBe(0);

    await new Promise<void>((r) => localClient.end(true, {}, () => r()));
  });

  // ---------------------------------------------------------------------------
  // Geo sweep integration (MQTT Geo-Ignore epic, Phase 3, WP2). WP1 built
  // mqttGeoSweepService.runSweep in isolation; these tests cover the bridge
  // manager's wiring — start() kicks off an add-only sweep, and getStatus()
  // surfaces the most recent sweep's stats via the GeoSweepStatsSink duck
  // type (recordGeoSweepStats). runSweep itself is mocked module-wide above
  // (the database mock has no nodes.getAllNodes), so these assert on the
  // call args / sink plumbing rather than sweep side effects.
  // ---------------------------------------------------------------------------

  it('#4115 Phase 3: getStatus().lastGeoSweep is null before any sweep completes', () => {
    bridge = new MqttBridgeManager('geo-sweep-status', 'GeoSweepStatus', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/#'],
    });
    expect(bridge.getStatus().lastGeoSweep).toBeNull();
  });

  it('#4115 Phase 3: start() runs an add-only geo sweep scoped to this source and its configured bbox', async () => {
    const geo = { minLat: 43, maxLat: 45, minLng: -80, maxLng: -77 };
    bridge = new MqttBridgeManager('geo-sweep-start', 'GeoSweepStart', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/#'],
      downlinkFilters: { geo },
    });
    await sourceManagerRegistry.addManager(bridge);

    expect(runSweep).toHaveBeenCalledWith(
      'geo-sweep-start',
      geo,
      expect.objectContaining({ lift: false }),
    );
  });

  it('#4115 Phase 3: recordGeoSweepStats (the GeoSweepStatsSink callback) updates getStatus().lastGeoSweep', () => {
    bridge = new MqttBridgeManager('geo-sweep-record', 'GeoSweepRecord', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/#'],
    });
    const stats: GeoSweepStats = {
      sourceId: 'geo-sweep-record',
      timestamp: 123456,
      scanned: 4,
      ignored: 2,
      purged: 2,
      lifted: 0,
      durationMs: 5,
    };

    bridge.recordGeoSweepStats(stats);

    expect(bridge.getStatus().lastGeoSweep).toEqual(stats);
  });
});
