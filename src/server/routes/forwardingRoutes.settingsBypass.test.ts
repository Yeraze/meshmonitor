/**
 * Forwarding rules (#5446) are editable ONLY with per-source `automation`
 * permission. The generic /api/settings route (gated on `settings`) must not
 * write them, and its public GET must not expose them to non-admins, while the
 * dedicated /api/sources/:id/forwarding route keeps working.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import forwardingRoutes from './forwardingRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { FORWARDING_SETTING_KEY } from '../../types/forwarding.js';

const RULE = {
  id: 'fw-1',
  name: 'DMs to phone',
  enabled: true,
  match: { isDM: true },
  forwardTo: { destinationNodeId: '!0000beef' },
  prefix: '',
};
const SAVED = JSON.stringify([RULE]);

async function grantBoth(userId: number, resource: string, sourceId: string) {
  await databaseService.auth.createPermission({
    userId,
    resource,
    canRead: true,
    canWrite: true,
    canViewOnMap: false,
    sourceId,
    grantedAt: Date.now(),
    grantedBy: null,
  });
}

describe('forwardingRules — no bypass through /api/settings', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/settings', settingsRoutes);
        app.use('/api/sources/:id/forwarding', forwardingRoutes);
      },
    });
    await databaseService.settings.setSourceSetting(harness.sourceA, FORWARDING_SETTING_KEY, SAVED);
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.cleanup();
  });

  it('settings:write without automation cannot change forwardingRules via POST /api/settings', async () => {
    await grantBoth(harness.limited.id, 'settings', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ [FORWARDING_SETTING_KEY]: '[]', maxNodeAgeHours: '48' });
    // The save succeeds for the keys this user may write...
    expect(res.status).toBe(200);
    // ...but forwardingRules is not one of them.
    const stored = await databaseService.settings.getSettingForSource(harness.sourceA, FORWARDING_SETTING_KEY);
    expect(stored).toBe(SAVED);
  });

  it('the same user cannot use the dedicated route either (no automation grant)', async () => {
    await grantBoth(harness.limited.id, 'settings', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/sources/${harness.sourceA}/forwarding`).send({ rules: [] });
    expect(res.status).toBe(403);
    const stored = await databaseService.settings.getSettingForSource(harness.sourceA, FORWARDING_SETTING_KEY);
    expect(stored).toBe(SAVED);
  });

  it('even an admin cannot write forwardingRules through POST /api/settings', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ [FORWARDING_SETTING_KEY]: '[]' });
    expect(res.status).toBe(200);
    const stored = await databaseService.settings.getSettingForSource(harness.sourceA, FORWARDING_SETTING_KEY);
    expect(stored).toBe(SAVED);
  });

  it('GET /api/settings hides forwardingRules from non-admins', async () => {
    await grantBoth(harness.limited.id, 'settings', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/api/settings?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty(FORWARDING_SETTING_KEY);

    const anon = await harness.loginAs(null);
    const anonRes = await anon.get(`/api/settings?sourceId=${harness.sourceA}`);
    expect(anonRes.body).not.toHaveProperty(FORWARDING_SETTING_KEY);
  });

  it('automation:write on the source still reads and saves through the dedicated route', async () => {
    await grantBoth(harness.limited.id, 'automation', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const got = await agent.get(`/api/sources/${harness.sourceA}/forwarding`);
    expect(got.status).toBe(200);
    expect(got.body.data.rules[0].id).toBe('fw-1');

    const res = await agent
      .post(`/api/sources/${harness.sourceA}/forwarding`)
      .send({ rules: [{ ...RULE, enabled: false }] });
    expect(res.status).toBe(200);
    const stored = await databaseService.settings.getSettingForSource(harness.sourceA, FORWARDING_SETTING_KEY);
    expect(JSON.parse(stored!)[0].enabled).toBe(false);
  });
});
