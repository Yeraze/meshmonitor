/**
 * Automation dry-run routes with action.setAutomationEnabled (#5445).
 *
 * The Test panel must never change an automation: it reports what WOULD change,
 * fails an unknown id, and (for a saved automation) stops the dry run at a
 * self-disable exactly like a real run does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../services/automation/automationEngineSingleton.js', () => ({
  getAutomationEngine: vi.fn(),
  reloadAutomations: vi.fn().mockResolvedValue(undefined),
}));

import automationRouter from './automationRoutes.js';
import databaseService from '../../services/database.js';

const notifyOnly = JSON.stringify({
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.message', params: {} },
    { id: 'n', type: 'action.notify', params: { body: 'b' } },
  ],
  edges: [{ from: 't', to: 'n' }],
});

function setGraph(params: Record<string, unknown>) {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.message', params: {} },
      { id: 's', type: 'action.setAutomationEnabled', params },
      { id: 'n', type: 'action.notify', params: { body: 'after' } },
    ],
    edges: [{ from: 't', to: 's' }, { from: 's', to: 'n' }],
  };
}

const EVENT = { kind: 'message', text: 'hi' };

describe('automation dry-run with action.setAutomationEnabled (#5445)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/automations', automationRouter) });
  });

  const writer = async () => {
    await harness.grant(harness.limited.id, 'automations', 'write');
    return harness.loginAs(harness.limited);
  };

  afterEach(async () => {
    await harness.cleanup();
    vi.clearAllMocks();
  });

  it('POST /test reports the change without writing it', async () => {
    const target = await databaseService.automations.createAutomation({ name: 'Target', enabled: true, config: notifyOnly });
    const agent = await writer();
    const res = await agent.post('/api/automations/test')
      .send({ config: setGraph({ automationId: target.id, enabled: false }), event: EVENT });
    expect(res.status).toBe(200);
    expect(res.body.actions[0]).toMatchObject({
      type: 'action.setAutomationEnabled', ok: true,
      resolvedParams: { automationId: target.id, name: 'Target', enabled: false, previous: true },
    });
    expect((await databaseService.automations.getAutomation(target.id))?.enabled).toBe(true);
  });

  it('POST /test fails the step for an unknown id', async () => {
    const agent = await writer();
    const res = await agent.post('/api/automations/test')
      .send({ config: setGraph({ automationId: 'missing', enabled: true }), event: EVENT });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.actions[0].error).toMatch(/no automation with id "missing"/);
  });

  it('POST /:id/test stops at a self-disable and leaves the automation enabled', async () => {
    const self = await databaseService.automations.createAutomation({ name: 'One shot', enabled: true, config: notifyOnly });
    await databaseService.automations.updateAutomation(self.id, {
      config: JSON.stringify(setGraph({ automationId: self.id, enabled: false })),
    });
    const agent = await writer();
    const res = await agent.post(`/api/automations/${self.id}/test`).send({ event: EVENT });
    expect(res.status).toBe(200);
    expect(res.body.actions.map((a: { nodeId: string }) => a.nodeId)).toEqual(['s']);
    expect(res.body.steps.at(-1).outcome).toBe('run:halted');
    expect((await databaseService.automations.getAutomation(self.id))?.enabled).toBe(true);
  });

  it('rejects a user without automations:write', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/automations/test')
      .send({ config: setGraph({ automationId: 'x', enabled: true }), event: EVENT });
    expect(res.status).toBe(403);
  });
});
