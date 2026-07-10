import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { connect, type MqttClient } from 'mqtt';

const upsertNode = vi.fn();
const insertTelemetry = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: async (...a: unknown[]) => upsertNode(...a),
    insertTelemetryAsync: async (...a: unknown[]) => insertTelemetry(...a),
    insertTracerouteAsync: vi.fn(async () => undefined),
    insertRouteSegmentAsync: vi.fn(async () => undefined),
  },
}));

import { MqttBrokerManager } from './mqttBrokerManager.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { PortNum } from './constants/meshtastic.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

// Reserve an ephemeral port by binding briefly with the OS.
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

function waitForEvent(client: MqttClient, event: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    client.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function buildNodeInfoEnvelope(opts: {
  from: number;
  channelId: string;
  gatewayId: string;
  longName: string;
  shortName: string;
}): Buffer {
  const r = getProtobufRoot();
  if (!r) throw new Error('protobuf root not loaded');
  const UserType = r.lookupType('meshtastic.User');
  const userPayload = UserType.encode(
    UserType.create({ longName: opts.longName, shortName: opts.shortName, hwModel: 9 }),
  ).finish();
  const bytes = meshtasticProtobufService.encodeServiceEnvelope({
    packet: {
      from: opts.from,
      to: 0xffffffff,
      channel: 0,
      id: 0x12345678,
      decoded: { portnum: PortNum.NODEINFO_APP, payload: userPayload },
    },
    channelId: opts.channelId,
    gatewayId: opts.gatewayId,
  });
  if (!bytes) throw new Error('encode failed');
  return Buffer.from(bytes);
}

describe('MqttBrokerManager', () => {
  let port: number;
  let manager: MqttBrokerManager;
  let client: MqttClient | null = null;

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    upsertNode.mockClear();
    insertTelemetry.mockClear();
    port = await ephemeralPort();
    manager = new MqttBrokerManager('test-broker', 'Test Broker', {
      listener: { port, host: '127.0.0.1' },
      auth: { username: 'mm', password: 's3cret' },
      gateway: { nodeNum: 0xdeadbeef, nodeId: '!deadbeef', longName: 'MM', shortName: 'MM' },
      rootTopic: 'msh',
    });
    await manager.start();
  });

  afterEach(async () => {
    if (client) {
      await new Promise<void>((r) => client!.end(true, {}, () => r()));
      client = null;
    }
    await manager.stop();
  });

  it('reports listening status after start', () => {
    const s = manager.getStatus();
    expect(s.listening).toBe(true);
    expect(s.connected).toBe(true);
    expect(s.sourceType).toBe('mqtt_broker');
    expect(s.sourceId).toBe('test-broker');
  });

  it('rejects clients with bad credentials', async () => {
    client = connect(`mqtt://127.0.0.1:${port}`, {
      username: 'mm',
      password: 'wrong',
      reconnectPeriod: 0,
      connectTimeout: 2000,
    });
    await expect(waitForEvent(client, 'connect', 2000)).rejects.toThrow();
  });

  it('accepts clients with correct credentials and ingests a NODEINFO publish', async () => {
    client = connect(`mqtt://127.0.0.1:${port}`, {
      username: 'mm',
      password: 's3cret',
      reconnectPeriod: 0,
    });
    await waitForEvent(client, 'connect');

    const envelopeBytes = buildNodeInfoEnvelope({
      from: 0x7ff80a48,
      channelId: 'LongFast',
      gatewayId: '!7ff80a48',
      longName: 'Test Node',
      shortName: 'TST',
    });

    const localPacketPromise = new Promise<void>((resolve) => {
      manager.once('local-packet', () => resolve());
    });

    await new Promise<void>((resolve, reject) => {
      client!.publish(
        'msh/US/2/e/LongFast/!7ff80a48',
        envelopeBytes,
        { qos: 0 },
        (err) => (err ? reject(err) : resolve()),
      );
    });

    await localPacketPromise;

    // upsertNode should have been called with our node's data.
    expect(upsertNode).toHaveBeenCalled();
    const arg = upsertNode.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.nodeNum).toBe(0x7ff80a48);
    expect(arg.nodeId).toBe('!7ff80a48');
    expect(arg.longName).toBe('Test Node');
    expect(arg.shortName).toBe('TST');
    expect(arg.sourceId).toBe('test-broker');

    // local-packet emits before ingestServiceEnvelope's .then runs that
    // increments packetsIngested. Wait for the counter to settle instead
    // of asserting on the immediate post-emit tick.
    await vi.waitFor(() => {
      const s = manager.getStatus();
      expect(s.packetsIn).toBeGreaterThanOrEqual(1);
      expect(s.packetsIngested).toBeGreaterThanOrEqual(1);
    });
    expect(manager.getStatus().clientCount).toBe(1);
  });

  it('drops publishes on topics outside the root topic', async () => {
    client = connect(`mqtt://127.0.0.1:${port}`, {
      username: 'mm',
      password: 's3cret',
      reconnectPeriod: 0,
    });
    await waitForEvent(client, 'connect');

    await new Promise<void>((resolve, reject) => {
      client!.publish('off-topic/foo', Buffer.from('hello'), { qos: 0 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });

    // Give Aedes a moment to dispatch.
    await new Promise((r) => setTimeout(r, 100));

    expect(upsertNode).not.toHaveBeenCalled();
    const status = manager.getStatus();
    expect(status.packetsDropped).toBeGreaterThanOrEqual(1);
    expect(status.packetsIngested).toBe(0);
  });
});

