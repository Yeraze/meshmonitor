/**
 * Route test — `reactionsOutboundEnabled` on GET /status and GET /snapshot (#5762).
 * The value is resolved per source from the stored setting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { MESHCORE_REACTIONS_OUTBOUND_DEFAULT } from '../../utils/meshcoreReactionTarget.js';

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    getConnectionStatus: () => ({ connected: true, deviceType: 1, config: null }),
    getLocalNode: () => null,
    getContacts: () => [],
    getContactsForView: async () => [],
    getAllNodes: async () => [],
    getRecentMessages: () => [],
  });
  const managers = new Map([
    ['rt-source-a', stubFor('rt-source-a')],
    ['rt-source-b', stubFor('rt-source-b')],
  ]);
  return {
    sourceManagerRegistry: {
      getManager: (sourceId: string) => managers.get(sourceId),
      getAllManagers: () => Array.from(managers.values()),
    },
  };
});

describe('meshcoreDeviceRoutes — reactionsOutboundEnabled (#5762)', () => {
  let harness: RouteTestHarness;
  const KEY = 'meshcoreReactionsOutboundEnabled';

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('reports the default when the setting is unset', async () => {
    const agent = await harness.loginAs(harness.admin);
    const st = await agent.get(`/sources/${harness.sourceA}/meshcore/status`);
    expect(st.status).toBe(200);
    expect(st.body.data.reactionsOutboundEnabled).toBe(MESHCORE_REACTIONS_OUTBOUND_DEFAULT);
    const snap = await agent.get(`/sources/${harness.sourceA}/meshcore/snapshot`);
    expect(snap.body.data.status.reactionsOutboundEnabled).toBe(MESHCORE_REACTIONS_OUTBOUND_DEFAULT);
  });

  it('follows the per-source setting, not other sources', async () => {
    await harness.db.settings.setSourceSetting(harness.sourceA, KEY, 'false');
    await harness.db.settings.setSourceSetting(harness.sourceB, KEY, 'true');
    const agent = await harness.loginAs(harness.admin);
    for (const path of ['status', 'snapshot']) {
      const a = await agent.get(`/sources/${harness.sourceA}/meshcore/${path}`);
      const b = await agent.get(`/sources/${harness.sourceB}/meshcore/${path}`);
      const pick = (r: { body: { data: { status?: { reactionsOutboundEnabled: boolean }; reactionsOutboundEnabled?: boolean } } }) =>
        path === 'status' ? r.body.data.reactionsOutboundEnabled : r.body.data.status?.reactionsOutboundEnabled;
      expect(pick(a)).toBe(false);
      expect(pick(b)).toBe(true);
    }
  });
});
