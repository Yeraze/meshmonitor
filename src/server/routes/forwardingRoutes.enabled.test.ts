/**
 * Forwarding master switch (#5537) — GET exposes `enabled`, PUT /enabled is
 * gated on per-source `automation` write, and the value persists in the DB.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import forwardingRoutes from './forwardingRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { FORWARDING_ENABLED_SETTING_KEY } from '../../types/forwarding.js';
import { forwardingRateLimiter } from '../utils/forwardingEngine.js';
import { isForwardingEnabled } from '../services/forwardingStateService.js';

describe('forwardingRoutes — master switch (#5537)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/:id/forwarding', forwardingRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('GET reports enabled=true when the switch was never set', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/forwarding`);
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
  });

  it('PUT with automation:write turns it off, persists it, and GET reflects it', async () => {
    // One row carries both flags (permissions are unique per user/resource/source).
    await databaseService.auth.createPermission({
      userId: harness.limited.id, resource: 'automation', canRead: true, canWrite: true,
      canViewOnMap: false, sourceId: harness.sourceA, grantedAt: Date.now(), grantedBy: null,
    });
    const agent = await harness.loginAs(harness.limited);

    const put = await agent.put(`/${harness.sourceA}/forwarding/enabled`).send({ enabled: false });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ success: true, data: { enabled: false } });
    expect(await databaseService.settings.getSettingForSource(harness.sourceA, FORWARDING_ENABLED_SETTING_KEY)).toBe('false');
    expect(await isForwardingEnabled(harness.sourceA)).toBe(false);
    // Per source: the other source is untouched.
    expect(await isForwardingEnabled(harness.sourceB)).toBe(true);

    const got = await agent.get(`/${harness.sourceA}/forwarding`);
    expect(got.body.data.enabled).toBe(false);

    const on = await agent.put(`/${harness.sourceA}/forwarding/enabled`).send({ enabled: true });
    expect(on.status).toBe(200);
    expect(await isForwardingEnabled(harness.sourceA)).toBe(true);
  });

  it('PUT with only automation:read is denied and changes nothing', async () => {
    await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.put(`/${harness.sourceA}/forwarding/enabled`).send({ enabled: false });
    expect(res.status).toBe(403);
    expect(await isForwardingEnabled(harness.sourceA)).toBe(true);
  });

  it('PUT on a source the user holds no grant for is denied', async () => {
    await harness.grant(harness.limited.id, 'automation', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.put(`/${harness.sourceB}/forwarding/enabled`).send({ enabled: false });
    expect(res.status).toBe(403);
    expect(await isForwardingEnabled(harness.sourceB)).toBe(true);
  });

  it('PUT anonymously is rejected', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.put(`/${harness.sourceA}/forwarding/enabled`).send({ enabled: false });
    expect(res.status).toBe(401);
    expect(await isForwardingEnabled(harness.sourceA)).toBe(true);
  });

  it('PUT rejects a non-boolean body with the fail() envelope', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put(`/${harness.sourceA}/forwarding/enabled`).send({ enabled: 'false' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('INVALID_REQUEST');
    expect(await isForwardingEnabled(harness.sourceA)).toBe(true);
  });

  it('flipping the switch leaves a spent rate-limit window spent', async () => {
    forwardingRateLimiter.clear();
    const key = `${harness.sourceA}:r1`;
    const now = Date.now();
    for (let i = 0; i < 5; i++) expect(forwardingRateLimiter.tryConsume(key, now)).toBe(true);
    const agent = await harness.loginAs(harness.admin);
    await agent.put(`/${harness.sourceA}/forwarding/enabled`).send({ enabled: false });
    await agent.put(`/${harness.sourceA}/forwarding/enabled`).send({ enabled: true });
    expect(forwardingRateLimiter.tryConsume(key, now + 1)).toBe(false);
    forwardingRateLimiter.clear();
  });
});
