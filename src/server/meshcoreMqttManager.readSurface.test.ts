/**
 * Read-surface inclusion for an MQTT ingest source (#5040 Phase 5.5).
 *
 * Five phases added ingest paths, and every shared read surface narrowed with
 * `isMeshCoreManager()` — which excludes this source by construction. That
 * exclusion is correct for anything driving a radio and WRONG for anything
 * reading data, and the failure is silent: nodes simply never appear.
 *
 * These pin the manager half — the methods those surfaces call. Without them a
 * caller can narrow with `isAnyMeshCoreManager()` and still not compile, which
 * is what kept the predicate at zero production callers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getNodesBySource = vi.fn();
const getRecentMessages = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      getNodesBySource: (...a: unknown[]) => getNodesBySource(...a),
      getRecentMessages: (...a: unknown[]) => getRecentMessages(...a),
      upsertNode: vi.fn(),
      insertMessage: vi.fn(),
    },
    channels: { getAllChannels: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('./services/dataEventEmitter.js', () => ({ dataEventEmitter: { emitMeshCoreMessage: vi.fn() } }));
vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));

let connected = true;
vi.mock('./transports/mqttBrokerClient.js', () => ({
  MqttBrokerClient: class {
    connect = vi.fn().mockResolvedValue(undefined);
    subscribe = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    isConnected = () => connected;
    on() { return this; }
    removeAllListeners() { return this; }
  },
}));

import { MeshCoreMqttManager } from './meshcoreMqttManager.js';
import { isAnyMeshCoreManager, isMeshCoreManager, isMeshCoreMqttManager } from './sourceManagerTypes.js';

const make = () => new MeshCoreMqttManager('src-mqtt', 'Feed', {
  brokerUrl: 'wss://b', region: 'MCO',
});

beforeEach(() => {
  connected = true;
  getNodesBySource.mockReset().mockResolvedValue([]);
  getRecentMessages.mockReset().mockResolvedValue([]);
});

describe('read surface (#5040 Phase 5.5)', () => {
  it('returns this source’s nodes, scoped by sourceId', async () => {
    getNodesBySource.mockResolvedValue([{ publicKey: 'AA', latitude: 1, longitude: 2 }]);
    const nodes = await make().getAllNodes();

    expect(getNodesBySource).toHaveBeenCalledWith('src-mqtt');
    expect(nodes).toHaveLength(1);
  });

  it('returns this source’s messages, scoped by sourceId', async () => {
    getRecentMessages.mockResolvedValue([{ id: 'm1', text: 'hi' }]);
    const msgs = await make().getRecentMessagesAsync(500);

    expect(getRecentMessages).toHaveBeenCalledWith(500, 'src-mqtt');
    expect(msgs).toHaveLength(1);
  });

  it('degrades to empty rather than throwing when the DB read fails', async () => {
    // These feed map and search surfaces; one unreadable source must not take
    // down a whole cross-source query.
    getNodesBySource.mockRejectedValue(new Error('db down'));
    getRecentMessages.mockRejectedValue(new Error('db down'));
    const mgr = make();

    await expect(mgr.getAllNodes()).resolves.toEqual([]);
    await expect(mgr.getRecentMessagesAsync()).resolves.toEqual([]);
  });

  it('reports broker connectivity through isConnected', async () => {
    const mgr = make();
    expect(mgr.isConnected()).toBe(false); // not started
    await mgr.start();
    expect(mgr.isConnected()).toBe(true);
    connected = false;
    expect(mgr.isConnected()).toBe(false);
  });

  it('is included by the read predicate and excluded by the device one', () => {
    const mgr = make();
    // The whole point of the audit: read surfaces must use the inclusive
    // predicate, TX surfaces the device-only one.
    expect(isAnyMeshCoreManager(mgr)).toBe(true);
    expect(isMeshCoreMqttManager(mgr)).toBe(true);
    expect(isMeshCoreManager(mgr)).toBe(false);
  });

  it('satisfies the union call site without a cast', async () => {
    // A caller that narrows with isAnyMeshCoreManager gets a union; if either
    // member lacked getAllNodes this would not compile, which is exactly what
    // blocked the predicate from having any production callers.
    const mgr = make();
    const narrowed = isAnyMeshCoreManager(mgr) ? mgr : null;
    expect(narrowed).not.toBeNull();
    await expect(narrowed!.getAllNodes()).resolves.toEqual([]);
  });
});
