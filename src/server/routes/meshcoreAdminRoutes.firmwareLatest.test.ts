/**
 * GET /admin/firmware/latest (#4943 Phase 2): newest MeshCore release for a
 * repeater / room-server role on the source's own channel, for the remote-
 * admin Firmware update section. Real harness; release cache stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The MeshCore route guard needs a MeshCore manager for the source; no radio.
vi.mock('../sourceManagerRegistry.js', () => {
  const stub = (sourceId: string) => ({ sourceId, sourceType: 'meshcore' as const, isReceiveOnly: () => false, canTransmit: () => true });
  const managers = new Map([
    ['rt-source-a', stub('rt-source-a')],
    ['rt-source-b', stub('rt-source-b')],
  ]);
  return {
    sourceManagerRegistry: {
      getManager: (id: string) => managers.get(id),
      getAllManagers: () => Array.from(managers.values()),
    },
  };
});

import meshcoreRoutes from './meshcoreRoutes.js';
import { meshcoreFirmwareReleases, parseMeshCoreRelease } from '../services/meshcoreFirmwareReleases.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('GET /admin/firmware/latest (#4943)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes) });
    await harness.db.settings.deleteSourceSettings(harness.sourceA);
    vi.spyOn(meshcoreFirmwareReleases, 'getCached').mockReturnValue(
      ['repeater-v1.17.1', 'repeater-v1.18.0', 'repeater-v1.19.0', 'room-server-v1.18.0'].map(
        (tag) => parseMeshCoreRelease({ tag_name: tag, prerelease: tag.endsWith('1.19.0'), html_url: `https://mc/${tag}` })!,
      ),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.db.settings.deleteSourceSettings(harness.sourceA);
    await harness.cleanup();
  });

  const url = (role: string) => `/sources/${harness.sourceA}/meshcore/admin/firmware/latest?role=${role}`;

  it('returns the newest stable release for the role, with no timestamp fields', async () => {
    const res = await (await harness.loginAs(harness.admin)).get(url('repeater'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        role: 'repeater',
        channel: 'stable',
        latest: { version: '1.18.0', tagName: 'repeater-v1.18.0', htmlUrl: 'https://mc/repeater-v1.18.0' },
      },
    });
  });

  it('follows the source\'s own alpha channel', async () => {
    await harness.db.settings.setSourceSetting(harness.sourceA, 'firmwareChannel', 'alpha');
    const res = await (await harness.loginAs(harness.admin)).get(url('repeater'));
    expect(res.body.data).toMatchObject({ channel: 'alpha', latest: { version: '1.19.0' } });
  });

  it('returns latest: null when the cache has nothing for the role', async () => {
    vi.spyOn(meshcoreFirmwareReleases, 'getCached').mockReturnValue([]);
    const res = await (await harness.loginAs(harness.admin)).get(url('room-server'));
    expect(res.status).toBe(200);
    expect(res.body.data.latest).toBeNull();
  });

  it('refuses an unknown role', async () => {
    const res = await (await harness.loginAs(harness.admin)).get(url('companion'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ROLE');
  });

  it('needs remote_admin:read on THIS source', async () => {
    await harness.grant(harness.limited.id, 'remote_admin', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url('repeater'))).status).toBe(403);
    await harness.grant(harness.limited.id, 'remote_admin', 'read', harness.sourceA);
    expect((await agent.get(url('repeater'))).status).toBe(200);
  });
});
