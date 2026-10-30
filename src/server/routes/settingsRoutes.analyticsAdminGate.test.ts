/**
 * /api/settings — analytics provider/config are admin-only to write (#6064).
 *
 * The analytics settings inject a <script> into the HTML <head> served to every
 * visitor, and the `custom` provider is intentional arbitrary-script injection.
 * The Settings UI already gates this section on isAdmin; the server must agree,
 * so a non-admin `settings:write` grantee cannot set either key.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('/api/settings — analytics admin-only write (#6064)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSetting('analyticsProvider').catch(() => {});
    await harness.db.settings.deleteSetting('analyticsConfig').catch(() => {});
    await harness.cleanup();
  });

  it('lets an admin set the analytics provider and config', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post('/api/settings').send({
      analyticsProvider: 'custom',
      analyticsConfig: '{"script":"<script>console.log(1)</script>"}',
    });
    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSetting('analyticsProvider')).toBe('custom');
    expect(await harness.db.settings.getSetting('analyticsConfig'))
      .toBe('{"script":"<script>console.log(1)</script>"}');
  });

  it('drops both keys from a non-admin settings:write save', async () => {
    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
    const user = await harness.loginAs(harness.limited);

    const res = await user.post('/api/settings').send({
      analyticsProvider: 'custom',
      analyticsConfig: '{"script":"<script>alert(document.cookie)</script>"}',
    });
    // The request succeeds (other keys may persist) but the analytics keys are dropped.
    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSetting('analyticsProvider')).toBeNull();
    expect(await harness.db.settings.getSetting('analyticsConfig')).toBeNull();
  });

  it('a non-admin cannot overwrite an existing admin-set analytics config', async () => {
    await harness.db.settings.setSetting('analyticsProvider', 'none');
    await harness.db.settings.setSetting('analyticsConfig', '{}');

    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
    const user = await harness.loginAs(harness.limited);

    await user.post('/api/settings').send({
      analyticsProvider: 'custom',
      analyticsConfig: '{"script":"<script>alert(1)</script>"}',
    });

    expect(await harness.db.settings.getSetting('analyticsProvider')).toBe('none');
    expect(await harness.db.settings.getSetting('analyticsConfig')).toBe('{}');
  });
});
