/**
 * Auto-Enrichment settings (#5287): save-time validation and the status /
 * run-now routes.
 *
 * The schedule floor is mesh-impact policy, so a too-frequent schedule has to
 * be refused where the user can see it (a 400 on save), not only clamped
 * silently inside the scheduler. Uses the real-middleware harness per
 * CLAUDE.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The scheduler singleton is mocked: these tests are about the routes, and a
// real run would reach analyzeEnrichment and the managers. The pure validators
// are kept real, since save-time validation is what is under test.
const runNow = vi.fn();
const getStatus = vi.fn();
vi.mock('../services/autoEnrichmentScheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/autoEnrichmentScheduler.js')>();
  return {
    ...actual,
    autoEnrichmentScheduler: {
      runNow: (...args: unknown[]) => runNow(...args),
      getStatus: (...args: unknown[]) => getStatus(...args),
    },
  };
});

import settingsRoutes from './settingsRoutes.js';
import { AutoEnrichmentInProgressError } from '../services/autoEnrichmentScheduler.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const KEYS = [
  'autoEnrichmentEnabled',
  'autoEnrichmentScheduleType',
  'autoEnrichmentIntervalMinutes',
  'autoEnrichmentCron',
  'autoEnrichmentPushToNodeDb',
];

describe('Auto-Enrichment settings (#5287)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
    runNow.mockReset();
    getStatus.mockReset();
  });

  afterEach(async () => {
    for (const key of KEYS) await harness.db.settings.deleteSetting(key).catch(() => {});
    await harness.cleanup();
  });

  it('saves a valid interval schedule', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings').send({
      autoEnrichmentEnabled: 'true',
      autoEnrichmentScheduleType: 'interval',
      autoEnrichmentIntervalMinutes: '360',
      autoEnrichmentPushToNodeDb: 'false',
    });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSetting('autoEnrichmentIntervalMinutes')).toBe('360');
    expect(await harness.db.settings.getSetting('autoEnrichmentEnabled')).toBe('true');
  });

  it.each([['30'], ['0'], ['20000'], ['abc'], ['90.5']])(
    'refuses interval %s minutes — outside the 1 hour to 7 day window',
    async (minutes) => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/settings').send({ autoEnrichmentIntervalMinutes: minutes });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_AUTO_ENRICHMENT_INTERVAL');
      expect(await harness.db.settings.getSetting('autoEnrichmentIntervalMinutes')).toBeNull();
    },
  );

  it('saves an hourly-or-slower cron', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings').send({
      autoEnrichmentScheduleType: 'cron',
      autoEnrichmentCron: '0 */6 * * *',
    });
    expect(res.status).toBe(200);
  });

  it.each([['* * * * *'], ['*/30 * * * *'], ['not a cron']])(
    'refuses cron "%s"',
    async (cron) => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/settings').send({
        autoEnrichmentScheduleType: 'cron',
        autoEnrichmentCron: cron,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_AUTO_ENRICHMENT_CRON');
    },
  );

  it('lets a user switch to interval mode without first fixing a bad cron', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings').send({
      autoEnrichmentScheduleType: 'interval',
      autoEnrichmentCron: '* * * * *',
      autoEnrichmentIntervalMinutes: '120',
    });
    expect(res.status).toBe(200);
  });

  it('refuses an unknown schedule type', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings').send({ autoEnrichmentScheduleType: 'hourly' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AUTO_ENRICHMENT_SCHEDULE_TYPE');
  });

  it('reports status in the response envelope', async () => {
    getStatus.mockResolvedValue({ enabled: true, pendingPushes: 3 });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/settings/auto-enrichment/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { enabled: true, pendingPushes: 3 } });
  });

  it('runs on demand as a manual run', async () => {
    runNow.mockResolvedValue({ nodesFilled: 2, fieldsCopied: 4, pushesPending: 0 });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings/auto-enrichment/run-now');

    expect(res.status).toBe(200);
    expect(runNow).toHaveBeenCalledWith('manual');
    expect(res.body.data.nodesFilled).toBe(2);
  });

  it('answers 409 while a run is already in progress', async () => {
    runNow.mockRejectedValue(new AutoEnrichmentInProgressError());
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings/auto-enrichment/run-now');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AUTO_ENRICHMENT_IN_PROGRESS');
  });

  it('answers 500, not 409, for any other failure', async () => {
    // The 409 is keyed on the error class, so an unrelated message that merely
    // mentions "in progress" cannot be mistaken for an overlapping run.
    runNow.mockRejectedValue(new Error('database write in progress failed'));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings/auto-enrichment/run-now');

    expect(res.status).toBe(500);
  });

  it('does not let a user without settings:write trigger a run', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/settings/auto-enrichment/run-now');

    expect(res.status).toBe(403);
    expect(runNow).not.toHaveBeenCalled();
  });
});
