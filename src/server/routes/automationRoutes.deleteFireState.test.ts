/**
 * Deleting an automation drops its stored cooldown / rate-limit state
 * (`automation_fire_state`) and leaves other automations' state alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../services/automation/automationEngineSingleton.js', () => ({
  getAutomationEngine: vi.fn(),
  reloadAutomations: vi.fn().mockResolvedValue(undefined),
}));

import automationRouter from './automationRoutes.js';
import databaseService from '../../services/database.js';

const CONFIG = JSON.stringify({
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.message', params: { cooldownSeconds: 600 } },
    { id: 'n', type: 'action.notify', params: { body: 'x' } },
  ],
  edges: [{ from: 't', to: 'n' }],
});

describe('DELETE /api/automations/:id clears fire state', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/automations', automationRouter),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
    vi.clearAllMocks();
  });

  it('removes the deleted rule\'s rows only', async () => {
    const repo = databaseService.automationFireStateRepo!;
    const doomed = await databaseService.automations.createAutomation({ name: 'doomed', enabled: true, config: CONFIG });
    const kept = await databaseService.automations.createAutomation({ name: 'kept', enabled: true, config: CONFIG });
    await repo.upsertCooldown(doomed.id, '', 1000);
    await repo.upsertRateEvents(doomed.id, [1000]);
    await repo.upsertCooldown(kept.id, '', 1000);

    await harness.grant(harness.limited.id, 'automations', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.delete(`/api/automations/${doomed.id}`);
    expect(res.status).toBe(200);

    expect(await repo.listByAutomation(doomed.id)).toEqual([]);
    expect(await repo.listByAutomation(kept.id)).toHaveLength(1);
    await repo.deleteByAutomation(kept.id);
  });
});
