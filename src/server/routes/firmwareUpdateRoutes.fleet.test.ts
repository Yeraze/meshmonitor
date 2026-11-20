/**
 * GET /api/firmware/fleet (#4943): one row per Meshtastic TCP / MeshCore
 * source's own radio, compared with the newest release on that source's own
 * channel. Real harness and settings; the registry holds fake managers (no
 * radio in tests) and the release caches are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreDeviceType } from '../meshcoreManager.js';

const { managers } = vi.hoisted(() => ({ managers: new Map<string, any>() }));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => managers.get(id),
    getAllManagers: () => Array.from(managers.values()),
  },
}));

import firmwareUpdateRoutes from './firmwareUpdateRoutes.js';
import { firmwareUpdateService } from '../services/firmwareUpdateService.js';
import { meshcoreFirmwareReleases, parseMeshCoreRelease } from '../services/meshcoreFirmwareReleases.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const MC = 'rt-fw-meshcore';
const MQTT = 'rt-fw-fleet-mqtt';

describe('GET /api/firmware/fleet (#4943)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/firmware', firmwareUpdateRoutes) });
    for (const id of [MC, MQTT]) await harness.db.sources.deleteSource(id).catch(() => {});
    await harness.db.sources.createSource({ id: MC, name: 'MC radio', type: 'meshcore', config: {}, enabled: true });
    await harness.db.sources.createSource({ id: MQTT, name: 'Broker', type: 'mqtt_broker', config: {}, enabled: true });
    await harness.db.settings.deleteSetting('firmwareChannel');
    for (const id of [harness.sourceA, harness.sourceB, MC]) await harness.db.settings.deleteSourceSettings(id);

    managers.clear();
    managers.set(harness.sourceA, {
      sourceType: 'meshtastic_tcp',
      getStatus: () => ({ connected: true }),
      getLocalNodeInfo: () => ({ longName: 'Base A', firmwareVersion: '2.7.15.abc', hwModel: 43 }),
      isLocalNodeBridged: () => false,
    });
    // sourceB has no manager: disabled / not started.
    managers.set(MC, {
      sourceType: 'meshcore',
      getStatus: () => ({ connected: true }),
      getLocalNode: () => ({ name: 'MC companion', ver: 'v1.17.1-d929643', model: 'Heltec V3' }),
      getDeviceType: () => MeshCoreDeviceType.COMPANION,
    });

    vi.spyOn(firmwareUpdateService, 'getCachedReleasesForChannel').mockImplementation((channel) =>
      channel === 'stable'
        ? [{ tagName: 'v2.7.18', version: '2.7.18', prerelease: false, publishedAt: '', htmlUrl: 'https://mt/2.7.18', assets: [] }]
        : [{ tagName: 'v2.8.0', version: '2.8.0', prerelease: true, publishedAt: '', htmlUrl: 'https://mt/2.8.0', assets: [] }],
    );
    vi.spyOn(meshcoreFirmwareReleases, 'getCached').mockReturnValue(
      ['companion-v1.17.1', 'companion-v1.18.0', 'companion-v1.19.0'].map(
        (tag, i) => parseMeshCoreRelease({ tag_name: tag, prerelease: i === 2, html_url: `https://mc/${tag}` })!,
      ),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of [MC, MQTT]) await harness.db.sources.deleteSource(id).catch(() => {});
    await harness.db.settings.deleteSourceSettings(MC);
    await harness.cleanup();
  });

  const fleet = async () => {
    const res = await (await harness.loginAs(harness.admin)).get('/api/firmware/fleet');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    return res.body.data.rows as Array<Record<string, any>>;
  };

  it('lists radio sources only and compares each against its own channel', async () => {
    const rows = await fleet();
    expect(rows.map((r) => r.sourceId)).not.toContain(MQTT);

    const a = rows.find((r) => r.sourceId === harness.sourceA)!;
    expect(a).toMatchObject({
      protocol: 'meshtastic', device: 'Base A', installed: '2.7.15.abc', latest: '2.7.18',
      channel: 'stable', status: 'update_available', method: 'ota',
    });

    const mc = rows.find((r) => r.sourceId === MC)!;
    expect(mc).toMatchObject({
      protocol: 'meshcore', role: 'companion', hardware: 'Heltec V3', installed: 'v1.17.1-d929643',
      latest: '1.18.0', status: 'update_available', method: 'manual',
    });
  });

  it('a source with no running manager is unknown, never up to date', async () => {
    const b = (await fleet()).find((r) => r.sourceId === harness.sourceB)!;
    expect(b).toMatchObject({ connected: false, installed: null, status: 'unknown', reason: 'disconnected' });
  });

  it('uses each source\'s own channel: alpha on the MeshCore source counts prereleases', async () => {
    const res = await (await harness.loginAs(harness.admin))
      .post('/api/firmware/channel')
      .send({ channel: 'alpha', sourceId: MC });
    expect(res.status).toBe(200);
    const rows = await fleet();
    expect(rows.find((r) => r.sourceId === MC)).toMatchObject({ channel: 'alpha', latest: '1.19.0' });
    expect(rows.find((r) => r.sourceId === harness.sourceA)).toMatchObject({ channel: 'stable', latest: '2.7.18' });
  });

  it('an inherited nightly channel means stable for MeshCore', async () => {
    await harness.db.settings.setSetting('firmwareChannel', 'nightly');
    const mc = (await fleet()).find((r) => r.sourceId === MC)!;
    expect(mc).toMatchObject({ channel: 'stable', latest: '1.18.0' });
    await harness.db.settings.deleteSetting('firmwareChannel');
  });

  it('refuses nightly/custom/local for a MeshCore source', async () => {
    const res = await (await harness.loginAs(harness.admin))
      .post('/api/firmware/channel')
      .send({ channel: 'nightly', sourceId: MC });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CHANNEL');
  });

  it('is admin only', async () => {
    const res = await (await harness.loginAs(harness.limited)).get('/api/firmware/fleet');
    expect(res.status).toBe(403);
  });
});