describe('MqttBrokerManager zero-hop injection', () => {
  let port: number;
  let manager: MqttBrokerManager | null = null;
  let publisher: MqttClient | null = null;
  let subscriber: MqttClient | null = null;

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  afterEach(async () => {
    for (const c of [publisher, subscriber]) {
      if (c) await new Promise<void>((r) => c.end(true, {}, () => r()));
    }
    publisher = null;
    subscriber = null;
    if (manager) {
      await manager.stop();
      manager = null;
    }
  });

  async function startManager(opts: { zeroHop: boolean }): Promise<void> {
    port = await ephemeralPort();
    manager = new MqttBrokerManager('zhi-broker', 'Zero Hop Broker', {
      listener: { port, host: '127.0.0.1' },
      auth: { username: 'mm', password: 's3cret' },
      gateway: { nodeNum: 0xdeadbeef, nodeId: '!deadbeef', longName: 'MM', shortName: 'MM' },
      rootTopic: 'msh',
      zeroHopInjection: opts.zeroHop,
    });
    await manager.start();
  }

  function buildEnvelopeWithHopLimit(hopLimit: number): Buffer {
    const bytes = meshtasticProtobufService.encodeServiceEnvelope({
      packet: {
        from: 0x12345678,
        to: 0xffffffff,
        channel: 0,
        id: 0xabcdef01,
        hopLimit,
        hopStart: hopLimit,
        decoded: { portnum: PortNum.TEXT_MESSAGE_APP, payload: new Uint8Array([0x68, 0x69]) },
      },
      channelId: 'LongFast',
      gatewayId: '!12345678',
    });
    if (!bytes) throw new Error('encode failed');
    return Buffer.from(bytes);
  }

  async function connectClient(clientId: string): Promise<MqttClient> {
    const c = connect(`mqtt://127.0.0.1:${port}`, {
      username: 'mm',
      password: 's3cret',
      reconnectPeriod: 0,
      clientId,
    });
    await waitForEvent(c, 'connect');
    return c;
  }

  it('clamps hop_limit to 0 on the payload delivered to subscribers when enabled', async () => {
    await startManager({ zeroHop: true });

    subscriber = await connectClient('sub');
    await new Promise<void>((resolve, reject) => {
      subscriber!.subscribe('msh/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });

    publisher = await connectClient('pub');
    const original = buildEnvelopeWithHopLimit(3);

    const receivedPromise = new Promise<Buffer>((resolve) => {
      subscriber!.once('message', (_topic, payload) => resolve(payload));
    });

    await new Promise<void>((resolve, reject) => {
      publisher!.publish('msh/US/2/e/LongFast/!12345678', original, { qos: 0 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });

    const received = await receivedPromise;
    const decoded = meshtasticProtobufService.decodeServiceEnvelope(received);
    expect(decoded).not.toBeNull();
    // proto3 omits zero values on encode, so the decoded field is either 0 or undefined.
    expect(decoded!.packet.hopLimit ?? 0).toBe(0);
    // hop_start should be preserved for downstream diagnostics.
    expect(decoded!.packet.hopStart).toBe(3);
  });

  it('forwards the payload byte-for-byte when zeroHopInjection is disabled', async () => {
    await startManager({ zeroHop: false });

    subscriber = await connectClient('sub');
    await new Promise<void>((resolve, reject) => {
      subscriber!.subscribe('msh/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });

    publisher = await connectClient('pub');
    const original = buildEnvelopeWithHopLimit(3);

    const receivedPromise = new Promise<Buffer>((resolve) => {
      subscriber!.once('message', (_topic, payload) => resolve(payload));
    });

    await new Promise<void>((resolve, reject) => {
      publisher!.publish('msh/US/2/e/LongFast/!12345678', original, { qos: 0 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });

    const received = await receivedPromise;
    expect(received.equals(original)).toBe(true);
  });

  it('local-packet event carries the original (un-zeroed) payload', async () => {
    await startManager({ zeroHop: true });

    publisher = await connectClient('pub');
    const original = buildEnvelopeWithHopLimit(5);

    const localPacketPromise = new Promise<Buffer>((resolve) => {
      manager!.once('local-packet', (p: { payload: Buffer }) => resolve(p.payload));
    });

    await new Promise<void>((resolve, reject) => {
      publisher!.publish('msh/US/2/e/LongFast/!12345678', original, { qos: 0 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });

    const captured = await localPacketPromise;
    const decoded = meshtasticProtobufService.decodeServiceEnvelope(captured);
    expect(decoded).not.toBeNull();
    expect(decoded!.packet.hopLimit).toBe(5);
    expect(decoded!.packet.hopStart).toBe(5);
  });

  it('passes garbage payloads through unchanged when enabled', async () => {
    await startManager({ zeroHop: true });

    subscriber = await connectClient('sub');
    await new Promise<void>((resolve, reject) => {
      subscriber!.subscribe('msh/garbage/#', { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });

    publisher = await connectClient('pub');
    const garbage = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb]);

    const receivedPromise = new Promise<Buffer>((resolve) => {
      subscriber!.once('message', (_topic, payload) => resolve(payload));
    });

    await new Promise<void>((resolve, reject) => {
      publisher!.publish('msh/garbage/topic', garbage, { qos: 0 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });

    const received = await receivedPromise;
    expect(received.equals(garbage)).toBe(true);
  });
});
