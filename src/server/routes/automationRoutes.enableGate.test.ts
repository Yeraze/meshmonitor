/**
 * Per-source forwarding-toggle gate on automation ACTIVATION paths (#6096).
 *
 * `POST /api/automations/:id/enable` (and `PUT /api/automations/:id` when it
 * flips `enabled` on without supplying a new config) arm the scheduler: a
 * forwarding-toggle automation then fires on its own against the sources its
 * graph targets. So the same per-source gate the save/run-now paths enforce
 * (#6071) must apply here too — a user holding only the global
 * `automations:write` grant must not activate a forwarding-toggle rule someone
 * else authored against a source they lack per-source `automation` write on.
 *
 * Mirrors automationRoutes.runNow.test.ts. The engine singleton is mocked (a
 * non-DB service mock); permission enforcement runs against the harness's real
 * auth middleware + SQLite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../services/automation/automationEngineSingleton.js', () => ({
  getAutomationEngine: vi.fn(),
  reloadAutomations: vi.fn().mockResolvedValue(undefined),
}));

import automationRouter from './automationRoutes.js';
import databaseService from '../../services/database.js';

/** A schedule-triggered graph that flips forwarding off on each target source. */
function fwdGraph(...targets: string[]) {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.schedule', params: { cron: '0 22 * * *' } },
      ...targets.map((sourceId, i) => ({
        id: `f${i}`, type: 'action.setSourceForwardingEnabled', params: { sourceId, mode: 'set', enabled: 'false' },
      })),
    ],
    edges: targets.map((_s, i) => ({ from: i === 0 ? 't' : `f${i - 1}`, to: `f${i}` })),
  };
}

const plainGraph = {
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.schedule', params: { cron: '0 22 * * *' } },
    { id: 'n', type: 'action.notify', params: { body: 'b' } },
  ],
  edges: [{ from: 't', to: 'n' }],
};

describe('POST /api/automations/:id/enable — per-source forwarding gate (#6096)', () => {
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

  it('rejects enable of a forwarding-toggle automation without per-source grant', async () => {
    const row = await databaseService.automations.createAutomation({
      name: 'Quiet A', enabled: false, config: JSON.stringify(fwdGraph(harness.sourceA)),
    });
    await harness.grant(harness.limited.id, 'automations', 'write'); // global only
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/automations/${row.id}/enable`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'FORWARDING_SOURCE_FORBIDDEN', sourceIds: [harness.sourceA] });
    // Guard ran before the mutation: the row is still disabled.
    expect((await databaseService.automations.getAutomation(row.id))?.enabled).toBe(false);
  });

  it('allows enable once the caller holds per-source automation write', async () => {
    const row = await databaseService.automations.createAutomation({
      name: 'Quiet A', enabled: false, config: JSON.stringify(fwdGraph(harness.sourceA)),
    });
    await harness.grant(harness.limited.id, 'automations', 'write');
    await harness.grant(harness.limited.id, 'automation', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/automations/${row.id}/enable`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect((await databaseService.automations.getAutomation(row.id))?.enabled).toBe(true);
  });

  it('admins pass the per-source gate', async () => {
    const row = await databaseService.automations.createAutomation({
      name: 'Quiet A', enabled: false, config: JSON.stringify(fwdGraph(harness.sourceA)),
    });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(`/api/automations/${row.id}/enable`);
    expect(res.status).toBe(200);
    expect((await databaseService.automations.getAutomation(row.id))?.enabled).toBe(true);
  });

  it('an automation without a forwarding-toggle action is unaffected', async () => {
    const row = await databaseService.automations.createAutomation({
      name: 'Plain', enabled: false, config: JSON.stringify(plainGraph),
    });
    await harness.grant(harness.limited.id, 'automations', 'write'); // global only
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/automations/${row.id}/enable`);
    expect(res.status).toBe(200);
    expect((await databaseService.automations.getAutomation(row.id))?.enabled).toBe(true);
  });

  it('rejects a user without automations:write with 403', async () => {
    const row = await databaseService.automations.createAutomation({
      name: 'Plain', enabled: false, config: JSON.stringify(plainGraph),
    });
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/automations/${row.id}/enable`);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/automations/:id — enabling without a new config is gated (#6096)', () => {
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

  it('refuses enabling a forwarding-toggle automation via PUT {enabled:true} without per-source grant', async () => {
    const row = await databaseService.automations.createAutomation({
      name: 'Quiet A', enabled: false, config: JSON.stringify(fwdGraph(harness.sourceA)),
    });
    await harness.grant(harness.limited.id, 'automations', 'write'); // global only
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.put(`/api/automations/${row.id}`).send({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'FORWARDING_SOURCE_FORBIDDEN', sourceIds: [harness.sourceA] });
    expect((await databaseService.automations.getAutomation(row.id))?.enabled).toBe(false);
  });

  it('allows PUT {enabled:true} once the caller holds per-source automation write', async () => {
    const row = await databaseService.automations.createAutomation({
      name: 'Quiet A', enabled: false, config: JSON.stringify(fwdGraph(harness.sourceA)),
    });
    await harness.grant(harness.limited.id, 'automations', 'write');
    await harness.grant(harness.limited.id, 'automation', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.put(`/api/automations/${row.id}`).send({ enabled: true });
    expect(res.status).toBe(200);
    expect((await databaseService.automations.getAutomation(row.id))?.enabled).toBe(true);
  });

  it('PUT {enabled:false} (disabling) is never gated', async () => {
    const row = await databaseService.automations.createAutomation({
      name: 'Quiet A', enabled: true, config: JSON.stringify(fwdGraph(harness.sourceA)),
    });
    await harness.grant(harness.limited.id, 'automations', 'write'); // global only
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.put(`/api/automations/${row.id}`).send({ enabled: false });
    expect(res.status).toBe(200);
    expect((await databaseService.automations.getAutomation(row.id))?.enabled).toBe(false);
  });
});
