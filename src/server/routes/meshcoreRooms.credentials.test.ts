/**
 * Route tests — forgetting a saved room-server password.
 *
 * Before `DELETE /rooms/credentials/:publicKey` existed there was no way out of
 * a saved password that had stopped working: the credential store had a
 * `clearRoom()` method that nothing called, and the auto-sync toggle that
 * drives the retries only renders once you are logged IN — which a wrong
 * password prevents. Meanwhile the scheduler kept re-trying the stale password,
 * flooding the mesh and filling the room operator's log with refusals.
 *
 * Uses `createRouteTestApp()` per CLAUDE.md: real express-session + real auth
 * middleware + real permission SQL against the singleton's `:memory:` DB. Only
 * `sourceManagerRegistry` (non-DB) is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { setMeshCoreCredentialStoreForTesting } from '../services/meshcoreCredentialStore.js';
import type { MeshCoreCredentialStore } from '../services/meshcoreCredentialStore.js';

const VALID_PK = 'b'.repeat(64);

const managers = new Map<string, unknown>();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (sourceId: string) => managers.get(sourceId),
    getAllManagers: () => Array.from(managers.values()),
  },
}));

/** Credential store double backed by a plain map, so `clearRoom` is observable. */
function makeStore() {
  const rooms = new Map<string, string>();
  return {
    rooms,
    capability: { canRemember: true },
    storeRoom: vi.fn(async (sourceId: string, pk: string, password: string) => {
      rooms.set(`${sourceId}|${pk}`, password);
    }),
    loadRoom: vi.fn(async (sourceId: string, pk: string) => {
      const password = rooms.get(`${sourceId}|${pk}`);
      return password === undefined ? { kind: 'none' as const } : { kind: 'ok' as const, password };
    }),
    clearRoom: vi.fn(async (sourceId: string, pk: string) => {
      rooms.delete(`${sourceId}|${pk}`);
    }),
    listStoredRoom: vi.fn(async (sourceId: string) =>
      Array.from(rooms.keys())
        .filter((k) => k.startsWith(`${sourceId}|`))
        .map((k) => ({ sourceId, publicKey: k.split('|')[1], name: null })),
    ),
  };
}

