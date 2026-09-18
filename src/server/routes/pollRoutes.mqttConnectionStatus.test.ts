/**
 * pollRoutes — MQTT source connection status (bug: MQTT-only installs never
 * show "connected").
 *
 * resolveSourceManager() only narrows to meshtastic_tcp managers (see its
 * docstring, invariant I2). With an enabled mqtt_bridge source and no enabled
 * meshtastic_tcp source, it silently substitutes the never-connected
 * fallbackManager for the poll's `activeManager` — so /api/poll reported the
 * fallback's (always-disconnected) status instead of the registered MQTT
 * manager's real status, even though the bridge itself was connected. The
 * frontend's shouldShowData() gate never passes, so Nodes/Messages/Channels
 * show the "Connect to Meshtastic node" empty state despite the bridge
 * ingesting data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pollRoutes from './pollRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';

describe('pollRoutes — GET /poll MQTT source connection status', () => {
  let harness: RouteTestHarness;
  const MQTT_SOURCE_ID = 'rt-mqtt-bridge-a';

  function makeMqttBridgeManager(): ISourceManager {
    return {
      sourceId: MQTT_SOURCE_ID,
      sourceType: 'mqtt_bridge',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({
        sourceId: MQTT_SOURCE_ID,
        sourceName: 'MQTT Bridge A',
        sourceType: 'mqtt_bridge',
        connected: true,
      }),
      getLocalNodeInfo: vi.fn().mockReturnValue(null),
      getAllNodesAsync: vi.fn().mockResolvedValue([]),
      getConnectionStatus: vi.fn().mockResolvedValue({
        connected: true,
        nodeResponsive: true,
        configuring: false,
        nodeIp: '',
        userDisconnected: false,
      }),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
    } as unknown as ISourceManager;
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', pollRoutes),
    });
    await harness.db.sources.createSource({
      id: MQTT_SOURCE_ID,
      name: 'MQTT Bridge A',
      type: 'mqtt_bridge',
      config: {},
      enabled: true,
    });
    await sourceManagerRegistry.addManager(makeMqttBridgeManager());
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(MQTT_SOURCE_ID);
    await harness.db.sources.deleteSource(MQTT_SOURCE_ID).catch(() => {});
    await harness.cleanup();
  });

  it('reports the registered mqtt_bridge manager\'s own connection status, not the fallback\'s', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/poll').query({ sourceId: MQTT_SOURCE_ID });

    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({
      connected: true,
      nodeResponsive: true,
      configuring: false,
      userDisconnected: false,
    });
  });
});
