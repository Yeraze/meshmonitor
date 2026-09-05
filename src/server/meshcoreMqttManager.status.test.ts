/**
 * `/status` heartbeat ingest (#5040 Phase 5).
 *
 * A status message describes the OBSERVER that published it — the node running
 * the analyzer bridge — not anything it overheard. The tests that matter are
 * the ones separating status from packet handling, since both ride the same
 * region topic prefix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: { upsertNode: (...a: unknown[]) => upsertNode(...a), insertMessage: vi.fn() },
    channels: { getAllChannels: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('./services/dataEventEmitter.js', () => ({ dataEventEmitter: { emitMeshCoreMessage: vi.fn() } }));
vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));

let lastClient: FakeClient | null = null;
class FakeClient {
  handlers = new Map<string, (a: unknown) => void>();
  connect = vi.fn().mockResolvedValue(undefined);
  subscribe = vi.fn().mockResolvedValue(undefined);
  disconnect = vi.fn().mockResolvedValue(undefined);
  isConnected = () => true;
  on(e: string, fn: (a: unknown) => void) { this.handlers.set(e, fn); return this; }
  removeAllListeners() { this.handlers.clear(); return this; }
  deliver(topic: string, b: unknown) {
    this.handlers.get('message')?.({ topic, payload: Buffer.from(JSON.stringify(b)) });
  }
  deliverRaw(topic: string, raw: string) {
    this.handlers.get('message')?.({ topic, payload: Buffer.from(raw) });
  }
}
vi.mock('./transports/mqttBrokerClient.js', () => ({
  MqttBrokerClient: class { constructor() { lastClient = new FakeClient(); return lastClient as unknown as object; } },
}));

import { MeshCoreMqttManager } from './meshcoreMqttManager.js';

const OBS = 'AA'.repeat(32);
const statusTopic = `meshcore/MCO/${OBS}/status`;

const online = (over: Record<string, unknown> = {}) => ({
  status: 'online', origin: 'BridgeNode', origin_id: OBS,
  stats: { battery_mv: 4100, uptime_secs: 86_400, noise_floor: -95 },
  ...over,
});

async function started() {
  const m = new MeshCoreMqttManager('src-mqtt', 'Feed', { brokerUrl: 'wss://b', region: 'MCO' });
  await m.start();
  return m;
}
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => { upsertNode.mockClear(); lastClient = null; });

describe('status ingest (#5040 Phase 5)', () => {
  it('subscribes to the status topic alongside packets', async () => {
    const mgr = await started();
    const topics = (lastClient!.subscribe as unknown as { mock: { calls: string[][][] } }).mock.calls[0][0];
    expect(topics).toContain('meshcore/MCO/+/packets');
    expect(topics).toContain('meshcore/MCO/+/status');
    expect(mgr.getStatus().connected).toBe(true);
  });

  it('records the observer’s battery and uptime against its own key', async () => {
    const mgr = await started();
    lastClient!.deliver(statusTopic, online());
    await settle();

    expect(upsertNode).toHaveBeenCalledTimes(1);
    const [node, sourceId] = upsertNode.mock.calls[0];
    expect(sourceId).toBe('src-mqtt');
    expect(node).toMatchObject({ publicKey: OBS, name: 'BridgeNode', batteryMv: 4100, uptimeSecs: 86_400 });
    expect(mgr.getIngestStats().statusMessages).toBe(1);
  });

  it('does NOT stamp lastHeard — a heartbeat proves broker reach, not mesh reach', async () => {
    // Otherwise an observer whose radio is dead would look mesh-alive.
    await started();
    lastClient!.deliver(statusTopic, online());
    await settle();
    expect(upsertNode.mock.calls[0][0].lastHeard).toBeUndefined();
  });

  it('does not count status heartbeats as received packets', async () => {
    // Both ride the same region prefix; conflating them would drift every
    // packet counter by one per observer per heartbeat.
    const mgr = await started();
    lastClient!.deliver(statusTopic, online());
    await settle();

    const s = mgr.getIngestStats();
    expect(s.statusMessages).toBe(1);
    expect(s.received).toBe(0);
    expect(s.rejected).toBe(0);
  });

  it('does not book a malformed status body as a rejected packet', async () => {
    const mgr = await started();
    lastClient!.deliverRaw(statusTopic, 'not json');
    await settle();

    expect(mgr.getIngestStats().received).toBe(0);
    expect(mgr.getIngestStats().rejected).toBe(0);
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it('writes nothing for an offline notice', async () => {
    const mgr = await started();
    lastClient!.deliver(statusTopic, online({ status: 'offline', stats: {} }));
    await settle();

    expect(upsertNode).not.toHaveBeenCalled();
    // Still tracked, so the panel can show it went offline.
    expect(mgr.getObserverStatuses().get(OBS)?.online).toBe(false);
  });

  it('writes nothing when firmware reports no stats', async () => {
    await started();
    lastClient!.deliver(statusTopic, online({ stats: {} }));
    await settle();
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it('drops an implausible battery reading rather than storing it', async () => {
    await started();
    lastClient!.deliver(statusTopic, online({ stats: { battery_mv: 999_999, uptime_secs: 10 } }));
    await settle();

    const node = upsertNode.mock.calls[0][0];
    expect(node.batteryMv).toBeUndefined();
    expect(node.uptimeSecs).toBe(10);
  });

  it('exposes noise floor on the snapshot without persisting it', async () => {
    // No column for it yet; decoding it now keeps the display work to a UI
    // change rather than a migration.
    const mgr = await started();
    lastClient!.deliver(statusTopic, online());
    await settle();

    expect(mgr.getObserverStatuses().get(OBS)?.noiseFloor).toBe(-95);
    expect(upsertNode.mock.calls[0][0].noiseFloor).toBeUndefined();
  });

  it('ignores a packet body delivered on the status topic', async () => {
    await started();
    lastClient!.deliver(statusTopic, { type: 'PACKET', origin_id: OBS, raw: '0500deadbeef' });
    await settle();
    expect(upsertNode).not.toHaveBeenCalled();
  });
});