describe('DELETE /rooms/credentials/:publicKey', () => {
  let harness: RouteTestHarness;
  let store: ReturnType<typeof makeStore>;

  const base = (sourceId: string) => `/sources/${sourceId}/meshcore`;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
    managers.set(harness.sourceA, {
      sourceId: harness.sourceA,
      sourceType: 'meshcore',
      isReceiveOnly: () => false,
      isConnected: () => true,
    });
    store = makeStore();
    setMeshCoreCredentialStoreForTesting(store as unknown as MeshCoreCredentialStore);

    await databaseService.meshcore.upsertNode({ publicKey: VALID_PK, advType: 3 }, harness.sourceA);
    await databaseService.meshcore.setRoomSyncConfig(harness.sourceA, VALID_PK, {
      roomSyncEnabled: true,
      roomSyncIntervalMinutes: 60,
    });
    store.rooms.set(`${harness.sourceA}|${VALID_PK}`, 'stale-password');
  });

  afterEach(async () => {
    managers.clear();
    setMeshCoreCredentialStoreForTesting(null);
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  it('clears the stored credential', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.delete(`${base(harness.sourceA)}/rooms/credentials/${VALID_PK}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(store.clearRoom).toHaveBeenCalledWith(harness.sourceA, VALID_PK);
    expect(store.rooms.has(`${harness.sourceA}|${VALID_PK}`)).toBe(false);
  });

  it('turns auto-sync off and resets the failure record', async () => {
    // With no credential the scheduler can only skip the room, so leaving the
    // toggle on would advertise a sync that cannot happen.
    await databaseService.meshcore.recordRoomSyncFailure(harness.sourceA, VALID_PK, 'rejected');

    const agent = await harness.loginAs(harness.admin);
    await agent.delete(`${base(harness.sourceA)}/rooms/credentials/${VALID_PK}`);

    const config = await databaseService.meshcore.getRoomSyncConfig(harness.sourceA, VALID_PK);
    expect(config).toMatchObject({ enabled: false, failureCount: 0, lastError: null });
  });

  it('rejects a malformed public key before touching the store', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.delete(`${base(harness.sourceA)}/rooms/credentials/not-a-key`);

    expect(res.status).toBe(400);
    expect(store.clearRoom).not.toHaveBeenCalled();
  });

  it('requires messages:write on that source', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.delete(`${base(harness.sourceA)}/rooms/credentials/${VALID_PK}`);

    expect(res.status).toBe(403);
    expect(store.clearRoom).not.toHaveBeenCalled();
  });

  it('does not let write access on one source clear another source\'s credential', async () => {
    store.rooms.set(`${harness.sourceB}|${VALID_PK}`, 'other-source-password');
    // Register sourceB too, so the 403 comes from the permission check rather
    // than an unregistered-source 404 masking it.
    managers.set(harness.sourceB, {
      sourceId: harness.sourceB,
      sourceType: 'meshcore',
      isReceiveOnly: () => false,
      isConnected: () => true,
    });
    await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.delete(`${base(harness.sourceB)}/rooms/credentials/${VALID_PK}`);

    expect(res.status).toBe(403);
    expect(store.rooms.has(`${harness.sourceB}|${VALID_PK}`)).toBe(true);
  });
});

describe('GET /rooms/sync-config — failure state', () => {
  let harness: RouteTestHarness;

  const base = (sourceId: string) => `/sources/${sourceId}/meshcore`;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
    managers.set(harness.sourceA, {
      sourceId: harness.sourceA,
      sourceType: 'meshcore',
      isReceiveOnly: () => false,
      isConnected: () => true,
    });
    await databaseService.meshcore.upsertNode({ publicKey: VALID_PK, advType: 3 }, harness.sourceA);
    await databaseService.meshcore.setRoomSyncConfig(harness.sourceA, VALID_PK, {
      roomSyncEnabled: true,
      roomSyncIntervalMinutes: 60,
    });
  });

  afterEach(async () => {
    managers.clear();
    await harness.cleanup();
  });

  it('reports why auto-sync switched itself off', async () => {
    await databaseService.meshcore.recordRoomSyncFailure(harness.sourceA, VALID_PK, 'rejected', {
      disable: true,
    });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`${base(harness.sourceA)}/rooms/sync-config?publicKey=${VALID_PK}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, failureCount: 1, lastError: 'rejected' });
  });

  it('re-enabling auto-sync clears the failure count', async () => {
    // The user overriding the scheduler's decision to give up: the fresh
    // attempt must be judged on its own, not trip the threshold on first miss.
    await databaseService.meshcore.recordRoomSyncFailure(harness.sourceA, VALID_PK, 'no_reply');
    await databaseService.meshcore.recordRoomSyncFailure(harness.sourceA, VALID_PK, 'no_reply');

    const agent = await harness.loginAs(harness.admin);
    await agent
      .patch(`${base(harness.sourceA)}/rooms/sync-config`)
      .send({ publicKey: VALID_PK, enabled: true, intervalMinutes: 60 });

    const config = await databaseService.meshcore.getRoomSyncConfig(harness.sourceA, VALID_PK);
    expect(config).toMatchObject({ enabled: true, failureCount: 0, lastError: null });
  });

  it('turning auto-sync off leaves the failure record for the UI to explain', async () => {
    await databaseService.meshcore.recordRoomSyncFailure(harness.sourceA, VALID_PK, 'rejected');

    const agent = await harness.loginAs(harness.admin);
    await agent
      .patch(`${base(harness.sourceA)}/rooms/sync-config`)
      .send({ publicKey: VALID_PK, enabled: false });

    const config = await databaseService.meshcore.getRoomSyncConfig(harness.sourceA, VALID_PK);
    expect(config).toMatchObject({ enabled: false, failureCount: 1, lastError: 'rejected' });
  });
});
