/**
 * MeshCore Auto Announce "split long messages" setting (#6316).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import automationRoutes from './meshcoreAutomationRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

const KEY = 'meshcoreAutoAnnounceSplitLongMessages';
const url = (id: string) => `/api/sources/${id}/meshcore/automation/announce`;

describe('meshcoreAutomationRoutes announce splitLongMessages (#6316)', () => {
  let harness: RouteTestHarness;
  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) =>
        app.use(
          '/api/sources/:id/meshcore',
          (_req, res, next) => { res.locals.meshcoreManager = { startAutoAnnounce: async () => {} }; next(); },
          automationRoutes,
        ),
    });
  });
  afterEach(async () => {
    await databaseService.settings.deleteSourceSettings(harness.sourceA);
    await databaseService.settings.deleteSourceSettings(harness.sourceB);
    await harness.cleanup();
  });
  const grantRW = (sourceId: string) =>
    databaseService.auth.createPermission({
      userId: harness.limited.id, resource: 'automation', canRead: true, canWrite: true,
      canViewOnMap: false, sourceId, grantedAt: Date.now(), grantedBy: null,
    });

  it('defaults off, saves per source, only boolean true enables', async () => {
    await grantRW(harness.sourceA);
    await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).body.data.splitLongMessages).toBe(false);
    expect((await agent.post(url(harness.sourceA)).send({ splitLongMessages: 'true' })).status).toBe(200);
    expect((await agent.get(url(harness.sourceA))).body.data.splitLongMessages).toBe(false);
    await agent.post(url(harness.sourceA)).send({ splitLongMessages: true });
    expect((await agent.get(url(harness.sourceA))).body.data.splitLongMessages).toBe(true);
    expect(await databaseService.settings.getSettingForSource(harness.sourceA, KEY)).toBe('true');
    expect((await agent.get(url(harness.sourceB))).body.data.splitLongMessages).toBe(false);
  });

  it('read-only users cannot change it', async () => {
    await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(url(harness.sourceA)).send({ splitLongMessages: true })).status).toBe(403);
  });
});
