/**
 * Route tests — MeshCore contact location override (#5842).
 *
 * The override is MeshMonitor-only (`meshcore_nodes` columns, migration 206),
 * takes `nodes:write` on the source to edit (the Meshtastic override route's
 * permission), wins over the advert position on every read, survives an
 * advert update, and a private override is shown only with
 * `nodes_private:read` on the source.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const KEY = 'c'.repeat(64);
const UNKNOWN_KEY = 'd'.repeat(64);
const ADVERT = { latitude: 40.0, longitude: -105.0 };
const PINNED = { latitude: 28.5, longitude: -81.4, altitude: 30 };

// The live contact as the manager holds it: always the advert position.
const STUB_CONTACT = {
  publicKey: KEY,
  advName: 'Base Repeater',
  name: 'Base Repeater',
  ...ADVERT,
  advType: 2,
  lastSeen: 1000,
};

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    getConnectionStatus: () => ({ connected: false, deviceType: 2, config: null }),
    getLocalNode: () => null,
    getContact: (pk: string) => (pk === KEY ? STUB_CONTACT : undefined),
    getContacts: () => [STUB_CONTACT],
    getContactsForView: async () => [STUB_CONTACT],
    getAllNodes: async () => [{ publicKey: KEY, name: 'Base Repeater', advType: 2, ...ADVERT }],
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

describe('MeshCore location override routes (#5842)', () => {
  let harness: RouteTestHarness;
  const url = (src: string, key = KEY) => `/sources/${src}/meshcore/nodes/${key}/position-override`;

  const grantNodes = async (
    userId: number,
    sourceId: string,
    flags: { read?: boolean; write?: boolean; viewOnMap?: boolean },
  ) => {
    await harness.db.auth.createPermission({
      userId,
      resource: 'nodes',
      canRead: flags.read ?? false,
      canWrite: flags.write ?? false,
      canViewOnMap: flags.viewOnMap ?? false,
      sourceId,
      grantedAt: Date.now(),
      grantedBy: null,
    });
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
    await harness.db.meshcore.upsertNode({ publicKey: KEY, name: 'Base Repeater', advType: 2, ...ADVERT }, harness.sourceA);
    await harness.db.meshcore.upsertNode({ publicKey: KEY, name: 'Base Repeater', advType: 2, ...ADVERT }, harness.sourceB);
  });

  afterEach(async () => {
    await harness.db.meshcore.clearNodePositionOverride(harness.sourceA, KEY).catch(() => {});
    await harness.db.meshcore.clearNodePositionOverride(harness.sourceB, KEY).catch(() => {});
    await harness.cleanup();
  });

  describe('permission', () => {
    it('refuses a caller without nodes:write on the source', async () => {
      await grantNodes(harness.limited.id, harness.sourceA, { read: true, viewOnMap: true });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(url(harness.sourceA)).send({ enabled: true, ...PINNED });
      expect(res.status).toBe(403);
      expect((await harness.db.meshcore.getNodePositionOverride(harness.sourceA, KEY))?.enabled).toBe(false);
    });

    it('refuses nodes:write held on a DIFFERENT source', async () => {
      await grantNodes(harness.limited.id, harness.sourceB, { read: true, write: true });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(url(harness.sourceA)).send({ enabled: true, ...PINNED });
      expect(res.status).toBe(403);
      const del = await agent.delete(url(harness.sourceA));
      expect(del.status).toBe(403);
    });

    it('refuses an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post(url(harness.sourceA)).send({ enabled: true, ...PINNED });
      expect([401, 403]).toContain(res.status);
    });

    it('lets a caller with nodes:write on the source set it', async () => {
      await grantNodes(harness.limited.id, harness.sourceA, { read: true, write: true });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(url(harness.sourceA)).send({ enabled: true, ...PINNED });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({ enabled: true, ...PINNED, isPrivate: false });
    });
  });

  describe('set / clear', () => {
    it('sets, reads back, and clears the override on one source only', async () => {
      const agent = await harness.loginAs(harness.admin);
      expect((await agent.post(url(harness.sourceA)).send({ enabled: true, ...PINNED })).status).toBe(200);

      const get = await agent.get(url(harness.sourceA));
      expect(get.status).toBe(200);
      expect(get.body.data).toMatchObject({ enabled: true, ...PINNED, isPrivate: false });

      // Source isolation: source B is untouched.
      expect((await agent.get(url(harness.sourceB))).body.data.enabled).toBe(false);

      const del = await agent.delete(url(harness.sourceA));
      expect(del.status).toBe(200);
      const after = await agent.get(url(harness.sourceA));
      expect(after.body.data.enabled).toBe(false);
      expect(after.body.data.latitude).toBeUndefined();
    });

    it('enabled:false clears it too', async () => {
      const agent = await harness.loginAs(harness.admin);
      await agent.post(url(harness.sourceA)).send({ enabled: true, ...PINNED });
      expect((await agent.post(url(harness.sourceA)).send({ enabled: false })).status).toBe(200);
      expect((await harness.db.meshcore.getNodePositionOverride(harness.sourceA, KEY))?.enabled).toBe(false);
    });

    it('validates the body', async () => {
      const agent = await harness.loginAs(harness.admin);
      expect((await agent.post(url(harness.sourceA)).send({ enabled: 'yes' })).body.code).toBe('INVALID_PARAMETER_TYPE');
      expect((await agent.post(url(harness.sourceA)).send({ enabled: true, latitude: 91, longitude: 0 })).body.code).toBe('INVALID_LATITUDE');
      expect((await agent.post(url(harness.sourceA)).send({ enabled: true, latitude: 0, longitude: 181 })).body.code).toBe('INVALID_LONGITUDE');
      expect((await agent.post(url(harness.sourceA)).send({ enabled: true, latitude: 1, longitude: 1, altitude: 'x' })).body.code).toBe('INVALID_ALTITUDE');
      expect((await agent.post(url(harness.sourceA)).send({ enabled: true, latitude: 1, longitude: 1, isPrivate: 'no' })).body.code).toBe('INVALID_PARAMETER_TYPE');
      expect((await agent.post(`/sources/${harness.sourceA}/meshcore/nodes/xyz/position-override`).send({ enabled: true, latitude: 1, longitude: 1 })).body.code).toBe('INVALID_PUBLIC_KEY');
    });

    it('404s for a node this source has never seen', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(url(harness.sourceA, UNKNOWN_KEY)).send({ enabled: true, ...PINNED });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NODE_NOT_FOUND');
    });
  });

  describe('precedence', () => {
    it('the override wins on GET /nodes, GET /contacts and GET /snapshot', async () => {
      const agent = await harness.loginAs(harness.admin);
      await agent.post(url(harness.sourceA)).send({ enabled: true, ...PINNED });

      const nodes = await agent.get(`/sources/${harness.sourceA}/meshcore/nodes`);
      expect(nodes.body.data[0]).toMatchObject({ latitude: PINNED.latitude, longitude: PINNED.longitude, positionIsOverride: true });

      const contacts = await agent.get(`/sources/${harness.sourceA}/meshcore/contacts`);
      expect(contacts.body.data[0]).toMatchObject({ latitude: PINNED.latitude, longitude: PINNED.longitude, positionIsOverride: true });

      const snap = await agent.get(`/sources/${harness.sourceA}/meshcore/snapshot`);
      expect(snap.body.data.contacts[0]).toMatchObject({ latitude: PINNED.latitude, longitude: PINNED.longitude });
      expect(snap.body.data.nodes[0]).toMatchObject({ latitude: PINNED.latitude, longitude: PINNED.longitude });

      // Source B has no override: the advert position stands.
      const nodesB = await agent.get(`/sources/${harness.sourceB}/meshcore/nodes`);
      expect(nodesB.body.data[0]).toMatchObject(ADVERT);
      expect(nodesB.body.data[0].positionIsOverride).toBeUndefined();
    });

    it('survives an advert update, which never touches the override columns', async () => {
      const agent = await harness.loginAs(harness.admin);
      await agent.post(url(harness.sourceA)).send({ enabled: true, ...PINNED });

      // Simulated advert ingest: a new advert position, and a caller that
      // spreads stale override fields in (must be ignored).
      await harness.db.meshcore.upsertNode({
        publicKey: KEY,
        latitude: 41.0,
        longitude: -106.0,
        positionSource: 'contact',
        positionOverrideEnabled: false,
        latitudeOverride: null,
      }, harness.sourceA);

      const stored = await harness.db.meshcore.getNodeByPublicKeyAndSource(KEY, harness.sourceA);
      expect(stored?.latitude).toBe(41.0); // advert fix kept in its own column
      expect(stored?.positionOverrideEnabled).toBe(true);
      expect(stored?.latitudeOverride).toBe(PINNED.latitude);

      const nodes = await agent.get(`/sources/${harness.sourceA}/meshcore/nodes`);
      expect(nodes.body.data[0]).toMatchObject({ latitude: PINNED.latitude, longitude: PINNED.longitude });
    });
  });

  describe('privacy', () => {
    beforeEach(async () => {
      const admin = await harness.loginAs(harness.admin);
      await admin.post(url(harness.sourceA)).send({ enabled: true, ...PINNED, isPrivate: true });
    });

    it('without nodes_private:read the advert position is shown and the override is withheld', async () => {
      await grantNodes(harness.limited.id, harness.sourceA, { read: true, viewOnMap: true });
      const agent = await harness.loginAs(harness.limited);

      const nodes = await agent.get(`/sources/${harness.sourceA}/meshcore/nodes`);
      expect(nodes.body.data[0]).toMatchObject(ADVERT);
      expect(nodes.body.data[0]).not.toHaveProperty('latitudeOverride');
      expect(nodes.body.data[0]).not.toHaveProperty('positionIsOverride');

      const get = await agent.get(url(harness.sourceA));
      expect(get.body.data).toMatchObject({ enabled: true, isPrivate: true });
      expect(get.body.data.latitude).toBeUndefined();
      expect(get.body.data.longitude).toBeUndefined();
    });

    it('nodes_private:read on ANOTHER source does not unlock it', async () => {
      await grantNodes(harness.limited.id, harness.sourceA, { read: true, viewOnMap: true });
      await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const nodes = await agent.get(`/sources/${harness.sourceA}/meshcore/nodes`);
      expect(nodes.body.data[0]).toMatchObject(ADVERT);
    });

    it('with nodes_private:read on the source the override is shown', async () => {
      await grantNodes(harness.limited.id, harness.sourceA, { read: true, viewOnMap: true });
      await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const nodes = await agent.get(`/sources/${harness.sourceA}/meshcore/nodes`);
      expect(nodes.body.data[0]).toMatchObject({ latitude: PINNED.latitude, longitude: PINNED.longitude, positionIsOverride: true, positionOverrideIsPrivate: true });
      const get = await agent.get(url(harness.sourceA));
      expect(get.body.data).toMatchObject({ enabled: true, isPrivate: true, latitude: PINNED.latitude });
    });

    it('without nodes:viewOnMap no position and no override fields are sent', async () => {
      await grantNodes(harness.limited.id, harness.sourceA, { read: true });
      await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const nodes = await agent.get(`/sources/${harness.sourceA}/meshcore/nodes`);
      expect(nodes.body.data[0].latitude).toBeUndefined();
      expect(nodes.body.data[0]).not.toHaveProperty('latitudeOverride');
      expect(nodes.body.data[0]).not.toHaveProperty('positionIsOverride');
      expect((await agent.get(url(harness.sourceA))).body.data.latitude).toBeUndefined();
    });
  });
});
