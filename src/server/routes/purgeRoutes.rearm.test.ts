/**
 * POST /api/purge/nodes restarts the new-node learning window of MQTT feed
 * sources (#6341 P2). TCP sources have no gate, so they are left alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import purgeRoutes from './purgeRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { newNodeAlertGate } from '../services/newNodeAlertGate.js';

const mockManager = { refreshNodeDatabase: vi.fn().mockResolvedValue(undefined) };
vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn(() => mockManager),
  resolveOwnMeshtasticManager: vi.fn(() => mockManager),
}));

describe('purge nodes re-arms gated feed sources (#6341 P2)', () => {
  let harness: RouteTestHarness;
  let rearm: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/purge', purgeRoutes) });
    rearm = vi.spyOn(newNodeAlertGate, 'rearm').mockResolvedValue(undefined);
    vi.spyOn(harness.db.sources, 'getAllSources').mockResolvedValue([
      { id: 'bridge', type: 'mqtt_bridge' },
      { id: 'broker', type: 'mqtt_broker' },
      { id: 'tcp', type: 'meshtastic_tcp' },
    ] as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  it('re-arms a gated source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/purge/nodes').send({ sourceId: 'bridge' });
    expect(res.status).toBe(200);
    expect(rearm.mock.calls.map(c => c[0])).toEqual(['bridge']);
  });

  it('does not re-arm a TCP source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/purge/nodes').send({ sourceId: 'tcp' });
    expect(res.status).toBe(200);
    expect(rearm).not.toHaveBeenCalled();
  });

  it('a global purge re-arms every gated source and no TCP source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/purge/nodes').send({});
    expect(res.status).toBe(200);
    expect(rearm.mock.calls.map(c => c[0]).sort()).toEqual(['bridge', 'broker']);
  });
});
