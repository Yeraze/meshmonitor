/**
 * Forwarding routes (#5446) — per-source permission gating + validation,
 * against the real auth middleware via createRouteTestApp.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  prefix: '{from}: ',
};

describe('forwardingRoutes — per-source permissions', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/:id/forwarding', forwardingRoutes),
    });
    // One row carries both flags (permissions are unique per user/resource/source).
    await databaseService.auth.createPermission({
      userId: harness.limited.id,
      resource: 'automation',
      canRead: true,
      canWrite: true,
      canViewOnMap: false,
      sourceId: harness.sourceA,
      grantedAt: Date.now(),
      grantedBy: null,
    });
    await databaseService.settings.setSourceSetting(harness.sourceA, FORWARDING_SETTING_KEY, '[]');
    await databaseService.settings.setSourceSetting(harness.sourceB, FORWARDING_SETTING_KEY, '[]');
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('GET on a granted source returns rules and the fixed limits', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceA}/forwarding`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.rules).toEqual([]);
    expect(res.body.data.limits).toEqual({ maxPerWindow: 5, windowSeconds: 60, maxTextChars: 200 });
  });

  it('GET on another source is denied', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceB}/forwarding`);
    expect(res.status).toBe(403);
  });

  it('POST on a granted source saves rules scoped to that source only', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/${harness.sourceA}/forwarding`).send({ rules: [RULE] });
    expect(res.status).toBe(200);
    expect(res.body.data.rules[0].name).toBe('DMs to phone');

    const saved = await databaseService.settings.getSettingForSource(harness.sourceA, FORWARDING_SETTING_KEY);
    expect(JSON.parse(saved!)[0].id).toBe('fw-1');
    const other = await databaseService.settings.getSettingForSource(harness.sourceB, FORWARDING_SETTING_KEY);
    expect(JSON.parse(other!)).toEqual([]);
  });

  it('POST on another source is denied and writes nothing', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/${harness.sourceB}/forwarding`).send({ rules: [RULE] });
    expect(res.status).toBe(403);
    const other = await databaseService.settings.getSettingForSource(harness.sourceB, FORWARDING_SETTING_KEY);
    expect(JSON.parse(other!)).toEqual([]);
  });

  it('POST with read-only access is denied', async () => {
    await harness.revokeAll(harness.limited.id);
    await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/${harness.sourceA}/forwarding`).send({ rules: [RULE] });
    expect(res.status).toBe(403);
  });

  it('POST without a session is rejected', async () => {
    const anon = await harness.loginAs(null);
    const res = await anon.post(`/${harness.sourceA}/forwarding`).send({ rules: [RULE] });
    expect([401, 403]).toContain(res.status);
  });

  it('rejects structurally invalid rules with INVALID_FORWARDING_RULES', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/${harness.sourceA}/forwarding`)
      .send({ rules: [{ ...RULE, forwardTo: { channel: 1, destinationNodeId: '!1' } }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_FORWARDING_RULES' });
  });

  it('rejects an unsafe text regex', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/${harness.sourceA}/forwarding`)
      .send({ rules: [{ ...RULE, match: { isDM: true, textRegex: '(a+)+' } }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FORWARDING_RULES');
  });
});
