/**
 * Automation save routes return the empty-send warning (#5697), so API and
 * import callers see what the builder shows. The save itself still succeeds:
 * an empty message is not invalid, the user may be drafting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../services/automation/automationEngineSingleton.js', () => ({
  getAutomationEngine: vi.fn(),
  reloadAutomations: vi.fn().mockResolvedValue(undefined),
}));

import automationRouter from './automationRoutes.js';

function graph(text: string) {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.message', params: {} },
      { id: 'a', type: 'action.sendMessage', params: { text } },
    ],
    edges: [{ from: 't', to: 'a' }],
  };
}

const WARNING = 'action.sendMessage "a": the message is empty, so this step will send nothing';

describe('automation save routes: empty-send warning (#5697)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/automations', automationRouter) });
  });

  afterEach(async () => {
    await harness.cleanup();
    vi.clearAllMocks();
  });

  const writer = async () => {
    await harness.grant(harness.limited.id, 'automations', 'write');
    return harness.loginAs(harness.limited);
  };

  it('POST / saves an empty message and returns the warning', async () => {
    const agent = await writer();
    const res = await agent.post('/api/automations').send({ name: 'Empty', config: graph('') });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.warnings).toEqual([WARNING]);
  });

  it('POST / returns no warnings for a message with text', async () => {
    const agent = await writer();
    const res = await agent.post('/api/automations').send({ name: 'Hi', config: graph('hello') });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toBeUndefined();
  });

  it('PUT /:id and POST /import return the same warning', async () => {
    const agent = await writer();
    const created = await agent.post('/api/automations').send({ name: 'Hi', config: graph('hello') });
    const put = await agent.put(`/api/automations/${created.body.id}`).send({ config: graph('  ') });
    expect(put.status).toBe(200);
    expect(put.body.warnings).toEqual([WARNING]);
    const imp = await agent.post('/api/automations/import').send({ name: 'Imported', config: graph('') });
    expect(imp.status).toBe(201);
    expect(imp.body.warnings).toEqual([WARNING]);
  });
});
