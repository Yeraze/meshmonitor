/**
 * action.setSourceForwardingEnabled (#5537) — the save-time permission gate,
 * the dry run, and the live deps that write the switch.
 *
 * Automations are global and run as the system, so saving one that flips a
 * source's forwarding needs per-source `automation` write on every target
 * source (admins pass). That check is the only gate, so every save path —
 * create, update, import, duplicate — must apply it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../services/automation/automationEngineSingleton.js', () => ({
  getAutomationEngine: vi.fn(),
  reloadAutomations: vi.fn().mockResolvedValue(undefined),
}));

const { getManagerMock } = vi.hoisted(() => ({ getManagerMock: vi.fn().mockReturnValue(null) }));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: getManagerMock, getAllManagers: vi.fn().mockReturnValue([]) },
}));

import automationRouter from './automationRoutes.js';
import databaseService from '../../services/database.js';
import { isForwardingEnabled, setForwardingEnabled } from '../services/forwardingStateService.js';
import { createMeshActionDeps } from '../services/automation/meshActionDeps.js';
import { FORWARDING_ENABLED_SETTING_KEY } from '../../types/forwarding.js';

function fwdGraph(...targets: Array<string>) {
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

const notifyOnly = {
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.message', params: {} },
    { id: 'n', type: 'action.notify', params: { body: 'b' } },
  ],
  edges: [{ from: 't', to: 'n' }],
};

describe('action.setSourceForwardingEnabled (#5537)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/automations', automationRouter) });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.cleanup();
    vi.clearAllMocks();
  });

  /** automations:write (global) plus `automation` write on the given sources. */
  const writer = async (...sources: string[]) => {
    await harness.grant(harness.limited.id, 'automations', 'write');
    for (const s of sources) await harness.grant(harness.limited.id, 'automation', 'write', s);
    return harness.loginAs(harness.limited);
  };

  describe('save-time permission check', () => {
    it('create is refused without automation write on the target source', async () => {
      const agent = await writer();
      const before = (await databaseService.automations.listAutomations()).length;
      const res = await agent.post('/api/automations').send({ name: 'Quiet', config: fwdGraph(harness.sourceA) });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ success: false, code: 'FORWARDING_SOURCE_FORBIDDEN', sourceIds: [harness.sourceA] });
      expect(await databaseService.automations.listAutomations()).toHaveLength(before);
    });

    it('create succeeds with automation write on the target source', async () => {
      const agent = await writer(harness.sourceA);
      const res = await agent.post('/api/automations').send({ name: 'Quiet', config: fwdGraph(harness.sourceA) });
      expect(res.status).toBe(201);
    });

    it('every target is checked: a grant on one source does not cover another', async () => {
      const agent = await writer(harness.sourceA);
      const res = await agent.post('/api/automations')
        .send({ name: 'Quiet', config: fwdGraph(harness.sourceA, harness.sourceB) });
      expect(res.status).toBe(403);
      expect(res.body.sourceIds).toEqual([harness.sourceB]);
    });

    it('admins pass', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/automations')
        .send({ name: 'Quiet', config: fwdGraph(harness.sourceA, harness.sourceB) });
      expect(res.status).toBe(201);
    });

    it('automations without the action are unaffected', async () => {
      const agent = await writer();
      const res = await agent.post('/api/automations').send({ name: 'Plain', config: notifyOnly });
      expect(res.status).toBe(201);
    });

    it('update that adds the action is refused without the grant', async () => {
      const row = await databaseService.automations.createAutomation({ name: 'Plain', enabled: false, config: JSON.stringify(notifyOnly) });
      const agent = await writer();
      const res = await agent.put(`/api/automations/${row.id}`).send({ config: fwdGraph(harness.sourceA) });
      expect(res.status).toBe(403);
      expect((await databaseService.automations.getAutomation(row.id))?.config).toBe(JSON.stringify(notifyOnly));
    });

    it('import is refused without the grant', async () => {
      const agent = await writer();
      const res = await agent.post('/api/automations/import').send({ name: 'Quiet', config: fwdGraph(harness.sourceA) });
      expect(res.status).toBe(403);
    });

    it("duplicating someone else's automation is refused without the grant", async () => {
      const row = await databaseService.automations.createAutomation({
        name: 'Admin quiet', enabled: false, config: JSON.stringify(fwdGraph(harness.sourceA)),
      });
      const agent = await writer();
      const before = (await databaseService.automations.listAutomations()).length;
      const res = await agent.post(`/api/automations/${row.id}/duplicate`).send({});
      expect(res.status).toBe(403);
      expect(await databaseService.automations.listAutomations()).toHaveLength(before);
    });

    it('a templated source id is rejected outright', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/automations').send({ name: 'Quiet', config: fwdGraph('{{ var.src }}') });
      expect(res.status).toBe(400);
      expect(res.body.details.join(' ')).toMatch(/must be a source, not a template/);
    });
  });

  it('dry run reports the change without writing it', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/automations/test')
      .send({ config: fwdGraph(harness.sourceA), event: { kind: 'schedule' } });
    expect(res.status).toBe(200);
    expect(res.body.actions[0]).toMatchObject({
      type: 'action.setSourceForwardingEnabled', ok: true,
      resolvedParams: { sourceId: harness.sourceA, enabled: false, previous: true },
    });
    expect(await isForwardingEnabled(harness.sourceA)).toBe(true);
  });

  describe('live deps', () => {
    it('set persists the switch per source and sends nothing', async () => {
      const deps = createMeshActionDeps();
      const r = await deps.setSourceForwardingEnabled!({ sourceId: harness.sourceA, mode: 'set', enabled: false });
      expect(r).toMatchObject({ sourceId: harness.sourceA, previous: true, enabled: false });
      expect(await databaseService.settings.getSettingForSource(harness.sourceA, FORWARDING_ENABLED_SETTING_KEY)).toBe('false');
      expect(await isForwardingEnabled(harness.sourceB)).toBe(true);
      // No manager was touched, so nothing could have been sent.
      expect(getManagerMock).not.toHaveBeenCalled();
    });

    it('toggle flips the stored state both ways', async () => {
      const deps = createMeshActionDeps();
      await setForwardingEnabled(harness.sourceA, false);
      expect(await deps.setSourceForwardingEnabled!({ sourceId: harness.sourceA, mode: 'toggle' }))
        .toMatchObject({ previous: false, enabled: true });
      expect(await isForwardingEnabled(harness.sourceA)).toBe(true);
      expect(await deps.setSourceForwardingEnabled!({ sourceId: harness.sourceA, mode: 'toggle' }))
        .toMatchObject({ previous: true, enabled: false });
      expect(await isForwardingEnabled(harness.sourceA)).toBe(false);
    });

    it('returns null for an unknown source', async () => {
      const deps = createMeshActionDeps();
      expect(await deps.setSourceForwardingEnabled!({ sourceId: 'no-such-source', mode: 'set', enabled: true })).toBeNull();
    });
  });
});
