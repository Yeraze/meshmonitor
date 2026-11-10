/**
 * POST /mqtt: the server refuses a bad MQTT root, but only when it changes
 * (#6338). An unchanged bad root still saves, so an unrelated edit works on a
 * node that already holds one. An unknown previous root counts as a change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import configRoutes from './configRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';

describe('configRoutes: POST /mqtt root check', () => {
  let harness: RouteTestHarness;
  let setMQTTConfig: ReturnType<typeof vi.fn>;
  let getActualModuleConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', configRoutes) });
    setMQTTConfig = vi.fn().mockResolvedValue(undefined);
    getActualModuleConfig = vi.fn().mockReturnValue({ mqtt: { root: 'msh/US' } });
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
      getActualModuleConfig,
    } as unknown as ISourceManager);
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  async function post(body: Record<string, unknown>) {
    const agent = await harness.loginAs(harness.limited);
    return agent.post('/mqtt').send({ sourceId: harness.sourceA, ...body });
  }

  it.each([
    ['msh /US', 'WHITESPACE'],
    ['msh\u0007', 'CONTROL'],
    ['msh​', 'INVISIBLE'],
    ['msh/#', 'WILDCARD'],
    ['/msh', 'SLASH'],
    ['msh//US', 'SLASH'],
    ['msh/US/2', 'ENDS_WITH_2'],
    ['a'.repeat(32), 'TOO_LONG'],
    ['é'.repeat(16), 'TOO_LONG'], // 16 characters, 32 bytes
  ])('refuses %j (%s) before touching the device', async (root, reason) => {
    const res = await post({ enabled: true, root });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_MQTT_ROOT', field: 'root', reason });
    expect(typeof res.body.error).toBe('string');
    expect(setMQTTConfig).not.toHaveBeenCalled();
  });

  it.each(['', 'msh/US/FL', 'a'.repeat(31), 'é'.repeat(15)])('saves %j', async (root) => {
    const res = await post({ enabled: true, root });
    expect(res.status).toBe(200);
    expect(setMQTTConfig).toHaveBeenCalledWith({ enabled: true, root });
  });

  it('saves a body that does not carry a root', async () => {
    const res = await post({ enabled: false });
    expect(res.status).toBe(200);
    expect(setMQTTConfig).toHaveBeenCalledTimes(1);
  });

  it('lets an unrelated edit resend a bad root the node already holds', async () => {
    getActualModuleConfig.mockReturnValue({ mqtt: { root: 'msh/US ' } });
    const res = await post({ root: 'msh/US ', mapReportingEnabled: true });
    expect(res.status).toBe(200);
    expect(setMQTTConfig).toHaveBeenCalledWith({ root: 'msh/US ', mapReportingEnabled: true });
  });

  it('refuses a change from one bad root to another', async () => {
    getActualModuleConfig.mockReturnValue({ mqtt: { root: 'msh/US ' } });
    const res = await post({ root: 'msh/US/2' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('ENDS_WITH_2');
    expect(setMQTTConfig).not.toHaveBeenCalled();
  });

  it('checks the root when the node config is not cached yet', async () => {
    getActualModuleConfig.mockReturnValue(null);
    const res = await post({ root: 'msh/#' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('WILDCARD');
  });

  it('refuses a root that is not text', async () => {
    const res = await post({ root: 42 });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('NOT_STRING');
  });

  it('reports a bad preset before a bad root', async () => {
    const res = await post({ root: 'msh/#', brokerPresetId: 999999 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('BROKER_PRESET_NOT_FOUND');
    expect(setMQTTConfig).not.toHaveBeenCalled();
  });
});
