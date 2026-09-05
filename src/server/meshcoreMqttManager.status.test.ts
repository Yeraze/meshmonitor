/**
 * `/status` heartbeat ingest (#5040 Phase 5).
 *
 * A status message describes the OBSERVER that published it — the node running
 * the analyzer bridge — not anything it overheard. The tests that matter are
 * the ones separating status from packet handling, since both ride the same
 * region topic prefix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);
const insertTelemetryBatch = vi.fn().mockResolvedValue(1);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: { upsertNode: (...a: unknown[]) => upsertNode(...a), insertMessage: vi.fn() },
    channels: { getAllChannels: vi.fn().mockResolvedValue([]) },
    telemetry: { insertTelemetryBatch: (...a: unknown[]) => insertTelemetryBatch(...a) },
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

beforeEach(() => {
  upsertNode.mockClear();
  insertTelemetryBatch.mockClear();
  nowMs = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  lastClient = null;
});
afterEach(() => { vi.restoreAllMocks(); });

/** Controls the manager's clock so the sample throttle is testable. */
let nowMs = 1_700_000_000_000;

/** The single row handed to insertTelemetryBatch on the Nth call. */
const rowAt = (call: number) =>
  (insertTelemetryBatch.mock.calls[call][0] as Array<Record<string, unknown>>)[0];

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

  it('caps the observer-status map and evicts the LONGEST-UNSEEN entry', async () => {
    // Regression for a review finding on #5076: the field comment claimed a
    // cap that was never enforced. A heartbeat arrives per observer per
    // interval and a departed observer never clears its own entry, so an
    // unconditional set() grows with the region forever.
    const mgr = await started();
    const key = (n: number) => n.toString(16).padStart(64, '0').toUpperCase();

    // Fill past the cap.
    for (let i = 0; i < 1_005; i++) {
      lastClient!.deliver(`meshcore/MCO/${key(i)}/status`, online({ origin_id: key(i) }));
    }
    await settle();

    const snapshots = mgr.getObserverStatuses();
    expect(snapshots.size).toBeLessThanOrEqual(1_000);
    // The earliest observers were evicted; the most recent survive.
    expect(snapshots.has(key(0))).toBe(false);
    expect(snapshots.has(key(1_004))).toBe(true);
  });

  it('keeps a chatty observer alive rather than evicting it as stale', async () => {
    // The eviction is longest-UNSEEN, not first-ever-seen. Without the
    // delete-then-set, a repeat heartbeat would leave the entry at its original
    // insertion position and the most active observer would be dropped first.
    const mgr = await started();
    const key = (n: number) => n.toString(16).padStart(64, '0').toUpperCase();

    lastClient!.deliver(`meshcore/MCO/${key(0)}/status`, online({ origin_id: key(0) }));
    for (let i = 1; i < 999; i++) {
      lastClient!.deliver(`meshcore/MCO/${key(i)}/status`, online({ origin_id: key(i) }));
    }
    // observer 0 speaks again, right before the map overflows.
    lastClient!.deliver(`meshcore/MCO/${key(0)}/status`, online({ origin_id: key(0) }));
    for (let i = 999; i < 1_010; i++) {
      lastClient!.deliver(`meshcore/MCO/${key(i)}/status`, online({ origin_id: key(i) }));
    }
    await settle();

    const snapshots = mgr.getObserverStatuses();
    expect(snapshots.has(key(0))).toBe(true);
    expect(snapshots.has(key(1))).toBe(false);
  });

  it('returns a copy, so a caller cannot mutate the manager state', async () => {
    const mgr = await started();
    lastClient!.deliver(statusTopic, online());
    await settle();

    mgr.getObserverStatuses().clear?.();
    expect(mgr.getObserverStatuses().size).toBe(1);
  });

  it('ignores a packet body delivered on the status topic', async () => {
    await started();
    lastClient!.deliver(statusTopic, { type: 'PACKET', origin_id: OBS, raw: '0500deadbeef' });
    await settle();
    expect(upsertNode).not.toHaveBeenCalled();
  });
});

/**
 * Noise floor persistence (#5040 follow-up).
 *
 * Phase 5 decoded `noise_floor` and showed it live, but stored nothing, so a
 * region feed could not answer "is this band getting more congested" — the one
 * question the reading is for. It is written as `mc_status_noise_floor`, the
 * series the remote-telemetry scheduler already writes for device-backed
 * MeshCore sources, so both kinds of observer share one graph.
 */
