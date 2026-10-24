/**
 * MeshCore Auto Ping settings routes (#5953) — real session + real permission
 * checks via the route harness. Same keys and ranges as the Meshtastic
 * `/api/settings/auto-ping` route; a save writes settings only and never
 * touches a session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import automationRoutes from './meshcoreAutomationRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

const url = (sourceId: string) => `/api/sources/${sourceId}/meshcore/automation/auto-ping`;
const REQ_KEY = 'cd'.repeat(32);

describe('meshcoreAutomationRoutes — Auto Ping (#5953)', () => {
  let harness: RouteTestHarness;
  const manager = {
    getAutoPingSessions: vi.fn(() => [] as unknown[]),
    stopAutoPingSession: vi.fn(() => true),
  };

  beforeEach(async () => {
    manager.getAutoPingSessions.mockReset().mockReturnValue([]);
    manager.stopAutoPingSession.mockReset().mockReturnValue(true);
    harness = await createRouteTestApp({
      // The router-level guard (not mounted here) puts the source's manager in res.locals.
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
    await databaseService.settings.deleteSourceSettings(harness.sourceA);
    await databaseService.settings.deleteSourceSettings(harness.sourceB);
    await harness.cleanup();
  });

  it('reads the defaults: off, 30 s, 20 pings, 60 s', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        settings: { autoPingEnabled: false, autoPingIntervalSeconds: 30, autoPingMaxPings: 20, autoPingTimeoutSeconds: 60 },
        sessions: [],
      },
    });
  });

  it('saves per source and reads it back, without touching sessions', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({
      autoPingEnabled: true, autoPingIntervalSeconds: 15, autoPingMaxPings: 50, autoPingTimeoutSeconds: 45,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toEqual({
      autoPingEnabled: true, autoPingIntervalSeconds: 15, autoPingMaxPings: 50, autoPingTimeoutSeconds: 45,
    });
    expect(await databaseService.settings.getSettingForSource(harness.sourceA, 'autoPingEnabled')).toBe('true');
    // Source B is untouched.
    expect(await databaseService.settings.getSettingForSource(harness.sourceB, 'autoPingMaxPings')).not.toBe('50');
    expect(manager.stopAutoPingSession).not.toHaveBeenCalled();
  });

  it.each([
    ['interval under 10 s', { autoPingIntervalSeconds: 9 }, 'INVALID_INTERVAL'],
    ['interval not a number', { autoPingIntervalSeconds: 'soon' }, 'INVALID_INTERVAL'],
    ['max pings 0', { autoPingMaxPings: 0 }, 'INVALID_MAX_PINGS'],
    ['max pings over 100', { autoPingMaxPings: 101 }, 'INVALID_MAX_PINGS'],
    ['timeout under 10 s', { autoPingTimeoutSeconds: 5 }, 'INVALID_TIMEOUT'],
  ])('rejects %s and writes nothing', async (_label, body, code) => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ autoPingEnabled: true, ...body });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    // Validated before any write: the enable flag in the same body was not saved.
    expect(await databaseService.settings.getSettingForSource(harness.sourceA, 'autoPingEnabled')).not.toBe('true');
  });

  it('accepts the edges of the ranges', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({
      autoPingIntervalSeconds: 10, autoPingMaxPings: 100, autoPingTimeoutSeconds: 10,
    });
    expect(res.status).toBe(200);
    const res1 = await agent.post(url(harness.sourceA)).send({ autoPingMaxPings: 1 });
    expect(res1.status).toBe(200);
  });

  it('refuses a save on a source the user has no grant for', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceB)).send({ autoPingEnabled: true });
    expect(res.status).toBe(403);
    expect(await databaseService.settings.getSettingForSource(harness.sourceB, 'autoPingEnabled')).not.toBe('true');
  });

  it('stops a session by public key', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`${url(harness.sourceA)}/stop`).send({ publicKey: REQ_KEY });
    expect(res.status).toBe(200);
    expect(manager.stopAutoPingSession).toHaveBeenCalledWith(REQ_KEY);

    manager.stopAutoPingSession.mockReturnValue(false);
    const missing = await agent.post(`${url(harness.sourceA)}/stop`).send({ publicKey: REQ_KEY });
    expect(missing.status).toBe(404);
    const bad = await agent.post(`${url(harness.sourceA)}/stop`).send({});
    expect(bad.status).toBe(400);
  });
});
