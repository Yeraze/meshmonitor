/**
 * Timer save guard: a split-enabled timer needs >= 5 min between fires (#6316).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import automationRoutes from './meshcoreAutomationRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

describe('meshcoreAutomationRoutes timers: split interval floor (#6316)', () => {
  let harness: RouteTestHarness;
  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/sources/:id/meshcore', automationRoutes) });
  });
  afterEach(async () => {
    await databaseService.settings.deleteSourceSettings(harness.sourceA);
    await harness.cleanup();
  });

  it('rejects a split timer under 5 minutes and stores nothing', async () => {
    await databaseService.auth.createPermission({
      userId: harness.limited.id, resource: 'automation', canRead: true, canWrite: true,
      canViewOnMap: false, sourceId: harness.sourceA, grantedAt: Date.now(), grantedBy: null,
    });
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/sources/${harness.sourceA}/meshcore/automation/timers`).send({
      triggers: [{ id: 't', name: 'x', enabled: true, scheduleType: 'interval', intervalMinutes: 2, responseType: 'text', response: 'hi', multiline: true }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SPLIT_TIMER_INTERVAL_TOO_SHORT');
    expect(await databaseService.settings.getSettingForSource(harness.sourceA, 'meshcoreTimerTriggers')).toBeNull();
  });

  it('rejects a timer with more than 4 channels and stores nothing (M5)', async () => {
    await databaseService.auth.createPermission({
      userId: harness.limited.id, resource: 'automation', canRead: true, canWrite: true,
      canViewOnMap: false, sourceId: harness.sourceA, grantedAt: Date.now(), grantedBy: null,
    });
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/sources/${harness.sourceA}/meshcore/automation/timers`).send({
      triggers: [{ id: 't', name: 'x', enabled: true, scheduleType: 'interval', intervalMinutes: 60, responseType: 'text', response: 'hi', destination: 'channel', channelIndexes: [0, 1, 2, 3, 4] }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'TIMER_TOO_MANY_CHANNELS' });
    expect(await databaseService.settings.getSettingForSource(harness.sourceA, 'meshcoreTimerTriggers')).toBeNull();
  });
});
