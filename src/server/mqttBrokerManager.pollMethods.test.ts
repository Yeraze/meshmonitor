/**
 * Regression test for the broker /api/poll 500.
 *
 * The consolidated /api/poll (and /api/device/tx-status, /api/messages/
 * unread-counts) call getAllNodesAsync() / getConnectionStatus() /
 * getDeviceConfig() on the resolved source manager. MqttBrokerManager was
 * missing these, so an mqtt_broker source threw
 * `TypeError: activeManager.getAllNodesAsync is not a function` → 500 →
 * the dashboard/map received no nodes and showed no pins, even though node
 * positions were stored fine. This test pins the method surface that
 * MqttBridgeManager and MeshtasticManager also provide.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadAllNodesAsDeviceInfo = vi.fn();

vi.mock('./utils/dbNodeMapper.js', () => ({
  loadAllNodesAsDeviceInfo: (...args: unknown[]) => loadAllNodesAsDeviceInfo(...args),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { MqttBrokerManager } from './mqttBrokerManager.js';

function makeManager() {
  return new MqttBrokerManager('broker-src-1', 'Test Broker', {
    listener: { port: 0 },
    auth: { username: 'u', password: 'p' },
    gateway: { nodeNum: 0x11223344, nodeId: '!11223344', longName: 'GW', shortName: 'GW' },
  });
}

describe('MqttBrokerManager — /api/poll method surface', () => {
  let mgr: MqttBrokerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = makeManager();
  });

  it('exposes the methods the consolidated poll endpoint calls', () => {
    // These were the exact methods that threw "is not a function" for broker sources.
    expect(typeof (mgr as any).getAllNodesAsync).toBe('function');
    expect(typeof (mgr as any).getConnectionStatus).toBe('function');
    expect(typeof (mgr as any).getDeviceConfig).toBe('function');
    expect(typeof (mgr as any).getLocalNodeInfo).toBe('function');
  });

  it('getAllNodesAsync returns the DB-backed nodes for this source', async () => {
    const nodes = [{ nodeNum: 1 }, { nodeNum: 2 }] as any;
    loadAllNodesAsDeviceInfo.mockResolvedValue(nodes);
    const result = await mgr.getAllNodesAsync('broker-src-1');
    expect(loadAllNodesAsDeviceInfo).toHaveBeenCalledWith('broker-src-1');
    expect(result).toBe(nodes);
  });

  it('getConnectionStatus reports a Meshtastic-shaped status (not started → disconnected)', async () => {
    const status = await mgr.getConnectionStatus();
    expect(status).toMatchObject({
      connected: false,
      nodeResponsive: false,
      configuring: false,
    });
  });

  it('getDeviceConfig / getDeviceNodeNums / getSecurityKeys return safe defaults', async () => {
    expect(await mgr.getDeviceConfig()).toBeNull();
    expect((mgr as any).getDeviceNodeNums()).toEqual([]);
    expect((mgr as any).getSecurityKeys()).toEqual({ publicKey: null, privateKey: null });
  });
});
