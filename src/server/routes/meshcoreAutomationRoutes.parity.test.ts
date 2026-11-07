/**
 * MeshCore Automation parity routes (#6224) — Auto Delete by Distance,
 * Time Sync overview, Remote Telemetry overview. Real session + real
 * permission checks via the route harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import automationRoutes from './meshcoreAutomationRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { autoDeleteByDistanceService } from '../services/autoDeleteByDistanceService.js';

const base = (sourceId: string) => `/api/sources/${sourceId}/meshcore/automation`;

describe('meshcoreAutomationRoutes — automation parity (#6224)', () => {
  let harness: RouteTestHarness;
  const manager = {
    restartDistanceDeleteScheduler: vi.fn(async () => {}),
    isDistanceDeleteRunning: vi.fn(() => false),
  };

  beforeEach(async () => {
    manager.restartDistanceDeleteScheduler.mockClear();
    manager.isDistanceDeleteRunning.mockReturnValue(false);
    harness = await createRouteTestApp({
      mount: (app) => app.use(
        '/api/sources/:id/meshcore',
        (_req, res, next) => { res.locals.meshcoreManager = manager; next(); },
        automationRoutes,
      ),
    });
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await databaseService.settings.deleteSourceSettings(harness.sourceA);
    await databaseService.settings.deleteSourceSettings(harness.sourceB);
    await harness.cleanup();
  });

  // ---- Auto Delete by Distance ----

  it('reads auto-delete-distance defaults with the scheduler-running flag', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`${base(harness.sourceA)}/auto-delete-distance`);
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toEqual({
      enabled: false, intervalHours: 24, thresholdKm: 100, lat: null, lon: null, action: 'delete',
    });
    expect(res.body.data.running).toBe(false);
  });

  it('saves auto-delete-distance per source and re-arms the scheduler', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`${base(harness.sourceA)}/auto-delete-distance`).send({
      enabled: true, intervalHours: 12, thresholdKm: 50, lat: 30, lon: -97, action: 'ignore',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toEqual({
      enabled: true, intervalHours: 12, thresholdKm: 50, lat: 30, lon: -97, action: 'ignore',
    });
    expect(manager.restartDistanceDeleteScheduler).toHaveBeenCalledTimes(1);
    expect(await databaseService.settings.getSettingForSource(harness.sourceA, 'autoDeleteByDistanceEnabled')).toBe('true');
    // Source B untouched.
    expect(await databaseService.settings.getSettingForSource(harness.sourceB, 'autoDeleteByDistanceEnabled')).not.toBe('true');
  });

  it('clears the home coordinate when lat/lon are blank', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post(`${base(harness.sourceA)}/auto-delete-distance`).send({ lat: 10, lon: 20 });
    const res = await agent.post(`${base(harness.sourceA)}/auto-delete-distance`).send({ lat: null, lon: '' });
    expect(res.status).toBe(200);
    expect(res.body.data.settings.lat).toBeNull();
    expect(res.body.data.settings.lon).toBeNull();
  });

  it.each([
    ['interval under 6h', { intervalHours: 5 }, 'INVALID_INTERVAL'],
    ['threshold 0', { thresholdKm: 0 }, 'INVALID_THRESHOLD'],
    ['lat out of range', { lat: 120 }, 'INVALID_LAT'],
    ['bad action', { action: 'nuke' }, 'INVALID_ACTION'],
  ])('rejects %s and does not re-arm', async (_l, body, code) => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`${base(harness.sourceA)}/auto-delete-distance`).send({ enabled: true, ...body });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(manager.restartDistanceDeleteScheduler).not.toHaveBeenCalled();
  });

  it('runs the delete cycle now, scoped to the source', async () => {
    const spy = vi.spyOn(autoDeleteByDistanceService, 'runNow').mockResolvedValue({ deletedCount: 3 });
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`${base(harness.sourceA)}/auto-delete-distance/run`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.deletedCount).toBe(3);
    expect(spy).toHaveBeenCalledWith(harness.sourceA);
  });

  it('refuses an auto-delete-distance save without a grant for the source', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`${base(harness.sourceB)}/auto-delete-distance`).send({ enabled: true });
    expect(res.status).toBe(403);
  });

  // ---- Time Sync overview ----

  it('lists time-sync-enabled nodes', async () => {
    vi.spyOn(databaseService.meshcore, 'getTimeSyncEnabledNodes').mockResolvedValue([
      { publicKey: 'ab'.repeat(32), name: 'Repeater One', timeSyncIntervalMinutes: 720, lastTimeSyncAt: 1000 },
    ] as any);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`${base(harness.sourceA)}/time-sync`);
    expect(res.status).toBe(200);
    expect(res.body.data.nodes).toEqual([
      { publicKey: 'ab'.repeat(32), name: 'Repeater One', intervalMinutes: 720, lastSyncAt: 1000 },
    ]);
  });

  // ---- Remote Telemetry overview ----

  it('lists remote-telemetry-enabled nodes', async () => {
    vi.spyOn(databaseService.meshcore, 'getTelemetryEnabledNodes').mockResolvedValue([
      { publicKey: 'cd'.repeat(32), name: null, telemetryIntervalMinutes: 60, lastTelemetryRequestAt: 2000, lastTelemetrySuccessAt: 2500 },
    ] as any);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`${base(harness.sourceA)}/remote-telemetry`);
    expect(res.status).toBe(200);
    expect(res.body.data.nodes).toEqual([
      { publicKey: 'cd'.repeat(32), name: null, intervalMinutes: 60, lastRequestAt: 2000, lastSuccessAt: 2500 },
    ]);
  });

  it('refuses the overviews without a read grant for the source', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(`${base(harness.sourceB)}/time-sync`)).status).toBe(403);
    expect((await agent.get(`${base(harness.sourceB)}/remote-telemetry`)).status).toBe(403);
  });
});
