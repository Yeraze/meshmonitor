/**
 * /api/settings — tropospheric ducting overlay switch (#5734): round-trip,
 * strict boolean, admin-only write, readable by every map viewer.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('/api/settings — ductingOverlayEnabled (#5734)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSetting('ductingOverlayEnabled').catch(() => {});
    await harness.cleanup();
  });

  it('round-trips through save and load for an admin', async () => {
    const admin = await harness.loginAs(harness.admin);
    expect((await admin.post('/api/settings').send({ ductingOverlayEnabled: 'true' })).status).toBe(200);
    expect(await harness.db.settings.getSetting('ductingOverlayEnabled')).toBe('true');
    expect((await admin.get('/api/settings')).body.ductingOverlayEnabled).toBe('true');

    await admin.post('/api/settings').send({ ductingOverlayEnabled: 'false' });
    expect((await admin.get('/api/settings')).body.ductingOverlayEnabled).toBe('false');
  });

  it('rejects a non-boolean value', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post('/api/settings').send({ ductingOverlayEnabled: '1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BOOLEAN_SETTING');
    expect(await harness.db.settings.getSetting('ductingOverlayEnabled')).toBeNull();
  });

  it('a non-admin settings writer can neither turn it on nor off', async () => {
    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
    const user = await harness.loginAs(harness.limited);

    expect((await user.post('/api/settings').send({ ductingOverlayEnabled: 'true' })).status).toBe(200);
    expect(await harness.db.settings.getSetting('ductingOverlayEnabled')).toBeNull();

    await harness.db.settings.setSetting('ductingOverlayEnabled', 'true');
    await user.post('/api/settings').send({ ductingOverlayEnabled: 'false' });
    expect(await harness.db.settings.getSetting('ductingOverlayEnabled')).toBe('true');
  });

  it('is readable anonymously, so the map can hide or show the toggle', async () => {
    await harness.db.settings.setSetting('ductingOverlayEnabled', 'true');
    const anon = await harness.loginAs(null);
    expect((await anon.get('/api/settings')).body.ductingOverlayEnabled).toBe('true');
  });

  it('is dropped from a per-source save', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post(`/api/settings?sourceId=${harness.sourceA}`).send({ ductingOverlayEnabled: 'true' });
    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSetting('ductingOverlayEnabled')).toBeNull();
  });
});
