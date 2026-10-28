/**
 * /api/settings — default Meshtastic source (#5245): admin-only write, value
 * validated, applied to the registry live, hidden from non-admins, and the
 * status route reports what a source-less request resolves to.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { getPrimaryMeshtasticManager } from '../sourceManagerTypes.js';

const KEY = 'defaultMeshtasticSourceId';

function tcp(id: string): ISourceManager {
  return {
    sourceId: id,
    sourceType: 'meshtastic_tcp',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(() => ({ sourceId: id, sourceName: id, sourceType: 'meshtastic_tcp' as const, connected: false })),
    getLocalNodeInfo: vi.fn().mockReturnValue(null),
    startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
    stopDistanceDeleteScheduler: vi.fn(),
  };
}

describe('/api/settings — defaultMeshtasticSourceId (#5245)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
    await sourceManagerRegistry.addManager(tcp(harness.sourceA));
    sourceManagerRegistry.setPrimaryMeshtasticSource(harness.sourceA);
    await sourceManagerRegistry.addManager(tcp(harness.sourceB));
  });

  afterEach(async () => {
    sourceManagerRegistry.setPreferredMeshtasticSource(null);
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await sourceManagerRegistry.removeManager(harness.sourceB);
    await harness.db.settings.deleteSetting(KEY).catch(() => {});
    await harness.db.sources.deleteSource('rt-mqtt').catch(() => {});
    await harness.cleanup();
  });

  it('an admin save switches the primary at once; clearing returns to automatic', async () => {
    const admin = await harness.loginAs(harness.admin);
    expect(getPrimaryMeshtasticManager(sourceManagerRegistry)?.sourceId).toBe(harness.sourceA);

    expect((await admin.post('/api/settings').send({ [KEY]: harness.sourceB })).status).toBe(200);
    expect(await harness.db.settings.getSetting(KEY)).toBe(harness.sourceB);
    expect(getPrimaryMeshtasticManager(sourceManagerRegistry)?.sourceId).toBe(harness.sourceB);
    expect((await admin.get('/api/settings')).body[KEY]).toBe(harness.sourceB);

    expect((await admin.post('/api/settings').send({ [KEY]: '' })).status).toBe(200);
    expect(getPrimaryMeshtasticManager(sourceManagerRegistry)?.sourceId).toBe(harness.sourceA);
  });

  it('rejects an unknown or non-Meshtastic-TCP source', async () => {
    const admin = await harness.loginAs(harness.admin);
    let res = await admin.post('/api/settings').send({ [KEY]: 'no-such-source' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DEFAULT_MESHTASTIC_SOURCE');

    await harness.db.sources.createSource({
      id: 'rt-mqtt', name: 'Broker', type: 'mqtt_broker', config: {}, enabled: true,
    });
    res = await admin.post('/api/settings').send({ [KEY]: 'rt-mqtt' });
    expect(res.status).toBe(400);
    expect(await harness.db.settings.getSetting(KEY)).toBeNull();
    expect(sourceManagerRegistry.getPreferredMeshtasticSourceId()).toBeNull();
  });

  it('a stored choice whose source is gone does not block later saves', async () => {
    await harness.db.settings.setSetting(KEY, 'deleted-source');
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post('/api/settings').send({ [KEY]: 'deleted-source', externalUrl: '' });
    expect(res.status).toBe(200);
    expect(getPrimaryMeshtasticManager(sourceManagerRegistry)?.sourceId).toBe(harness.sourceA);
  });

  it('a non-admin settings writer cannot change it, and cannot see it', async () => {
    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
    const user = await harness.loginAs(harness.limited);

    expect((await user.post('/api/settings').send({ [KEY]: harness.sourceB })).status).toBe(200);
    expect(await harness.db.settings.getSetting(KEY)).toBeNull();
    expect(getPrimaryMeshtasticManager(sourceManagerRegistry)?.sourceId).toBe(harness.sourceA);

    await harness.db.settings.setSetting(KEY, harness.sourceB);
    expect((await user.get('/api/settings')).body[KEY]).toBeUndefined();
    const anon = await harness.loginAs(null);
    expect((await anon.get('/api/settings')).body[KEY]).toBeUndefined();
  });

  it('is dropped from a per-source save', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post(`/api/settings?sourceId=${harness.sourceA}`).send({ [KEY]: harness.sourceB });
    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSetting(KEY)).toBeNull();
  });

  it('status route: automatic, configured, then fallback when the chosen source stops', async () => {
    const admin = await harness.loginAs(harness.admin);
    let body = (await admin.get('/api/settings/default-meshtastic-source')).body;
    expect(body.data).toMatchObject({ mode: 'automatic', configuredSourceId: null, effectiveSourceId: harness.sourceA, effectiveSourceName: 'Source A' });

    await admin.post('/api/settings').send({ [KEY]: harness.sourceB });
    body = (await admin.get('/api/settings/default-meshtastic-source')).body;
    expect(body.data).toMatchObject({ mode: 'configured', configuredSourceId: harness.sourceB, effectiveSourceId: harness.sourceB });

    await sourceManagerRegistry.removeManager(harness.sourceB); // disabled
    body = (await admin.get('/api/settings/default-meshtastic-source')).body;
    expect(body.data).toMatchObject({ mode: 'fallback', configuredSourceId: harness.sourceB, effectiveSourceId: harness.sourceA });
  });

  it('status route is admin only', async () => {
    await harness.grant(harness.limited.id, 'settings', 'read', harness.sourceA);
    const user = await harness.loginAs(harness.limited);
    expect((await user.get('/api/settings/default-meshtastic-source')).status).toBe(403);
  });

  it('a settings reset returns to automatic', async () => {
    const admin = await harness.loginAs(harness.admin);
    await admin.post('/api/settings').send({ [KEY]: harness.sourceB });
    expect(getPrimaryMeshtasticManager(sourceManagerRegistry)?.sourceId).toBe(harness.sourceB);
    expect((await admin.delete('/api/settings')).status).toBe(200);
    expect(getPrimaryMeshtasticManager(sourceManagerRegistry)?.sourceId).toBe(harness.sourceA);
  });
});
