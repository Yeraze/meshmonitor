/**
 * POST /api/settings — aircraft age-out keys (#5364/#5365 Phase 2).
 * Validation of the three POST-able keys, the server-written status keys
 * being non-postable, and a save never triggering a sweep.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { reclassifySourceSpy, runSweepSpy } = vi.hoisted(() => ({
  reclassifySourceSpy: vi.fn(async () => 0),
  runSweepSpy: vi.fn(async () => undefined),
}));
vi.mock('../services/aircraftClassificationService.js', () => ({
  aircraftClassificationService: { reclassifySource: reclassifySourceSpy, schedule: vi.fn() },
  AIRCRAFT_EXCLUDED_SOURCE_TYPES: new Set(['meshcore', 'meshcore_mqtt', 'reticulum']),
}));
vi.mock('../services/aircraftAgeOutService.js', () => ({
  aircraftAgeOutService: { runSweep: runSweepSpy, onLivePosition: vi.fn() },
  LAST_RUN_AT_KEY: 'aircraftAgeOutLastRunAt',
  LAST_RESULT_KEY: 'aircraftAgeOutLastResult',
}));

import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('POST /api/settings — aircraft age-out (#5364/#5365 Phase 2)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
    reclassifySourceSpy.mockClear();
    runSweepSpy.mockClear();
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('accepts valid keys, stores them for this source only, and never runs a sweep', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ aircraftAgeOutEnabled: 'true', aircraftAgeOutHours: '48', aircraftAgeOutAction: 'delete' });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAgeOutEnabled')).toBe('true');
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAgeOutHours')).toBe('48');
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAgeOutAction')).toBe('delete');
    expect(await harness.db.settings.getSettingForSource(harness.sourceB, 'aircraftAgeOutEnabled')).toBeNull();
    // A settings save is not a run (spec "Timers").
    expect(runSweepSpy).not.toHaveBeenCalled();
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAgeOutLastRunAt')).toBeNull();
    // Age-out keys alone do not trigger the P1 reclassify either.
    expect(reclassifySourceSpy).not.toHaveBeenCalled();
  });

  it.each([['5'], ['169'], ['12.5'], ['abc'], ['']])(
    'rejects aircraftAgeOutHours=%j with 400 INVALID_AIRCRAFT_AGE_OUT_HOURS and writes nothing',
    async (hours) => {
      const agent = await harness.loginAs(harness.admin);
      await harness.db.settings.setSourceSettings(harness.sourceA, { aircraftAgeOutHours: '24' });
      const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ aircraftAgeOutHours: hours });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_AIRCRAFT_AGE_OUT_HOURS');
      expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAgeOutHours')).toBe('24');
    },
  );

  it('accepts the range edges 6 and 168', async () => {
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ aircraftAgeOutHours: '6' })).status).toBe(200);
    expect((await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ aircraftAgeOutHours: '168' })).status).toBe(200);
  });

  it('rejects an unknown action with 400 INVALID_AIRCRAFT_AGE_OUT_ACTION', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ aircraftAgeOutAction: 'purge' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AIRCRAFT_AGE_OUT_ACTION');
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAgeOutAction')).toBeNull();
  });

  it('rejects a non-boolean aircraftAgeOutEnabled with 400 INVALID_BOOLEAN_SETTING', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ aircraftAgeOutEnabled: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BOOLEAN_SETTING');
  });

  it('does not let a client write the server-owned last-run keys', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ aircraftAgeOutLastRunAt: '1', aircraftAgeOutLastResult: '{"agedOut":99}' });
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAgeOutLastRunAt')).toBeNull();
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAgeOutLastResult')).toBeNull();
  });
});
