/**
 * Route tests — POST /rooms/clear-posts ("Clear stored posts & re-sync", #6579).
 *
 * Uses `createRouteTestApp()` per CLAUDE.md: real express-session, real auth
 * middleware and real permission SQL against the singleton's `:memory:` DB.
 * The manager is a REAL MeshCoreManager with only its device bridge stubbed,
 * so the cooldown is read from and written to the real database: a second
 * manager instance stands in for a process restart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { MeshCoreManager, MeshCoreDeviceType, ROOM_CLEAR_COOLDOWN_MS } from '../meshcoreManager.js';
import { setMeshCoreCredentialStoreForTesting } from '../services/meshcoreCredentialStore.js';
import type { MeshCoreCredentialStore } from '../services/meshcoreCredentialStore.js';

const ROOM = 'b'.repeat(64);
const SELF = 'a'.repeat(64);
const AUTHOR = 'c'.repeat(64);

const managers = new Map<string, unknown>();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (sourceId: string) => managers.get(sourceId),
    getAllManagers: () => Array.from(managers.values()),
  },
}));

interface BridgeCall { cmd: string; params: Record<string, unknown> }

function makeManager(sourceId: string, deviceType = MeshCoreDeviceType.COMPANION) {
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = deviceType;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: SELF, name: 'Me' };
  (m as any).contacts.set(ROOM, { publicKey: ROOM, advType: 3, advName: 'Room' });
  const calls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    calls.push({ cmd, params });
    if (cmd === 'reset_contact_sync') return { id: '1', success: true, data: { removed: true, readded: true } };
    return { id: '1', success: true, data: {} };
  };
  managers.set(sourceId, m);
  return { manager: m, calls };
}

async function seedPost(sourceId: string, id: string, from: string): Promise<void> {
  await databaseService.meshcore.insertMessage({
    id,
    fromPublicKey: from,
    toPublicKey: ROOM,
    text: `post ${id}`,
    timestamp: 1_700_000_000_000,
    messageType: 'room_post',
    createdAt: Date.now(),
  } as any, sourceId);
}

async function roomPostIds(sourceId: string): Promise<string[]> {
  const rows = await databaseService.meshcore.getMessageEndpointsForSource(sourceId);
  return rows.filter(r => r.messageType === 'room_post').map(r => r.id).sort();
}

describe('POST /rooms/clear-posts (#6579)', () => {
  let harness: RouteTestHarness;
  const url = (sourceId: string) => `/sources/${sourceId}/meshcore/rooms/clear-posts`;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
    setMeshCoreCredentialStoreForTesting({ capability: { canRemember: true } } as unknown as MeshCoreCredentialStore);
    for (const src of [harness.sourceA, harness.sourceB]) {
      // The singleton DB outlives each test: start every one from a fresh row.
      await databaseService.meshcore.deleteNode(ROOM, src);
      await databaseService.meshcore.upsertNode({ publicKey: ROOM, advType: 3, name: 'Room' }, src);
      await databaseService.meshcore.setRoomSyncConfig(src, ROOM, { roomSyncEnabled: true, roomSyncIntervalMinutes: 60 });
      await seedPost(src, `${src}-theirs`, AUTHOR);
      await seedPost(src, `${src}-mine`, SELF);
    }
  });

  afterEach(async () => {
    managers.clear();
    setMeshCoreCredentialStoreForTesting(null);
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  it('clears received posts on this source only, keeps own posts and the node row, resets the radio contact', async () => {
    const { calls } = makeManager(harness.sourceA);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(url(harness.sourceA)).send({ publicKey: ROOM });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ deleted: 1, resyncQueued: true });
    expect(res.body.data.nextAllowedAt - res.body.data.clearedAt).toBe(ROOM_CLEAR_COOLDOWN_MS);

    // One device write: the remove + re-add runs inside the backend command.
    expect(calls.map(c => c.cmd)).toEqual(['reset_contact_sync']);
    expect(calls[0].params).toEqual({ public_key: ROOM });

    expect(await roomPostIds(harness.sourceA)).toEqual([`${harness.sourceA}-mine`]);
    expect(await roomPostIds(harness.sourceB)).toHaveLength(2);

    // The node row (sync settings, saved password column) survives.
    const node = await databaseService.meshcore.getNodeByPublicKeyAndSource(ROOM, harness.sourceA);
    expect(node).not.toBeNull();
    const config = await databaseService.meshcore.getRoomSyncConfig(harness.sourceA, ROOM);
    expect(config).toMatchObject({ enabled: true });
    expect(config!.lastClearAt).toBe(res.body.data.clearedAt);
    // Other source untouched.
    expect(await databaseService.meshcore.getRoomClearAt(harness.sourceB, ROOM)).toBeNull();
  });

  it('answers 429 with retryAfterSeconds inside the cooldown, and a restart does not re-arm it', async () => {
    makeManager(harness.sourceA);
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.post(url(harness.sourceA)).send({ publicKey: ROOM })).status).toBe(200);

    const again = await agent.post(url(harness.sourceA)).send({ publicKey: ROOM });
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ success: false, code: 'ROOM_CLEAR_COOLDOWN' });
    expect(again.body.retryAfterSeconds).toBeGreaterThan(29 * 60);
    expect(again.body.retryAfterSeconds).toBeLessThanOrEqual(30 * 60);

    // "Restart": a brand-new manager with empty memory. The stamp is in the DB.
    const { calls } = makeManager(harness.sourceA);
    const afterRestart = await agent.post(url(harness.sourceA)).send({ publicKey: ROOM });
    expect(afterRestart.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it('allows a clear again once the 30 minutes have passed', async () => {
    makeManager(harness.sourceA);
    await databaseService.meshcore.recordRoomClear(harness.sourceA, ROOM, Date.now() - ROOM_CLEAR_COOLDOWN_MS - 1000);
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.post(url(harness.sourceA)).send({ publicKey: ROOM })).status).toBe(200);
  });

  it('is gated per source: a grant on source B does not allow a clear on source A', async () => {
    const { calls } = makeManager(harness.sourceA);
    await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceB);
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ publicKey: ROOM });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(await roomPostIds(harness.sourceA)).toHaveLength(2);
  });

  it('needs configuration:write on the source; messages:write alone is not enough', async () => {
    makeManager(harness.sourceA);
    await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(url(harness.sourceA)).send({ publicKey: ROOM })).status).toBe(403);

    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    expect((await agent.post(url(harness.sourceA)).send({ publicKey: ROOM })).status).toBe(200);
  });

  it('refuses a repeater-ingest source with 409 and touches nothing', async () => {
    const { calls } = makeManager(harness.sourceA, MeshCoreDeviceType.REPEATER);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(url(harness.sourceA)).send({ publicKey: ROOM });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COMPANION_REQUIRED');
    expect(calls).toHaveLength(0);
    expect(await roomPostIds(harness.sourceA)).toHaveLength(2);
    expect(await databaseService.meshcore.getRoomClearAt(harness.sourceA, ROOM)).toBeNull();
  });

  it('rejects an invalid key with 400', async () => {
    makeManager(harness.sourceA);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(url(harness.sourceA)).send({ publicKey: 'nope' });
    expect(res.status).toBe(400);
  });

  it('reports the cooldown in GET /rooms/sync-config', async () => {
    makeManager(harness.sourceA);
    await databaseService.meshcore.recordRoomClear(harness.sourceA, ROOM, 1_800_000_000_000);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/sources/${harness.sourceA}/meshcore/rooms/sync-config?publicKey=${ROOM}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lastClearAt: 1_800_000_000_000, clearCooldownMs: ROOM_CLEAR_COOLDOWN_MS });
  });
});
