/**
 * MeshCoreManager message deletion / purge (#3981).
 *
 * Focus: the manager-side logic that the route tests can't reach with a stub —
 * the DM prefix-matching in purgeConversation (inbound rows key the peer by a
 * pubkey *prefix*, outbound by the full key), the in-memory pool prune, and the
 * broadcast event. DB access is stubbed; per-source SQL scoping is covered by
 * meshcore.messagePurge.perSource.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, type MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';

const SELF = 'aa'.repeat(32);
const PEER = 'cc'.repeat(32);
const PEER_PREFIX = 'cc'.repeat(6); // 12-hex inbound prefix
const OTHER = 'dd'.repeat(32);

function makeManager(): MeshCoreManager {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: SELF };
  return m;
}

function msg(id: string, from: string, to: string | null, extra: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return { id, fromPublicKey: from, toPublicKey: to ?? undefined, text: 't', timestamp: 1, ...extra };
}

describe('MeshCoreManager message purge (#3981)', () => {
  let deleteMessagesByIds: any;
  let deleteChannel: any;
  let deleteAll: any;
  let getEndpoints: any;
  let emitDeleted: any;

  beforeEach(() => {
    vi.clearAllMocks();
    getEndpoints = vi.spyOn(databaseService.meshcore, 'getMessageEndpointsForSource');
    deleteMessagesByIds = vi.spyOn(databaseService.meshcore, 'deleteMessagesByIds').mockImplementation(async (ids: string[]) => ids.length);
    deleteChannel = vi.spyOn(databaseService.meshcore, 'deleteChannelMessagesForSource').mockResolvedValue(2);
    deleteAll = vi.spyOn(databaseService.meshcore, 'deleteAllMessagesForSource').mockResolvedValue(4);
    vi.spyOn(databaseService.meshcore, 'deleteMessageForSource').mockResolvedValue(true);
    emitDeleted = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessagesDeleted').mockImplementation(() => {});
  });

  it('purgeConversation matches inbound (prefix) + outbound (full) rows, excludes channels/rooms/other peers', async () => {
    const m = makeManager();
    // Rows across the source: two belong to the PEER conversation.
    getEndpoints.mockResolvedValue([
      { id: 'in', fromPublicKey: PEER_PREFIX, toPublicKey: SELF, messageType: 'text' }, // inbound DM
      { id: 'out', fromPublicKey: SELF, toPublicKey: PEER, messageType: 'text' },        // outbound DM
      { id: 'other', fromPublicKey: OTHER, toPublicKey: SELF, messageType: 'text' },     // different peer
      { id: 'chan', fromPublicKey: 'channel-0', toPublicKey: null, messageType: 'text' },// channel
      { id: 'room', fromPublicKey: PEER_PREFIX, toPublicKey: SELF, messageType: 'room_post' },
    ]);
    (m as any).messages = [
      msg('in', PEER_PREFIX, SELF),
      msg('out', SELF, PEER),
      msg('other', OTHER, SELF),
    ];

    const count = await m.purgeConversation(PEER);
    expect(count).toBe(2);
    // Only the two conversation rows are targeted.
    const [ids] = deleteMessagesByIds.mock.calls[0];
    expect([...ids].sort()).toEqual(['in', 'out']);
    // In-memory pool keeps only the unrelated row.
    expect((m as any).messages.map((x: MeshCoreMessage) => x.id)).toEqual(['other']);
    expect(emitDeleted).toHaveBeenCalledWith({ conversationPublicKey: PEER }, 'test-source');
  });

  it('purgeConversation with no matches deletes nothing and emits nothing', async () => {
    const m = makeManager();
    getEndpoints.mockResolvedValue([
      { id: 'other', fromPublicKey: OTHER, toPublicKey: SELF, messageType: 'text' },
    ]);
    (m as any).messages = [msg('other', OTHER, SELF)];
    const count = await m.purgeConversation(PEER);
    expect(count).toBe(0);
    expect(deleteMessagesByIds).not.toHaveBeenCalled();
    expect(emitDeleted).not.toHaveBeenCalled();
  });

  it('purgeChannelMessages prunes the channel from the pool and broadcasts', async () => {
    const m = makeManager();
    (m as any).messages = [
      msg('c3a', 'channel-3', null),
      msg('c3b', SELF, 'channel-3'),
      msg('c4', 'channel-4', null),
    ];
    const count = await m.purgeChannelMessages(3);
    expect(count).toBe(2);
    expect(deleteChannel).toHaveBeenCalledWith(3, 'test-source');
    expect((m as any).messages.map((x: MeshCoreMessage) => x.id)).toEqual(['c4']);
    expect(emitDeleted).toHaveBeenCalledWith({ channelIdx: 3 }, 'test-source');
  });

  it('purgeAllMessages clears the pool and broadcasts an all:true event', async () => {
    const m = makeManager();
    (m as any).messages = [msg('a', SELF, PEER), msg('b', PEER_PREFIX, SELF)];
    const count = await m.purgeAllMessages();
    expect(count).toBe(4);
    expect(deleteAll).toHaveBeenCalledWith('test-source');
    expect((m as any).messages).toEqual([]);
    expect(emitDeleted).toHaveBeenCalledWith({ all: true }, 'test-source');
  });

  it('deleteStoredMessage prunes a single row and broadcasts its id', async () => {
    const m = makeManager();
    (m as any).messages = [msg('keep', SELF, PEER), msg('gone', PEER_PREFIX, SELF)];
    const ok = await m.deleteStoredMessage('gone');
    expect(ok).toBe(true);
    expect((m as any).messages.map((x: MeshCoreMessage) => x.id)).toEqual(['keep']);
    expect(emitDeleted).toHaveBeenCalledWith({ ids: ['gone'] }, 'test-source');
  });
});
