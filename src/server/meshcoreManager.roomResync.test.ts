/**
 * MeshCoreManager — "Clear stored posts & re-sync" (#6579).
 *
 *  - the radio contact is reset through ONE backend command (remove, then
 *    re-add with all fields), and the node row is never deleted;
 *  - a re-add the radio did not keep falls back to "Add to radio" from the DB;
 *  - Repeater (RAW/RX ingest) sources are refused before anything happens;
 *  - posts stamped at or before the clear come back QUIETLY: stored and sent
 *    to the UI flagged `resynced`, but never as a manager `message` event and
 *    never routed to notifications / automations.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, type MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { dataEventEmitter, type DataEvent } from './services/dataEventEmitter.js';
import { shouldRouteMeshCoreMessageToAutomations } from './services/automation/automationEngineSingleton.js';

const ROOM = 'bb'.repeat(32);
const SELF = 'aa'.repeat(32);
const AUTHOR = 'cc'.repeat(32);
const CLEAR_AT = 1_763_000_000_000;

function makeManager(opts: { deviceType?: MeshCoreDeviceType; reset?: Record<string, unknown> } = {}) {
  const m = new MeshCoreManager('src-resync');
  (m as any).deviceType = opts.deviceType ?? MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: SELF, name: 'Me' };
  (m as any).contacts.set(ROOM, { publicKey: ROOM, advType: 3, advName: 'Room' });
  (m as any).contacts.set(AUTHOR, { publicKey: AUTHOR, advType: 1, advName: 'Alice' });
  const calls: string[] = [];
  (m as any).sendBridgeCommand = async (cmd: string) => {
    calls.push(cmd);
    if (cmd === 'reset_contact_sync') {
      return { id: '1', success: true, data: opts.reset ?? { removed: true, readded: true } };
    }
    return { id: '1', success: true, data: {} };
  };
  const emitted: MeshCoreMessage[] = [];
  m.on('message', (msg: MeshCoreMessage) => emitted.push(msg));
  return { manager: m, calls, emitted };
}

function stubDb(clearAt: number | null) {
  return {
    getNode: vi.spyOn(databaseService.meshcore, 'getNodeByPublicKeyAndSource')
      .mockResolvedValue({ publicKey: ROOM, advType: 3 } as any),
    getClear: vi.spyOn(databaseService.meshcore, 'getRoomClearAt').mockResolvedValue(clearAt),
    recordClear: vi.spyOn(databaseService.meshcore, 'recordRoomClear').mockResolvedValue(undefined),
    endpoints: vi.spyOn(databaseService.meshcore, 'getMessageEndpointsForSource').mockResolvedValue([
      { id: 'theirs', fromPublicKey: AUTHOR.slice(0, 8), toPublicKey: ROOM, messageType: 'room_post' },
      { id: 'mine', fromPublicKey: SELF, toPublicKey: ROOM, messageType: 'room_post' },
      { id: 'mine-legacy', fromPublicKey: 'local', toPublicKey: ROOM, messageType: 'room_post' },
      { id: 'other-room', fromPublicKey: AUTHOR, toPublicKey: 'dd'.repeat(32), messageType: 'room_post' },
      { id: 'dm', fromPublicKey: AUTHOR, toPublicKey: ROOM, messageType: 'text' },
    ]),
    deleteByIds: vi.spyOn(databaseService.meshcore, 'deleteMessagesByIds').mockResolvedValue(1),
    reactions: vi.spyOn(databaseService.meshcore, 'deleteReactionsForTargets').mockResolvedValue([]),
    syncConfig: vi.spyOn(databaseService.meshcore, 'getRoomSyncConfig')
      .mockResolvedValue({ enabled: true, intervalMinutes: 60, failureCount: 0, lastError: null, lastClearAt: null }),
    deleteNode: vi.spyOn(databaseService.meshcore, 'deleteNode').mockResolvedValue(true),
    upsert: vi.spyOn(databaseService.meshcore, 'upsertNode').mockResolvedValue(undefined as any),
    insert: vi.spyOn(databaseService.meshcore, 'insertMessage').mockResolvedValue(true),
    lastPost: vi.spyOn(databaseService.meshcore, 'updateLastRoomPostAt').mockResolvedValue(undefined),
  };
}

describe('MeshCoreManager.clearRoomPostsAndResync (#6579)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('resets the radio contact, stamps the cooldown, deletes only received posts of this room', async () => {
    const db = stubDb(null);
    const { manager, calls } = makeManager();
    (manager as any).roomLoggedInNodes.set(ROOM, { loggedIn: true, loginTime: 1 });

    const res = await manager.clearRoomPostsAndResync(ROOM, CLEAR_AT);

    expect(res).toEqual({ status: 'done', deleted: 1, resyncQueued: true, clearedAt: CLEAR_AT });
    expect(calls).toEqual(['reset_contact_sync']);
    expect(db.recordClear).toHaveBeenCalledWith('src-resync', ROOM, CLEAR_AT);
    expect(db.endpoints).toHaveBeenCalledWith('src-resync', 'room_post');
    expect(db.deleteByIds).toHaveBeenCalledWith(['theirs'], 'src-resync');
    // MeshMonitor's row (name, saved password, favourite, sync settings) stays.
    expect(db.deleteNode).not.toHaveBeenCalled();
    expect(manager.isRoomLoggedIn(ROOM)).toBe(false);
    // The device step ran before the cooldown stamp and the delete.
    expect(db.recordClear.mock.invocationCallOrder[0]).toBeLessThan(db.deleteByIds.mock.invocationCallOrder[0]);
  });

  it('inside the cooldown: nothing is sent, nothing deleted', async () => {
    const db = stubDb(CLEAR_AT - 10 * 60_000);
    const { manager, calls } = makeManager();
    const res = await manager.clearRoomPostsAndResync(ROOM, CLEAR_AT);
    expect(res).toEqual({ status: 'cooldown', retryAfterMs: 20 * 60_000 });
    expect(calls).toEqual([]);
    expect(db.deleteByIds).not.toHaveBeenCalled();
    expect(db.recordClear).not.toHaveBeenCalled();
  });

  it('refuses a Repeater (RAW/RX ingest) source before touching anything', async () => {
    const db = stubDb(null);
    const { manager, calls } = makeManager({ deviceType: MeshCoreDeviceType.REPEATER });
    expect(await manager.clearRoomPostsAndResync(ROOM, CLEAR_AT)).toEqual({ status: 'unavailable' });
    expect(calls).toEqual([]);
    expect(db.recordClear).not.toHaveBeenCalled();
  });

  it('does not delete or stamp when the radio did not remove the contact', async () => {
    const db = stubDb(null);
    const { manager } = makeManager({ reset: { removed: false, readded: false } });
    const res = await manager.clearRoomPostsAndResync(ROOM, CLEAR_AT);
    expect(res.status).toBe('failed');
    expect(db.recordClear).not.toHaveBeenCalled();
    expect(db.deleteByIds).not.toHaveBeenCalled();
  });

  it('restores the contact from the DB when the radio did not keep the re-add', async () => {
    stubDb(null);
    const { manager } = makeManager({ reset: { removed: true, readded: false } });
    const add = vi.spyOn(manager, 'addContactToDevice').mockResolvedValue({ status: 'added', evicted: [], count: 2, maxContacts: 100 });
    const res = await manager.clearRoomPostsAndResync(ROOM, CLEAR_AT);
    expect(add).toHaveBeenCalledWith(ROOM, { confirmFull: true });
    expect(res.status).toBe('done');
  });

  it('reports a contact it could not put back', async () => {
    const db = stubDb(null);
    const { manager } = makeManager({ reset: { removed: true, readded: false } });
    vi.spyOn(manager, 'addContactToDevice').mockResolvedValue({ status: 'failed', error: 'x' });
    const res = await manager.clearRoomPostsAndResync(ROOM, CLEAR_AT);
    expect(res).toMatchObject({ status: 'failed', contactMissing: true });
    expect(db.deleteByIds).not.toHaveBeenCalled();
  });
});

describe('re-synced room posts stay quiet (#6579)', () => {
  beforeEach(() => vi.restoreAllMocks());
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function capture(): DataEvent[] {
    const events: DataEvent[] = [];
    const onData = (e: DataEvent) => { if (e.type === 'meshcore:message') events.push(e); };
    dataEventEmitter.on('data', onData);
    return events;
  }

  function post(manager: MeshCoreManager, senderSec: number, text: string) {
    (manager as any).handleBridgeEvent({
      event_type: 'room_message',
      data: {
        room_pubkey_prefix: ROOM.substring(0, 12),
        author_pubkey_prefix: AUTHOR.substring(0, 8),
        text,
        sender_timestamp: senderSec,
      },
    });
  }

  it('a post stamped before the clear is shown but fires no manager event and no automation', async () => {
    stubDb(CLEAR_AT);
    const { manager, emitted } = makeManager();
    const events = capture();
    post(manager, CLEAR_AT / 1000 - 3600, 'old post');
    await flush();
    await flush();

    expect(emitted).toHaveLength(0);
    const mine = events.filter(e => (e.data as MeshCoreMessage).text === 'old post');
    expect(mine).toHaveLength(1);
    const msg = mine[0].data as MeshCoreMessage;
    expect(msg.resynced).toBe(true);
    expect(shouldRouteMeshCoreMessageToAutomations(msg)).toBe(false);
  });

  it('a post stamped after the clear is a normal new post', async () => {
    stubDb(CLEAR_AT);
    const { manager, emitted } = makeManager();
    const events = capture();
    post(manager, CLEAR_AT / 1000 + 60, 'new post');
    await flush();
    await flush();

    expect(emitted).toHaveLength(1);
    const msg = events.find(e => (e.data as MeshCoreMessage).text === 'new post')!.data as MeshCoreMessage;
    expect(msg.resynced).toBeUndefined();
    expect(shouldRouteMeshCoreMessageToAutomations(msg)).toBe(true);
  });

  it('with no clear on record every post is normal', async () => {
    stubDb(null);
    const { manager, emitted } = makeManager();
    post(manager, 1_700_000_000, 'ordinary');
    await flush();
    await flush();
    expect(emitted).toHaveLength(1);
  });
});
