/**
 * POST /device and POST /position: the two broadcast intervals.
 *
 * A stored 0 means "use the firmware default" and must reach the device as 0.
 * Any other value under MeshMonitor's floor (32 s position, 3600 s node-info)
 * is refused before the device is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import configRoutes from './configRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';

describe('configRoutes: broadcast interval floors', () => {
  let harness: RouteTestHarness;
  let setDeviceConfig: ReturnType<typeof vi.fn>;
  let setPositionConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', configRoutes) });
    setDeviceConfig = vi.fn().mockResolvedValue(undefined);
    setPositionConfig = vi.fn().mockResolvedValue(undefined);
    await sourceManagerRegistry.addManager({
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'Source A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue(null),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      setDeviceConfig,
      setPositionConfig,
    } as unknown as ISourceManager);
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  async function post(path: string, body: Record<string, unknown>) {
    const agent = await harness.loginAs(harness.limited);
    return agent.post(path).send({ sourceId: harness.sourceA, ...body });
  }

  describe('POST /position', () => {
    it('sends a stored 0 on as 0, with the rest of the section', async () => {
      const res = await post('/position', { positionBroadcastSecs: 0, gpsUpdateInterval: 120, positionBroadcastSmartEnabled: true });

      expect(res.status).toBe(200);
      expect(setPositionConfig).toHaveBeenCalledTimes(1);
      expect(setPositionConfig).toHaveBeenCalledWith({ positionBroadcastSecs: 0, gpsUpdateInterval: 120, positionBroadcastSmartEnabled: true });
    });

    it.each([32, 900, 43200])('sends %i as typed', async (secs) => {
      const res = await post('/position', { positionBroadcastSecs: secs });
      expect(res.status).toBe(200);
      expect(setPositionConfig).toHaveBeenCalledWith({ positionBroadcastSecs: secs });
    });

    it.each([1, 5, 31, -1, 31.5, 'abc'])('refuses %s before touching the device', async (secs) => {
      const res = await post('/position', { positionBroadcastSecs: secs });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'POSITION_INTERVAL_BELOW_FLOOR' });
      expect(setPositionConfig).not.toHaveBeenCalled();
    });

    it('a save that does not carry the interval is not refused', async () => {
      const res = await post('/position', { gpsUpdateInterval: 120 });
      expect(res.status).toBe(200);
      expect(setPositionConfig).toHaveBeenCalledWith({ gpsUpdateInterval: 120 });
    });
  });

  describe('POST /device', () => {
    it('sends a stored 0 on as 0, with the rest of the section', async () => {
      const res = await post('/device', { role: 2, nodeInfoBroadcastSecs: 0, tzdef: 'UTC0' });

      expect(res.status).toBe(200);
      expect(setDeviceConfig).toHaveBeenCalledTimes(1);
      expect(setDeviceConfig).toHaveBeenCalledWith({ role: 2, nodeInfoBroadcastSecs: 0, tzdef: 'UTC0' });
    });

    it.each([3600, 10800])('sends %i as typed', async (secs) => {
      const res = await post('/device', { nodeInfoBroadcastSecs: secs });
      expect(res.status).toBe(200);
      expect(setDeviceConfig).toHaveBeenCalledWith({ nodeInfoBroadcastSecs: secs });
    });

    it.each([1, 60, 900, 3599, -1])('refuses %s before touching the device', async (secs) => {
      const res = await post('/device', { nodeInfoBroadcastSecs: secs });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'NODE_INFO_INTERVAL_BELOW_FLOOR' });
      expect(setDeviceConfig).not.toHaveBeenCalled();
    });
  });
});
