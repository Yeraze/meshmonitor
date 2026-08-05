/**
 * Route test — MeshCore contact/node routes require nodes:viewOnMap before
 * publishing positions, not just nodes:read / connection:read (issue #4559).
 *
 * Before this fix, GET /nodes, GET /contacts, and GET /snapshot all returned
 * full latitude/longitude for anyone who cleared their (coarser) read gate —
 * there was no way for an admin to grant the MeshCore contact list to a user
 * (or the built-in `anonymous` user) without also unconditionally publishing
 * every contact's position on the map. The fix masks lat/lon on these three
 * routes when the caller lacks nodes:viewOnMap, mirroring the equivalent
 * per-channel viewOnMap gate Meshtastic already has via
 * filterNodesByChannelPermission/maskNodeLocationByChannel.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const STUB_CONTACT = {
  publicKey: 'a'.repeat(64),
  advName: 'Repeater One',
  name: 'Repeater One',
  latitude: 40.0,
  longitude: -105.0,
  advType: 1,
  lastSeen: 1000,
};

const STUB_NODE = {
  publicKey: 'a'.repeat(64),
  name: 'Repeater One',
  advType: 1,
  latitude: 40.0,
  longitude: -105.0,
};

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    getConnectionStatus: () => ({ connected: true, deviceType: 1, config: null }),
    getLocalNode: () => null,
    getContacts: () => [STUB_CONTACT],
    getAllNodes: async () => [STUB_NODE],
    getRecentMessages: (_limit?: number) => [],
  });
  const managers = new Map([['rt-source-a', stubFor('rt-source-a')]]);
  return {
    sourceManagerRegistry: {
      getManager: (sourceId: string) => managers.get(sourceId),
      getAllManagers: () => Array.from(managers.values()),
    },
  };
});

describe('MeshCore routes — nodes:viewOnMap gates position data (#4559)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    // harness.cleanup() only revokes `limited`/`admin` grants; the built-in
    // `anonymous` user is shared across tests in this file, so its grants
    // must be cleared too or a later test's grant hits the (user, resource,
    // sourceId) unique constraint.
    await harness.db.auth.deletePermissionsForUser(harness.anonymous.id).catch(() => {});
    await harness.cleanup();
  });

  const grantViewOnMap = async (userId: number) => {
    await harness.db.auth.createPermission({
      userId,
      resource: 'nodes',
      canRead: true,
      canViewOnMap: true,
      canWrite: false,
      sourceId: harness.sourceA,
      grantedAt: Date.now(),
      grantedBy: null,
    });
  };

  describe('GET /nodes', () => {
    it('masks lat/lon with nodes:read but not nodes:viewOnMap', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/nodes`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].latitude).toBeUndefined();
      expect(res.body.data[0].longitude).toBeUndefined();
      expect(res.body.data[0].publicKey).toBe(STUB_NODE.publicKey);
    });

    it('includes lat/lon once nodes:viewOnMap is also granted', async () => {
      await grantViewOnMap(harness.limited.id);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/nodes`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].latitude).toBe(40.0);
      expect(res.body.data[0].longitude).toBe(-105.0);
    });

    it('admin always sees positions', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/nodes`);
      expect(res.body.data[0].latitude).toBe(40.0);
    });
  });

  describe('GET /contacts', () => {
    it('masks lat/lon with nodes:read but not nodes:viewOnMap', async () => {
      await harness.grant(harness.anonymous.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(null);

      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/contacts`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].latitude).toBeUndefined();
      expect(res.body.data[0].longitude).toBeUndefined();
      expect(res.body.data[0].name).toBe(STUB_CONTACT.name);
    });

    it('includes lat/lon for anonymous once nodes:viewOnMap is granted', async () => {
      await grantViewOnMap(harness.anonymous.id);
      const agent = await harness.loginAs(null);

      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/contacts`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].latitude).toBe(40.0);
      expect(res.body.data[0].longitude).toBe(-105.0);
    });
  });

  describe('GET /snapshot', () => {
    it('masks contacts/nodes lat/lon with connection:read but not nodes:viewOnMap', async () => {
      await harness.grant(harness.limited.id, 'connection', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/snapshot`);

      expect(res.status).toBe(200);
      expect(res.body.data.contacts[0].latitude).toBeUndefined();
      expect(res.body.data.nodes[0].latitude).toBeUndefined();
    });

    it('includes positions once nodes:viewOnMap is also granted', async () => {
      await harness.grant(harness.limited.id, 'connection', 'read', harness.sourceA);
      await grantViewOnMap(harness.limited.id);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/snapshot`);

      expect(res.status).toBe(200);
      expect(res.body.data.contacts[0].latitude).toBe(40.0);
      expect(res.body.data.nodes[0].latitude).toBe(40.0);
    });
  });
});
