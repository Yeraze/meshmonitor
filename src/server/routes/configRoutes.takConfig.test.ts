/**
 * POST /module/tak (#5613): the local-node save path for TAK team + role.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import configRoutes from './configRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';

describe('configRoutes — POST /module/tak', () => {
  let harness: RouteTestHarness;
  let setGenericModuleConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', configRoutes) });
    setGenericModuleConfig = vi.fn().mockResolvedValue(undefined);
    await sourceManagerRegistry.addManager({
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'Source A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue(null),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      setGenericModuleConfig,
    } as unknown as ISourceManager);
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  async function postTak(body: Record<string, unknown>, grant = true) {
    if (grant) await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    return agent.post('/module/tak').send({ sourceId: harness.sourceA, ...body });
  }

  it('saves team and role as numbers, and nothing else', async () => {
    const res = await postTak({ team: 5, role: 2, junk: 'x' });

    expect(res.status).toBe(200);
    expect(setGenericModuleConfig).toHaveBeenCalledTimes(1);
    expect(setGenericModuleConfig).toHaveBeenCalledWith('tak', { team: 5, role: 2 });
  });

  it('accepts proto enum names', async () => {
    await postTak({ team: 'Red', role: 'TeamLead' });
    expect(setGenericModuleConfig).toHaveBeenCalledWith('tak', { team: 5, role: 2 });
  });

  it('a reset to defaults is sent as 0 / 0', async () => {
    const res = await postTak({ team: 0, role: 0 });
    expect(res.status).toBe(200);
    expect(setGenericModuleConfig).toHaveBeenCalledWith('tak', { team: 0, role: 0 });
  });

  it.each([
    [{ team: 15, role: 0 }],
    [{ team: 0, role: 9 }],
    [{ team: 'Chartreuse', role: 0 }],
    [{ team: 0, role: 'ROUTER' }],
  ])('refuses %j before touching the device', async (body) => {
    const res = await postTak(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_TAK_CONFIG' });
    expect(setGenericModuleConfig).not.toHaveBeenCalled();
  });

  it('needs configuration:write on the source', async () => {
    const res = await postTak({ team: 5, role: 2 }, false);

    expect(res.status).toBe(403);
    expect(setGenericModuleConfig).not.toHaveBeenCalled();
  });
});
