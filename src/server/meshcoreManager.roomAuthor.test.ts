/**
 * Room-post author handling in the manager (#5774). The backend now sends the
 * real 8-hex author prefix; the manager must store it, resolve it to the
 * contact, and store an unreadable author as 'unknown' (never a key-shaped
 * garbage string).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);
const insertMessage = vi.fn().mockResolvedValue(true);
const updateLastRoomPostAt = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...a: unknown[]) => upsertNode(...a),
      insertMessage: (...a: unknown[]) => insertMessage(...a),
      updateLastRoomPostAt: (...a: unknown[]) => updateLastRoomPostAt(...a),
    },
    sources: { getSource: vi.fn().mockResolvedValue({ name: 'Source A' }) },
    getSettingAsync: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: { notifyNewMeshCoreNode: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreContactUpdated: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreSelfInfoUpdated: vi.fn(),
  },
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const ROOM_KEY = '010203040506' + 'b'.repeat(52);
const AUTHOR_KEY = '6ab2c4d8' + 'c'.repeat(56);

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const m = new MeshCoreManager('src-a');
  // @ts-expect-error - private
  m.contacts.set(ROOM_KEY, { publicKey: ROOM_KEY, advName: 'Room', advType: MeshCoreDeviceType.ROOM_SERVER });
  // @ts-expect-error - private
  m.contacts.set(AUTHOR_KEY, { publicKey: AUTHOR_KEY, advName: 'Alice', advType: MeshCoreDeviceType.COMPANION });
  const seen: any[] = [];
  m.on('message', (msg) => seen.push(msg));
  return { m, seen };
}

function roomPost(m: MeshCoreManager, author: string): void {
  // @ts-expect-error - private bridge-event path
  m.handleBridgeEvent({
    event_type: 'room_message',
    data: {
      room_pubkey_prefix: '010203040506',
      author_pubkey_prefix: author,
      text: 'hello',
      sender_timestamp: Math.floor(Date.now() / 1000),
    },
  });
}

describe('room post author (#5774)', () => {
  beforeEach(() => {
    insertMessage.mockClear();
  });

  it('stores the exact prefix resolved to the contact key and name', async () => {
    const { m, seen } = setup();
    roomPost(m, '6ab2c4d8');
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].fromPublicKey).toBe(AUTHOR_KEY);
    expect(seen[0].fromName).toBe('Alice');
    expect(insertMessage.mock.calls[0][0]).toEqual(
      expect.objectContaining({ fromPublicKey: AUTHOR_KEY, toPublicKey: ROOM_KEY, messageType: 'room_post' }),
    );
  });

  it('keeps an unresolved but valid prefix as the key', async () => {
    const { m, seen } = setup();
    roomPost(m, 'E19CA7F0');
    await flush();
    expect(seen[0].fromPublicKey).toBe('e19ca7f0');
  });

  it.each(['', 'fffdfffdfffd', '6afffdfffdfffd', 'zz'])(
    'stores an unreadable author (%j) as unknown, never as a key-shaped string',
    async (author) => {
      const { m, seen } = setup();
      roomPost(m, author);
      await flush();
      expect(seen[0].fromPublicKey).toBe('unknown');
      expect(seen[0].fromName).toBeUndefined();
      expect(upsertNode).not.toHaveBeenCalled();
    },
  );
});
