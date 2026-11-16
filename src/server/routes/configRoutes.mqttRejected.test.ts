/**
 * POST /mqtt: a node that refuses the save (firmware built without MQTT)
 * gets a 422, not a false success (#6439).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import configRoutes from './configRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { AdminConfigRejectedError } from '../errors/adminConfigRejectedError.js';
import { RoutingError } from '../constants/meshtastic.js';

describe('configRoutes: POST /mqtt refusal', () => {
  let harness: RouteTestHarness;
  let setMQTTConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', configRoutes) });
    setMQTTConfig = vi.fn().mockResolvedValue(undefined);
    await sourceManagerRegistry.addManager({
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'Source A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue(null),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      setMQTTConfig,
      getActualModuleConfig: vi.fn().mockReturnValue({ mqtt: { root: 'msh/US' } }),
    } as unknown as ISourceManager);
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  async function post() {
    const agent = await harness.loginAs(harness.limited);
    return agent.post('/mqtt').send({ sourceId: harness.sourceA, enabled: true, root: 'msh/US' });
  }

  it('returns 422 MQTT_CONFIG_REJECTED when the node refuses', async () => {
    setMQTTConfig.mockRejectedValue(new AdminConfigRejectedError('mqtt', RoutingError.BAD_REQUEST, 'BAD_REQUEST'));
    const res = await post();
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('MQTT_CONFIG_REJECTED');
    expect(res.body.error).toContain('refused');
  });

  it('still returns 200 when the node accepts', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('keeps 500 MQTT_CONFIG_FAILED for other errors', async () => {
    setMQTTConfig.mockRejectedValue(new Error('boom'));
    const res = await post();
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('MQTT_CONFIG_FAILED');
  });
});
