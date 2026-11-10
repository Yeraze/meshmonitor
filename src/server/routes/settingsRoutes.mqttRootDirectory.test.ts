/**
 * /api/settings — MQTT root finder directory refresh switch (#6337):
 * round-trip, strict boolean, admin-only write, global only.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('/api/settings — mqttRootDirectoryRefreshEnabled (#6337)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSetting('mqttRootDirectoryRefreshEnabled').catch(() => {});
    await harness.cleanup();
  });

  it('round-trips through save and load for an admin', async () => {
    const admin = await harness.loginAs(harness.admin);
    expect((await admin.post('/api/settings').send({ mqttRootDirectoryRefreshEnabled: 'true' })).status).toBe(200);
    expect(await harness.db.settings.getSetting('mqttRootDirectoryRefreshEnabled')).toBe('true');
    expect((await admin.get('/api/settings')).body.mqttRootDirectoryRefreshEnabled).toBe('true');

    await admin.post('/api/settings').send({ mqttRootDirectoryRefreshEnabled: 'false' });
    expect((await admin.get('/api/settings')).body.mqttRootDirectoryRefreshEnabled).toBe('false');
  });

  it('rejects a non-boolean value', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post('/api/settings').send({ mqttRootDirectoryRefreshEnabled: '1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BOOLEAN_SETTING');
    expect(await harness.db.settings.getSetting('mqttRootDirectoryRefreshEnabled')).toBeNull();
  });

  it('a non-admin settings writer can neither turn it on nor off', async () => {
    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
    const user = await harness.loginAs(harness.limited);

    expect((await user.post('/api/settings').send({ mqttRootDirectoryRefreshEnabled: 'true' })).status).toBe(200);
    expect(await harness.db.settings.getSetting('mqttRootDirectoryRefreshEnabled')).toBeNull();

    await harness.db.settings.setSetting('mqttRootDirectoryRefreshEnabled', 'true');
    await user.post('/api/settings').send({ mqttRootDirectoryRefreshEnabled: 'false' });
    expect(await harness.db.settings.getSetting('mqttRootDirectoryRefreshEnabled')).toBe('true');
  });

  it('is dropped from a per-source save', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post(`/api/settings?sourceId=${harness.sourceA}`).send({ mqttRootDirectoryRefreshEnabled: 'true' });
    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSetting('mqttRootDirectoryRefreshEnabled')).toBeNull();
  });
});
