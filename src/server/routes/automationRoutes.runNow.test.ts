/**
 * Automation "Run Now" route (#4827).
 *
 * `POST /api/automations/:id/run-now` fires an automation's actions FOR REAL via
 * the engine's real dispatch path — distinct from the safe `/:id/test` dry-run.
 * These prove it (a) is gated on `automations:write` exactly like editing, and
 * (b) delegates to the engine's real-execution method rather than re-implementing
 * dispatch. The engine singleton is mocked (a non-DB service mock) so the test
 * asserts the wiring without touching the mesh; permission enforcement runs
 * against the harness's real auth middleware + SQLite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// Non-DB service mock: control what the route sees as the running engine.
vi.mock('../services/automation/automationEngineSingleton.js', () => ({
  getAutomationEngine: vi.fn(),
  reloadAutomations: vi.fn().mockResolvedValue(undefined),
}));

import automationRouter from './automationRoutes.js';
import { getAutomationEngine } from '../services/automation/automationEngineSingleton.js';

const mockedGetEngine = getAutomationEngine as unknown as ReturnType<typeof vi.fn>;

describe('POST /api/automations/:id/run-now', () => {
  let harness: RouteTestHarness;
  let runNow: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/automations', automationRouter),
    });
    runNow = vi.fn().mockResolvedValue({
      ran: true,
      status: 'completed',
      actions: [{ nodeId: 'a1', ok: true }],
      steps: [{ nodeId: 'a1', type: 'action.reboot', outcome: 'action:ok' }],
    });
    mockedGetEngine.mockReturnValue({ runNow });
  });

  afterEach(async () => {
    await harness.cleanup();
    vi.clearAllMocks();
  });

  it('rejects a user without automations:write with 403 and never fires', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/automations/auto-1/run-now');
    expect(res.status).toBe(403);
    expect(runNow).not.toHaveBeenCalled();
  });

  it('invokes the engine real-execution path when permitted', async () => {
    await harness.grant(harness.limited.id, 'automations', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/automations/auto-1/run-now');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        ran: true,
        status: 'completed',
        actions: [{ nodeId: 'a1', ok: true }],
        steps: [{ nodeId: 'a1', type: 'action.reboot', outcome: 'action:ok' }],
      },
    });
    // Delegated to the engine's real-execution method with this automation id.
    expect(runNow).toHaveBeenCalledTimes(1);
    expect(runNow).toHaveBeenCalledWith('auto-1');
  });

  it('surfaces a cooldown/rate-limit suppression as 200 with the verdict', async () => {
    runNow.mockResolvedValue({ ran: false, reason: 'cooldown', detail: 'cooldown active — 30s remaining (automation)' });
    await harness.grant(harness.limited.id, 'automations', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/automations/auto-1/run-now');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.ran).toBe(false);
    expect(res.body.data.reason).toBe('cooldown');
  });

  it('returns 404 when the automation does not exist', async () => {
    runNow.mockResolvedValue({ ran: false, reason: 'not_found' });
    await harness.grant(harness.limited.id, 'automations', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/automations/missing/run-now');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AUTOMATION_NOT_FOUND');
  });

  it('returns 503 when the engine is not started', async () => {
    mockedGetEngine.mockReturnValue(null);
    await harness.grant(harness.limited.id, 'automations', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/automations/auto-1/run-now');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ENGINE_NOT_READY');
    expect(runNow).not.toHaveBeenCalled();
  });
});
