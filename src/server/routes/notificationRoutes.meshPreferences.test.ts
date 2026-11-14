/**
 * Mesh-wide notification default routes (#5729): GET/POST
 * /push/preferences/mesh and DELETE /push/preferences/override.
 *
 * Real session + auth + requirePermission chain and real repository (harness
 * DB). The limited user reads Source A only, so these assert the two-source
 * rule: the replies never name Source B, and B cannot be put in the push list
 * or have its override touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { pushRouter } from './notificationRoutes.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));
vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { getLocalNodeInfo: vi.fn().mockReturnValue(null) },
}));

describe('mesh-wide notification preferences routes (#5729)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/push', pushRouter) });
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('GET lists only the sources the caller can read, and only their overrides', async () => {
    // Rows the user may have from an older grant: one per source.
    await harness.db.notifications.saveUserPreferences(harness.limited.id, (await import('../../utils/notificationDefaults.js')).defaultNotificationPreferences(), harness.sourceA);
    await harness.db.notifications.saveUserPreferences(harness.limited.id, (await import('../../utils/notificationDefaults.js')).defaultNotificationPreferences(), harness.sourceB);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get('/push/preferences/mesh').expect(200);

    expect(res.body.sources).toEqual([{ id: harness.sourceA, name: 'Source A' }]);
    expect(res.body.overrides).toEqual([harness.sourceA]);
    expect(res.body.usingDefaults).toBe(true);
    expect(res.body.pushSourceIds).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(harness.sourceB);
    expect(JSON.stringify(res.body)).not.toContain('Source B');
  });

  it('GET and POST need messages:read on at least one source', async () => {
    await harness.revokeAll(harness.limited.id);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get('/push/preferences/mesh')).status).toBe(403);
    expect((await agent.post('/push/preferences/mesh').send({ notifyOnNewNode: true })).status).toBe(403);
  });

  it('POST saves the mesh-wide default; a source with no row then reports it', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences/mesh').send({ notifyOnNewNode: true, enableDirectMessages: false }).expect(200);

    const mesh = await agent.get('/push/preferences/mesh').expect(200);
    expect(mesh.body).toMatchObject({ notifyOnNewNode: true, enableDirectMessages: false, usingDefaults: false });

    const onA = await agent.get(`/push/preferences?sourceId=${harness.sourceA}`).expect(200);
    expect(onA.body).toMatchObject({ notifyOnNewNode: true, enableDirectMessages: false, usingMeshDefault: true, isOverride: false });
  });

  it('POST rejects channel settings: channel numbers are per source', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/push/preferences/mesh').send({ enabledChannels: [0, 1] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SOURCE_ONLY_FIELD');
  });

  it('POST validates like the per-source route', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/push/preferences/mesh').send({ lowBatteryThreshold: 500 });
    expect(res.status).toBe(400);
  });

  it('the push source list takes readable sources only, and never confirms another exists', async () => {
    const agent = await harness.loginAs(harness.limited);

    const bad = await agent.post('/push/preferences/mesh').send({ pushSourceIds: [harness.sourceB] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_PUSH_SOURCES');
    const unknown = await agent.post('/push/preferences/mesh').send({ pushSourceIds: ['no-such-source'] });
    expect(unknown.body).toEqual(bad.body);

    await agent.post('/push/preferences/mesh').send({ pushSourceIds: [harness.sourceA] }).expect(200);
    expect((await agent.get('/push/preferences/mesh')).body.pushSourceIds).toEqual([harness.sourceA]);

    await agent.post('/push/preferences/mesh').send({ pushSourceIds: null }).expect(200);
    expect((await agent.get('/push/preferences/mesh')).body.pushSourceIds).toBeNull();
  });

  it('a stored id the caller can no longer read is not shown', async () => {
    await harness.db.notifications.setPushSourceIds(harness.limited.id, [harness.sourceA, harness.sourceB]);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/push/preferences/mesh').expect(200);
    expect(res.body.pushSourceIds).toEqual([harness.sourceA]);
  });

  it('DELETE /preferences/override drops the row on a readable source only', async () => {
    const defaults = (await import('../../utils/notificationDefaults.js')).defaultNotificationPreferences();
    await harness.db.notifications.saveUserPreferences(harness.limited.id, defaults, harness.sourceA);
    await harness.db.notifications.saveUserPreferences(harness.limited.id, defaults, harness.sourceB);
    const agent = await harness.loginAs(harness.limited);

    expect((await agent.delete(`/push/preferences/override?sourceId=${harness.sourceB}`)).status).toBe(403);
    expect(await harness.db.notifications.getUserPreferences(harness.limited.id, harness.sourceB)).not.toBeNull();

    const res = await agent.delete(`/push/preferences/override?sourceId=${harness.sourceA}`).expect(200);
    expect(res.body).toEqual({ success: true, removed: true });
    expect(await harness.db.notifications.getUserPreferences(harness.limited.id, harness.sourceA)).toBeNull();
  });

  it('the per-source route will not write the mesh-wide row', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', '__mesh__');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/push/preferences').send({ sourceId: '__mesh__', enabledChannels: [1] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOURCE_ID');
  });

  it('one user\'s mesh-wide default is never another user\'s answer', async () => {
    const limited = await harness.loginAs(harness.limited);
    await limited.post('/push/preferences/mesh').send({ notifyOnNewNode: true }).expect(200);
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.get('/push/preferences/mesh').expect(200);
    expect(res.body.usingDefaults).toBe(true);
    expect(res.body.notifyOnNewNode).toBe(false);
  });
});