describe('noise floor persistence (#5040 follow-up)', () => {
  it('stores the reading as an mc_status_noise_floor telemetry sample', async () => {
    await started();
    lastClient!.deliver(statusTopic, online());
    await settle();

    expect(insertTelemetryBatch).toHaveBeenCalledTimes(1);
    const [, sourceId] = insertTelemetryBatch.mock.calls[0];
    expect(sourceId).toBe('src-mqtt');

    const row = rowAt(0);
    expect(row.telemetryType).toBe('mc_status_noise_floor');
    expect(row.value).toBe(-95);
    expect(row.nodeId).toBe(OBS);
    // Same synthesised nodeNum every other MeshCore telemetry writer uses:
    // low 32 bits of the pubkey, forced non-negative.
    expect(row.nodeNum).toBe(0xaaaaaaaa & 0x7fffffff);
  });

  it('uses the same unit as the device-backed scheduler, so one series is not split', async () => {
    await started();
    lastClient!.deliver(statusTopic, online());
    await settle();
    expect(rowAt(0).unit).toBe('dB');
  });

  it('writes the node row before the sample, so the reading has a node to hang off', async () => {
    await started();
    lastClient!.deliver(statusTopic, online());
    await settle();

    expect(upsertNode).toHaveBeenCalled();
    expect(insertTelemetryBatch).toHaveBeenCalled();
    expect(upsertNode.mock.invocationCallOrder[0]).toBeLessThan(
      insertTelemetryBatch.mock.invocationCallOrder[0],
    );
  });

  it('stores a reading from firmware that reports ONLY noise_floor', async () => {
    // The Phase 5 guard returned early unless battery or uptime was present,
    // which would have dropped this observer entirely — no node, no sample.
    await started();
    lastClient!.deliver(statusTopic, online({ stats: { noise_floor: -101 } }));
    await settle();

    expect(upsertNode).toHaveBeenCalledTimes(1);
    expect(rowAt(0).value).toBe(-101);
  });

  it('drops a retained replay: a second heartbeat inside the throttle stores nothing', async () => {
    // The broker replays each observer's retained /status on every reconnect,
    // so a flapping socket would otherwise write a sample per reconnect.
    await started();
    lastClient!.deliver(statusTopic, online());
    await settle();
    nowMs += 5_000;
    lastClient!.deliver(statusTopic, online({ stats: { noise_floor: -80 } }));
    await settle();

    expect(insertTelemetryBatch).toHaveBeenCalledTimes(1);
    expect(rowAt(0).value).toBe(-95);
  });

  it('stores the next real heartbeat, which is well past the throttle', async () => {
    await started();
    lastClient!.deliver(statusTopic, online());
    await settle();
    // Observers heartbeat every 5 minutes; the throttle is 60s, so a genuine
    // heartbeat is never the thing being dropped.
    nowMs += 300_000;
    lastClient!.deliver(statusTopic, online({ stats: { noise_floor: -88 } }));
    await settle();

    expect(insertTelemetryBatch).toHaveBeenCalledTimes(2);
    expect(rowAt(1).value).toBe(-88);
    expect(rowAt(1).timestamp).toBe(nowMs);
  });

  it('throttles per observer, not globally', async () => {
    const other = 'BB'.repeat(32);
    await started();
    lastClient!.deliver(statusTopic, online());
    await settle();
    lastClient!.deliver(`meshcore/MCO/${other}/status`, online({ origin_id: other }));
    await settle();

    expect(insertTelemetryBatch).toHaveBeenCalledTimes(2);
    expect(rowAt(1).nodeId).toBe(other);
  });

  it('stores nothing when the observer reports no noise floor', async () => {
    await started();
    lastClient!.deliver(statusTopic, online({ stats: { battery_mv: 4100 } }));
    await settle();

    expect(upsertNode).toHaveBeenCalledTimes(1);
    expect(insertTelemetryBatch).not.toHaveBeenCalled();
  });

  it('stores nothing from an offline notice', async () => {
    await started();
    lastClient!.deliver(statusTopic, online({ status: 'offline' }));
    await settle();
    expect(insertTelemetryBatch).not.toHaveBeenCalled();
  });

  it('keeps ingesting when the telemetry write fails', async () => {
    // A lost sample must never cost us the packet ingest on this connection.
    insertTelemetryBatch.mockRejectedValueOnce(new Error('db down'));
    const mgr = await started();
    lastClient!.deliver(statusTopic, online());
    await settle();

    expect(upsertNode).toHaveBeenCalledTimes(1);
    expect(mgr.getStatus().connected).toBe(true);
  });
});
