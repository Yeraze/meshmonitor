/**
 * MeshCoreMqttManager tests (#5040 Phase 1).
 *
 * The load-bearing assertions here are the *structural* ones — that this source
 * can never be mistaken for a device-backed MeshCore source. Every TX-driving
 * scheduler and device route filters on `isMeshCoreManager()`, so if this
 * manager ever started passing that predicate it would silently be handed to
 * code that tries to talk to a radio it does not have.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const connectMock = vi.fn().mockResolvedValue(undefined);
const subscribeMock = vi.fn().mockResolvedValue(undefined);
const disconnectMock = vi.fn().mockResolvedValue(undefined);
let lastClient: FakeClient | null = null;

class FakeClient {
  handlers = new Map<string, (arg: unknown) => void>();
  connected = true;
  connect = connectMock;
  subscribe = subscribeMock;
  disconnect = disconnectMock;
  isConnected = () => this.connected;
  on(event: string, fn: (arg: unknown) => void) {
    this.handlers.set(event, fn);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  /** Drive an inbound broker message the way mqttBrokerClient would. */
  deliver(topic: string, body: unknown) {
    this.handlers.get('message')?.({ topic, payload: Buffer.from(JSON.stringify(body)) });
  }
  raise(event: string, arg: unknown) {
    this.handlers.get(event)?.(arg);
  }
}

vi.mock('./transports/mqttBrokerClient.js', () => ({
  MqttBrokerClient: class {
    constructor() {
      lastClient = new FakeClient();
      return lastClient as unknown as object;
    }
  },
}));

import { MeshCoreMqttManager } from './meshcoreMqttManager.js';
import {
  isMeshCoreManager,
  isMeshCoreMqttManager,
  isAnyMeshCoreManager,
  isMeshtasticManager,
} from './sourceManagerTypes.js';

const OBSERVER_KEY = 'AB'.repeat(32);

/**
 * Minimal valid FLOOD frame: header, path_len 0, 4 payload bytes.
 * Header 0x05 = (version 0 << 6) | (payload_type 1 << 2) | (route 1 = FLOOD).
 * Route 0 (TRANSPORT_FLOOD) and 3 (TRANSPORT_DIRECT) carry transport codes
 * before path_len, so a hand-written frame using those parses as truncated.
 */
const RAW_FRAME = '0500deadbeef';

function packetBody(overrides: Record<string, unknown> = {}) {
  return {
    type: 'PACKET',
    origin: 'SomeObserver',
    origin_id: OBSERVER_KEY,
    timestamp: new Date().toISOString(),
    raw: RAW_FRAME,
    SNR: '-8.5',
    RSSI: '-101',
    ...overrides,
  };
}

function makeManager() {
  return new MeshCoreMqttManager('src-mqtt-1', 'Region Feed', {
    brokerUrl: 'wss://broker.example:443',
    region: 'mco',
  });
}

beforeEach(() => {
  connectMock.mockClear();
  subscribeMock.mockClear();
  disconnectMock.mockClear();
  lastClient = null;
});

describe('MeshCoreMqttManager — structural no-radio guarantees', () => {
  it('is NOT narrowed by isMeshCoreManager, so device schedulers skip it', () => {
    // This is the whole TX-refusal mechanism. The five MeshCore schedulers and
    // the device/config routes all filter on isMeshCoreManager(); passing it
    // would hand a radio-less source to code that drives a radio.
    expect(isMeshCoreManager(makeManager())).toBe(false);
  });

  it('IS narrowed by isMeshCoreMqttManager and isAnyMeshCoreManager', () => {
    const mgr = makeManager();
    expect(isMeshCoreMqttManager(mgr)).toBe(true);
    expect(isAnyMeshCoreManager(mgr)).toBe(true);
  });

  it('is not mistaken for a Meshtastic source either', () => {
    expect(isMeshtasticManager(makeManager())).toBe(false);
  });

  it('reports no local node — this source is not a node on the mesh', () => {
    const mgr = makeManager();
    expect(mgr.getLocalNodeInfo()).toBeNull();
    expect(mgr.getLocalNode()).toBeNull();
  });

  it('has no-op distance-delete scheduling, since that anchors on a local position', async () => {
    const mgr = makeManager();
    await expect(mgr.startDistanceDeleteScheduler()).resolves.toBeUndefined();
    expect(() => mgr.stopDistanceDeleteScheduler()).not.toThrow();
  });
});

