/**
 * #5367 — an MQTT_BROKER source showed a different source's Device Info.
 *
 * resolveSourceManager() only narrows to meshtastic_tcp managers; for an
 * mqtt_broker / mqtt_bridge / meshcore sourceId it returns the PRIMARY TCP
 * manager. /api/poll built the Info tab's node ID, name, firmware and LoRa
 * config from that manager, so the broker source displayed the TCP node's
 * identity, and the device-config / admin routes would have written to that
 * other node's radio.
 *
 * These tests register a real-shaped primary meshtastic_tcp manager with a
 * distinctive identity next to an mqtt_broker manager, then prove:
 *   - /poll for the broker carries none of the TCP node's identity/config;
 *   - /poll for the TCP source still does (positive control);
 *   - device routes refuse the broker id with 400 SOURCE_NOT_MESHTASTIC and
 *     never touch the TCP manager.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pollRoutes from './pollRoutes.js';
import configRoutes from './configRoutes.js';
import deviceRoutes from './deviceRoutes.js';
import deviceStatusRoutes from './deviceStatusRoutes.js';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';

const TCP_NODE_ID = '!bf85a9d1';
const TCP_LONG_NAME = 'SKYM - AUX - LT';
const TCP_FIRMWARE = '2.8.1.d3b4b34';
const BROKER_SOURCE_ID = 'rt-mqtt-broker-5367';

describe('non-Meshtastic sources never borrow the primary device (#5367)', () => {
  let harness: RouteTestHarness;
  let tcpManager: Record<string, ReturnType<typeof vi.fn> | string>;

  function makeTcpManager(): ISourceManager {
    const deviceConfig = {
      basic: { nodeId: TCP_NODE_ID, nodeName: TCP_LONG_NAME, firmwareVersion: TCP_FIRMWARE, nodeAddress: '192.168.1.244:4403' },
      radio: { region: 'US', modemPreset: 'Long Fast', channelNum: 20 },
    };
    tcpManager = {
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'Source A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({
        nodeNum: 0xbf85a9d1,
        nodeId: TCP_NODE_ID,
        longName: TCP_LONG_NAME,
        shortName: 'SKYM',
        firmwareVersion: TCP_FIRMWARE,
        rebootCount: 3,
      }),
      isLocalNodeBridged: vi.fn().mockReturnValue(false),
      getAllNodesAsync: vi.fn().mockResolvedValue([]),
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true, nodeResponsive: true, configuring: false, nodeIp: '192.168.1.244', userDisconnected: false }),
      getDeviceConfig: vi.fn().mockResolvedValue(deviceConfig),
      getDeviceNodeNums: vi.fn().mockReturnValue([0xbf85a9d1, 42]),
      getCurrentConfig: vi.fn().mockReturnValue({ deviceConfig: { lora: { region: 1 } } }),
      getSecurityKeys: vi.fn().mockReturnValue({ publicKey: 'pub', privateKey: 'priv' }),
      setNodeOwner: vi.fn().mockResolvedValue(undefined),
      setDeviceConfig: vi.fn().mockResolvedValue(undefined),
      rebootDevice: vi.fn().mockResolvedValue(undefined),
      sendRebootCommand: vi.fn().mockResolvedValue(undefined),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
    };
    return tcpManager as unknown as ISourceManager;
  }

  function makeBrokerManager(): ISourceManager {
    return {
      sourceId: BROKER_SOURCE_ID,
      sourceType: 'mqtt_broker',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: BROKER_SOURCE_ID, sourceName: 'Home Mqtt', sourceType: 'mqtt_broker', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue(null),
      getAllNodesAsync: vi.fn().mockResolvedValue([]),
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true, nodeResponsive: true, configuring: false, nodeIp: '', userDisconnected: false }),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
    } as unknown as ISourceManager;
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/', pollRoutes);
        app.use('/config', configRoutes);
        app.use('/', deviceRoutes);
        app.use('/', deviceStatusRoutes);
        app.use('/admin', adminRoutes);
      },
    });
    await harness.db.sources.createSource({
      id: BROKER_SOURCE_ID,
      name: 'Home Mqtt',
      type: 'mqtt_broker',
      config: {},
      enabled: true,
    });
    await sourceManagerRegistry.addManager(makeTcpManager());
    await sourceManagerRegistry.addManager(makeBrokerManager());
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(BROKER_SOURCE_ID);
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.db.sources.deleteSource(BROKER_SOURCE_ID).catch(() => {});
    await harness.cleanup();
  });

  describe('GET /poll', () => {
    it('does not report the primary TCP node\'s identity or device config for an mqtt_broker source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/poll').query({ sourceId: BROKER_SOURCE_ID });

      expect(res.status).toBe(200);
      expect(res.body.deviceConfig).toBeUndefined();
      expect(res.body.config?.localNodeInfo).toBeUndefined();
      expect(res.body.config?.deviceMetadata).toBeUndefined();
      expect(res.body.deviceNodeNums).toEqual([]);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(TCP_NODE_ID);
      expect(serialized).not.toContain(TCP_LONG_NAME);
      expect(serialized).not.toContain(TCP_FIRMWARE);
      expect(tcpManager.getDeviceConfig).not.toHaveBeenCalled();
    });

    it('still reports the TCP source\'s own identity and device config for that source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/poll').query({ sourceId: harness.sourceA });

      expect(res.status).toBe(200);
      expect(res.body.deviceConfig?.basic?.nodeId).toBe(TCP_NODE_ID);
      expect(res.body.config?.localNodeInfo).toMatchObject({ nodeId: TCP_NODE_ID, longName: TCP_LONG_NAME });
      expect(res.body.config?.deviceMetadata?.firmwareVersion).toBe(TCP_FIRMWARE);
      expect(res.body.deviceNodeNums).toEqual([0xbf85a9d1, 42]);
    });
  });

  describe('device routes refuse an mqtt_broker sourceId', () => {
    it('GET /config/current', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/config/current').query({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.getCurrentConfig).not.toHaveBeenCalled();
    });

    it('POST /config/owner does not rename the primary TCP node', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/config/owner').send({ sourceId: BROKER_SOURCE_ID, longName: 'x', shortName: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.setNodeOwner).not.toHaveBeenCalled();
    });

    it('POST /config/device does not reconfigure the primary TCP node', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/config/device').send({ sourceId: BROKER_SOURCE_ID, role: 2 });
      expect(res.status).toBe(400);
      expect(tcpManager.setDeviceConfig).not.toHaveBeenCalled();
    });

    it('GET /device-config', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/device-config').query({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.getDeviceConfig).not.toHaveBeenCalled();
    });

    it('GET /device/security-keys does not leak the primary node\'s keys', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/device/security-keys').query({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.getSecurityKeys).not.toHaveBeenCalled();
    });

    it('POST /device/reboot does not reboot the primary TCP node', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/device/reboot').send({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(400);
      expect(tcpManager.rebootDevice).not.toHaveBeenCalled();
    });

    it('POST /admin/reboot does not send a reboot through the primary TCP node', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/admin/reboot').send({ sourceId: BROKER_SOURCE_ID, nodeNum: 999 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.sendRebootCommand).not.toHaveBeenCalled();
    });

    it('lets the TCP source\'s own id through (positive control)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/device/security-keys').query({ sourceId: harness.sourceA });
      expect(res.status).toBe(200);
      expect(tcpManager.getSecurityKeys).toHaveBeenCalled();
    });
  });
});
