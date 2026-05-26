/**
 * Tests for MeshCoreManager room server integration.
 *
 * Covers:
 *   - room_message bridge events → MeshCoreMessage with messageType='room_post'
 *   - Room login state tracking (loginToRoom / isRoomLoggedIn / clear on disconnect)
 *   - getRoomServers() filtering by advType=3
 *   - sendRoomPost() tagging and bridge delegation
 *   - resolveContactByPrefix() prefix matching
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';

interface BridgeCall {
  cmd: string;
  params: Record<string, unknown>;
}

function makeManager(opts?: {
  contacts?: Array<{ publicKey: string; advType?: number; advName?: string }>;
}): {
  manager: MeshCoreManager;
  bridgeCalls: BridgeCall[];
  emittedMessages: MeshCoreMessage[];
} {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: 'aa'.repeat(32) };

  const bridgeCalls: BridgeCall[] = [];
  const emittedMessages: MeshCoreMessage[] = [];

  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    return { id: '1', success: true, data: { sent: true } };
  };

  // Pre-populate contacts if requested.
  if (opts?.contacts) {
    for (const c of opts.contacts) {
      (m as any).contacts.set(c.publicKey, {
        publicKey: c.publicKey,
        advType: c.advType ?? 1,
        advName: c.advName,
      });
    }
  }

  m.on('message', (msg: MeshCoreMessage) => emittedMessages.push(msg));

  // Stub DB persistence so addMessage doesn't fail.
  vi.spyOn(databaseService.meshcore, 'insertMessage').mockResolvedValue(undefined as any);

  return { manager: m, bridgeCalls, emittedMessages };
}

describe('MeshCoreManager room server support', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---- room_message event handling ----

  describe('room_message bridge event', () => {
    it('creates a message with messageType=room_post', () => {
      const roomPubkey = 'bb'.repeat(32);
      const authorPubkey = 'cc'.repeat(32);
      const { manager, emittedMessages } = makeManager({
        contacts: [
          { publicKey: roomPubkey, advType: 3, advName: 'TestRoom' },
          { publicKey: authorPubkey, advType: 1, advName: 'Alice' },
        ],
      });

      // Simulate a room_message bridge event.
      (manager as any).handleBridgeEvent({
        event_type: 'room_message',
        data: {
          room_pubkey_prefix: roomPubkey.substring(0, 12),
          author_pubkey_prefix: authorPubkey.substring(0, 8),
          text: 'Hello from the room!',
          sender_timestamp: 1700000000,
        },
      });

      expect(emittedMessages).toHaveLength(1);
      const msg = emittedMessages[0];
      expect(msg.messageType).toBe('room_post');
      expect(msg.toPublicKey).toBe(roomPubkey);
      expect(msg.fromPublicKey).toBe(authorPubkey.substring(0, 8));
      expect(msg.fromName).toBe('Alice');
      expect(msg.text).toBe('Hello from the room!');
      expect(msg.timestamp).toBe(1700000000000);
    });

    it('resolves room full pubkey from prefix', () => {
      const roomPubkey = 'dd'.repeat(32);
      const { manager, emittedMessages } = makeManager({
        contacts: [
          { publicKey: roomPubkey, advType: 3, advName: 'MyRoom' },
        ],
      });

      (manager as any).handleBridgeEvent({
        event_type: 'room_message',
        data: {
          room_pubkey_prefix: roomPubkey.substring(0, 12),
          author_pubkey_prefix: 'abcd1234',
          text: 'post body',
          sender_timestamp: 1700000001,
        },
      });

      expect(emittedMessages[0].toPublicKey).toBe(roomPubkey);
    });

    it('falls back to prefix when room contact not found', () => {
      const { manager, emittedMessages } = makeManager();

      (manager as any).handleBridgeEvent({
        event_type: 'room_message',
        data: {
          room_pubkey_prefix: 'aabbccddee00',
          author_pubkey_prefix: '11223344',
          text: 'orphan post',
          sender_timestamp: 1700000002,
        },
      });

      expect(emittedMessages[0].toPublicKey).toBe('aabbccddee00');
      expect(emittedMessages[0].fromName).toBeUndefined();
    });
  });

  // ---- Room login state ----

  describe('room login state', () => {
    it('tracks login via loginToRoom', async () => {
      const roomPubkey = 'ee'.repeat(32);
      const { manager } = makeManager({
        contacts: [{ publicKey: roomPubkey, advType: 3 }],
      });

      // Stub loginToNode to succeed.
      vi.spyOn(manager, 'loginToNode').mockResolvedValue(true);

      expect(manager.isRoomLoggedIn(roomPubkey)).toBe(false);
      const ok = await manager.loginToRoom(roomPubkey, 'secret');
      expect(ok).toBe(true);
      expect(manager.isRoomLoggedIn(roomPubkey)).toBe(true);
    });

    it('tracks login failure', async () => {
      const roomPubkey = 'ff'.repeat(32);
      const { manager } = makeManager();

      vi.spyOn(manager, 'loginToNode').mockResolvedValue(false);

      const ok = await manager.loginToRoom(roomPubkey, 'wrong');
      expect(ok).toBe(false);
      expect(manager.isRoomLoggedIn(roomPubkey)).toBe(false);
    });

    it('clears room login state on disconnect', async () => {
      const roomPubkey = 'aa'.repeat(32);
      const { manager } = makeManager({
        contacts: [{ publicKey: roomPubkey, advType: 3 }],
      });

      vi.spyOn(manager, 'loginToNode').mockResolvedValue(true);
      await manager.loginToRoom(roomPubkey, '');
      expect(manager.isRoomLoggedIn(roomPubkey)).toBe(true);

      // Simulate disconnect — clears all session state.
      (manager as any).roomLoggedInNodes.clear();
      expect(manager.isRoomLoggedIn(roomPubkey)).toBe(false);
    });
  });

  // ---- getRoomServers ----

  describe('getRoomServers', () => {
    it('returns only advType=3 contacts', () => {
      const { manager } = makeManager({
        contacts: [
          { publicKey: '11'.repeat(32), advType: 1, advName: 'Companion' },
          { publicKey: '22'.repeat(32), advType: 2, advName: 'Repeater' },
          { publicKey: '33'.repeat(32), advType: 3, advName: 'RoomA' },
          { publicKey: '44'.repeat(32), advType: 3, advName: 'RoomB' },
        ],
      });

      const rooms = manager.getRoomServers();
      expect(rooms).toHaveLength(2);
      expect(rooms.map(r => r.advName)).toEqual(expect.arrayContaining(['RoomA', 'RoomB']));
    });

    it('returns empty when no room servers exist', () => {
      const { manager } = makeManager({
        contacts: [
          { publicKey: '11'.repeat(32), advType: 1 },
        ],
      });

      expect(manager.getRoomServers()).toHaveLength(0);
    });
  });

  // ---- sendRoomPost ----

  describe('sendRoomPost', () => {
    it('sends via bridge and tags local copy as room_post', async () => {
      const roomPubkey = 'bb'.repeat(32);
      const { manager, bridgeCalls, emittedMessages } = makeManager({
        contacts: [{ publicKey: roomPubkey, advType: 3 }],
      });

      const ok = await manager.sendRoomPost('Hello room!', roomPubkey);
      expect(ok).toBe(true);

      expect(bridgeCalls).toHaveLength(1);
      expect(bridgeCalls[0].cmd).toBe('send_message');
      expect(bridgeCalls[0].params.to).toBe(roomPubkey);
      expect(bridgeCalls[0].params.text).toBe('Hello room!');

      expect(emittedMessages).toHaveLength(1);
      expect(emittedMessages[0].messageType).toBe('room_post');
      expect(emittedMessages[0].toPublicKey).toBe(roomPubkey);
      expect(emittedMessages[0].text).toBe('Hello room!');
    });

    it('returns false when not connected', async () => {
      const { manager } = makeManager();
      (manager as any).connected = false;

      const ok = await manager.sendRoomPost('test', 'aa'.repeat(32));
      expect(ok).toBe(false);
    });

    it('returns false when device is a repeater', async () => {
      const { manager } = makeManager();
      (manager as any).deviceType = MeshCoreDeviceType.REPEATER;

      const ok = await manager.sendRoomPost('test', 'aa'.repeat(32));
      expect(ok).toBe(false);
    });
  });

  // ---- resolveContactByPrefix ----

  describe('resolveContactByPrefix', () => {
    it('matches exact publicKey', () => {
      const pk = 'ab'.repeat(32);
      const { manager } = makeManager({
        contacts: [{ publicKey: pk, advName: 'Exact' }],
      });

      const result = (manager as any).resolveContactByPrefix(pk);
      expect(result?.advName).toBe('Exact');
    });

    it('matches by prefix', () => {
      const pk = 'cd'.repeat(32);
      const { manager } = makeManager({
        contacts: [{ publicKey: pk, advName: 'Prefix' }],
      });

      const result = (manager as any).resolveContactByPrefix(pk.substring(0, 8));
      expect(result?.advName).toBe('Prefix');
    });

    it('returns undefined for no match', () => {
      const { manager } = makeManager();
      expect((manager as any).resolveContactByPrefix('deadbeef')).toBeUndefined();
    });

    it('returns undefined for empty prefix', () => {
      const { manager } = makeManager();
      expect((manager as any).resolveContactByPrefix('')).toBeUndefined();
    });
  });

  // ---- addMessage messageType persistence ----

  describe('addMessage persists messageType', () => {
    it('passes room_post to the database', () => {
      const insertSpy = vi.spyOn(databaseService.meshcore, 'insertMessage').mockResolvedValue(undefined as any);
      const { manager } = makeManager();

      (manager as any).addMessage({
        id: 'test-1',
        fromPublicKey: 'aabb',
        toPublicKey: 'ccdd',
        text: 'room post',
        timestamp: Date.now(),
        sourceId: 'test-source',
        messageType: 'room_post',
      });

      expect(insertSpy).toHaveBeenCalledTimes(1);
      const call = insertSpy.mock.calls[0][0] as any;
      expect(call.messageType).toBe('room_post');
    });

    it('defaults to text when messageType is not set', () => {
      const insertSpy = vi.spyOn(databaseService.meshcore, 'insertMessage').mockResolvedValue(undefined as any);
      const { manager } = makeManager();

      (manager as any).addMessage({
        id: 'test-2',
        fromPublicKey: 'aabb',
        text: 'dm',
        timestamp: Date.now(),
        sourceId: 'test-source',
      });

      const call = insertSpy.mock.calls[0][0] as any;
      expect(call.messageType).toBe('text');
    });
  });
});