describe('MeshCoreMqttManager — subscription', () => {
  it('subscribes to the region wildcard topic on start', async () => {
    await makeManager().start();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith(['meshcore/MCO/+/packets']);
  });

  it('is idempotent — a second start does not open a second connection', async () => {
    const mgr = makeManager();
    await mgr.start();
    await mgr.start();
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('disconnects and drops listeners on stop', async () => {
    const mgr = makeManager();
    await mgr.start();
    await mgr.stop();
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it('reports connection state through getStatus', async () => {
    const mgr = makeManager();
    expect(mgr.getStatus().connected).toBe(false);
    await mgr.start();
    expect(mgr.getStatus().connected).toBe(true);
    expect(mgr.getStatus().sourceType).toBe('meshcore_mqtt');
  });
});

describe('MeshCoreMqttManager — ingest', () => {
  it('decodes a valid packet and emits it in the bridge shape', async () => {
    const mgr = makeManager();
    const seen: unknown[] = [];
    mgr.on('ota_packet', (e) => seen.push(e));
    await mgr.start();

    lastClient!.deliver(`meshcore/MCO/${OBSERVER_KEY}/packets`, packetBody());

    expect(seen).toHaveLength(1);
    expect(mgr.getIngestStats()).toMatchObject({ received: 1, accepted: 1, rejected: 0, observers: 1 });
  });

  it('rejects a body whose origin_id contradicts the topic it arrived on', async () => {
    // A publisher claiming another observer's identity. Accepting it would
    // attribute packets to the wrong node, corrupting per-observer dedup.
    const mgr = makeManager();
    const seen: unknown[] = [];
    mgr.on('ota_packet', (e) => seen.push(e));
    await mgr.start();

    lastClient!.deliver(
      `meshcore/MCO/${OBSERVER_KEY}/packets`,
      packetBody({ origin_id: 'CD'.repeat(32) }),
    );

    expect(seen).toHaveLength(0);
    expect(mgr.getIngestStats()).toMatchObject({ received: 1, accepted: 0, rejected: 1 });
  });

  it('survives malformed JSON without throwing or breaking the stream', async () => {
    const mgr = makeManager();
    const seen: unknown[] = [];
    mgr.on('ota_packet', (e) => seen.push(e));
    await mgr.start();

    // Raw non-JSON bytes, as a broken publisher would send.
    lastClient!.handlers.get('message')?.({
      topic: `meshcore/MCO/${OBSERVER_KEY}/packets`,
      payload: Buffer.from('not json at all'),
    });
    // A good message immediately after still gets through.
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_KEY}/packets`, packetBody());

    expect(seen).toHaveLength(1);
    expect(mgr.getIngestStats()).toMatchObject({ received: 2, accepted: 1, rejected: 1 });
  });

  it('counts distinct observers rather than messages', async () => {
    const mgr = makeManager();
    await mgr.start();
    const other = 'CD'.repeat(32);

    lastClient!.deliver(`meshcore/MCO/${OBSERVER_KEY}/packets`, packetBody());
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_KEY}/packets`, packetBody());
    lastClient!.deliver(`meshcore/MCO/${other}/packets`, packetBody({ origin_id: other }));

    expect(mgr.getIngestStats()).toMatchObject({ received: 3, accepted: 3, observers: 2 });
  });

  it('rolls back `started` when connect fails, so a later start() retries', async () => {
    // Without the rollback the source is stranded: never connected, and never
    // retryable short of a process restart.
    const mgr = makeManager();
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(mgr.start()).rejects.toThrow('ECONNREFUSED');
    expect(mgr.getStatus().connected).toBe(false);
    expect(mgr.getIngestStats().lastError).toBe('ECONNREFUSED');

    // Second attempt must actually try again rather than early-returning.
    connectMock.mockResolvedValueOnce(undefined);
    await mgr.start();
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(subscribeMock).toHaveBeenCalledWith(['meshcore/MCO/+/packets']);
  });

  it('tolerates stop() before start()', async () => {
    const mgr = makeManager();
    await expect(mgr.stop()).resolves.toBeUndefined();
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  it('can be restarted after a clean stop', async () => {
    const mgr = makeManager();
    await mgr.start();
    await mgr.stop();
    await mgr.start();
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('records the last broker error without throwing', async () => {
    const mgr = makeManager();
    await mgr.start();
    lastClient!.raise('error', new Error('bad credentials'));
    expect(mgr.getIngestStats().lastError).toBe('bad credentials');
  });
});

describe('predicate narrowing over a mixed manager list', () => {
  // The most load-bearing guarantee in this feature, and the one that would
  // break silently: a filter over the registry must sort this source into the
  // read group and out of the device group.
  const deviceLike = { sourceId: 'src-dev', sourceType: 'meshcore' } as never;
  const tcpLike = { sourceId: 'src-tcp', sourceType: 'meshtastic_tcp' } as never;

  it('excludes the MQTT source from a device-manager filter', () => {
    const all = [deviceLike, makeManager() as never, tcpLike];
    const devices = all.filter(isMeshCoreManager);
    expect(devices).toHaveLength(1);
    expect((devices[0] as { sourceId: string }).sourceId).toBe('src-dev');
  });

  it('includes BOTH MeshCore sources in an any-MeshCore filter', () => {
    const all = [deviceLike, makeManager() as never, tcpLike];
    const meshcore = all.filter(isAnyMeshCoreManager);
    expect(meshcore.map((m) => (m as { sourceId: string }).sourceId).sort()).toEqual([
      'src-dev',
      'src-mqtt-1',
    ]);
  });
});
