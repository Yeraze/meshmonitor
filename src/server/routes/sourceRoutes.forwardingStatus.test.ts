/**
 * GET /:id/status carries the Message Forwarding summary for the sidebar FWD
 * pill (#5537) — only for callers with per-source `automation` read, only when
 * the source has rules, and with `canWrite` reflecting `automation` write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { FORWARDING_ENABLED_SETTING_KEY, FORWARDING_SETTING_KEY } from '../../types/forwarding.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

const rule = (id: string, enabled: boolean) => ({
  id, name: id, enabled, match: { isDM: true }, forwardTo: { destinationNodeId: '!0000beef' }, prefix: '',
});

async function grant(userId: number, sourceId: string, canWrite: boolean) {
  await databaseService.auth.createPermission({
    userId, resource: 'automation', canRead: true, canWrite,
    canViewOnMap: false, sourceId, grantedAt: Date.now(), grantedBy: null,
  });
}

describe('sourceRoutes — forwarding summary on /:id/status (#5537)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
    await databaseService.settings.setSourceSetting(
      harness.sourceA, FORWARDING_SETTING_KEY, JSON.stringify([rule('a', true), rule('b', false), rule('c', true)]),
    );
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('admin sees state, rule counts and canWrite', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.status).toBe(200);
    expect(res.body.forwarding).toEqual({ enabled: true, ruleCount: 3, activeRuleCount: 2, canWrite: true });
  });

  it('reports the master switch as stored', async () => {
    await databaseService.settings.setSourceSetting(harness.sourceA, FORWARDING_ENABLED_SETTING_KEY, 'false');
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.body.forwarding.enabled).toBe(false);
  });

  it('is absent when the source has no rules', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceB}/status`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('forwarding');
  });

  it('automation read only: shown read-only', async () => {
    await grant(harness.limited.id, harness.sourceA, false);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.body.forwarding).toMatchObject({ enabled: true, ruleCount: 3, canWrite: false });
  });

  it('automation write: canWrite true', async () => {
    await grant(harness.limited.id, harness.sourceA, true);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.body.forwarding.canWrite).toBe(true);
  });

  it('is hidden from callers without automation read on that source', async () => {
    await grant(harness.limited.id, harness.sourceB, true);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('forwarding');

    const anon = await harness.loginAs(null);
    const anonRes = await anon.get(`/${harness.sourceA}/status`);
    expect(anonRes.body).not.toHaveProperty('forwarding');
  });
});
