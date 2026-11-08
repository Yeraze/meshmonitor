/**
 * @vitest-environment jsdom
 *
 * Room unread + batch mark-read in the MeshCore unread store (#6261).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  configureReadStateTransport,
  hydrateReadState,
  resetReadStateCache,
  loadRoomLastRead,
  loadChannelLastRead,
  loadDmLastRead,
  markRoomRead,
  markManyRead,
  subscribeUnreadChanged,
  computeUnreadRooms,
  latestIncomingDmByPeer,
  roomLastReadKey,
} from './meshcoreUnreadStore';

const SRC = 'source-a';
const SELF = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const ROOM = 'c'.repeat(64);
const ROOM2 = 'd'.repeat(64);
const rooms = [{ publicKey: ROOM }, { publicKey: ROOM2 }];

beforeEach(() => {
  localStorage.clear();
  resetReadStateCache();
  configureReadStateTransport(null);
});

describe('room markers', () => {
  it('marks a room read, monotonic, in its own storage key', () => {
    markRoomRead(SRC, ROOM, 5000);
    markRoomRead(SRC, ROOM, 100);
    expect(loadRoomLastRead(SRC)[ROOM]).toBe(5000);
    expect(JSON.parse(localStorage.getItem(roomLastReadKey(SRC))!)).toEqual({ [ROOM]: 5000 });
    expect(loadDmLastRead(SRC)).toEqual({});
  });

  it('hydrates room markers from the server and pushes writes', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    configureReadStateTransport({
      load: vi.fn().mockResolvedValue({ meshcore_channel: {}, meshcore_dm: {}, meshcore_room: { [ROOM]: 7000 } }),
      save,
    });
    await hydrateReadState(SRC);
    expect(loadRoomLastRead(SRC)[ROOM]).toBe(7000);
    markRoomRead(SRC, ROOM2, 9000);
    expect(save).toHaveBeenCalledWith(SRC, 'meshcore_room', ROOM2, 9000);
    expect(loadRoomLastRead(SRC)[ROOM2]).toBe(9000);
  });

  it('notifies on a room storage event', () => {
    const cb = vi.fn();
    const off = subscribeUnreadChanged(cb);
    window.dispatchEvent(new StorageEvent('storage', { key: roomLastReadKey(SRC) }));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('markManyRead', () => {
  const entries = [
    { kind: 'meshcore_channel' as const, key: '1', ts: 1000 },
    { kind: 'meshcore_dm' as const, key: PEER, ts: 2000 },
    { kind: 'meshcore_room' as const, key: ROOM, ts: 3000 },
  ];

  it('writes every kind locally with one change event', () => {
    const cb = vi.fn();
    const off = subscribeUnreadChanged(cb);
    markManyRead(SRC, entries);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(loadChannelLastRead(SRC)[1]).toBe(1000);
    expect(loadDmLastRead(SRC)[PEER]).toBe(2000);
    expect(loadRoomLastRead(SRC)[ROOM]).toBe(3000);
  });

  it('is monotonic and skips unchanged entries', () => {
    markRoomRead(SRC, ROOM, 9000);
    const cb = vi.fn();
    const off = subscribeUnreadChanged(cb);
    markManyRead(SRC, [{ kind: 'meshcore_room', key: ROOM, ts: 10 }]);
    expect(cb).not.toHaveBeenCalled();
    off();
    expect(loadRoomLastRead(SRC)[ROOM]).toBe(9000);
  });

  it('calls saveMany once with only the changed entries', () => {
    const saveMany = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn().mockResolvedValue(undefined);
    configureReadStateTransport({ load: vi.fn(), save, saveMany });
    markManyRead(SRC, entries);
    expect(saveMany).toHaveBeenCalledTimes(1);
    expect(saveMany).toHaveBeenCalledWith(SRC, [
      { kind: 'meshcore_channel', conversationKey: '1', lastReadAt: 1000 },
      { kind: 'meshcore_dm', conversationKey: PEER, lastReadAt: 2000 },
      { kind: 'meshcore_room', conversationKey: ROOM, lastReadAt: 3000 },
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  it('falls back to one save per entry without saveMany', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    configureReadStateTransport({ load: vi.fn(), save });
    markManyRead(SRC, entries);
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledWith(SRC, 'meshcore_room', ROOM, 3000);
  });

  it('survives a rejected transport write', () => {
    configureReadStateTransport({ load: vi.fn(), save: vi.fn(), saveMany: vi.fn().mockRejectedValue(new Error('x')) });
    expect(() => markManyRead(SRC, entries)).not.toThrow();
  });
});

describe('computeUnreadRooms', () => {
  const post = (over: Record<string, unknown> = {}) => ({
    fromPublicKey: PEER, toPublicKey: ROOM, timestamp: 1, receivedAt: 5000, messageType: 'room_post', ...over,
  });
  const base = { messages: [] as any[], roomStats: [] as any[], rooms, selfKey: SELF, roomLastRead: {} as Record<string, number> };

  it('flags a room from the server latestReceivedAt', () => {
    const out = computeUnreadRooms({ ...base, roomStats: [{ roomPublicKey: ROOM, latestReceivedAt: 5000 }] });
    expect([...out]).toEqual([ROOM]);
  });

  it('flags a room from a live-pool post by receipt time, not sender time', () => {
    expect(computeUnreadRooms({ ...base, messages: [post()], roomLastRead: { [ROOM]: 4000 } }).has(ROOM)).toBe(true);
    // Sender time is far newer than the marker, receipt is older: read.
    expect(computeUnreadRooms({ ...base, messages: [post({ timestamp: 99999, receivedAt: 3000 })], roomLastRead: { [ROOM]: 4000 } }).size).toBe(0);
  });

  it('server and live latest: the larger wins', () => {
    const out = computeUnreadRooms({
      ...base,
      roomStats: [{ roomPublicKey: ROOM, latestReceivedAt: 2000 }],
      messages: [post({ receivedAt: 6000 })],
      roomLastRead: { [ROOM]: 5000 },
    });
    expect(out.has(ROOM)).toBe(true);
  });

  it('ignores own posts, reactions and filtered rows in the live pool', () => {
    const messages = [
      post({ fromPublicKey: SELF }),
      post({ reactionEmoji: '👍' }),
      post({ filtered: 'ignored' }),
    ];
    expect(computeUnreadRooms({ ...base, messages }).size).toBe(0);
  });

  it('ignores non room_post rows', () => {
    expect(computeUnreadRooms({ ...base, messages: [post({ messageType: undefined })] }).size).toBe(0);
  });

  it('matches stored prefix keys to the full room key', () => {
    const out = computeUnreadRooms({
      ...base,
      roomStats: [{ roomPublicKey: ROOM.slice(0, 12), latestReceivedAt: 5000 }],
      messages: [post({ toPublicKey: ROOM2.slice(0, 12) })],
    });
    expect([...out].sort()).toEqual([ROOM, ROOM2].sort());
  });

  it('skips the active room and muted rooms', () => {
    const roomStats = [{ roomPublicKey: ROOM, latestReceivedAt: 5000 }, { roomPublicKey: ROOM2, latestReceivedAt: 5000 }];
    const out = computeUnreadRooms({ ...base, roomStats, activeRoomKey: ROOM, isMuted: (k) => k === ROOM2 });
    expect(out.size).toBe(0);
  });

  it('is not unread once the marker catches up', () => {
    const roomStats = [{ roomPublicKey: ROOM, latestReceivedAt: 5000 }];
    expect(computeUnreadRooms({ ...base, roomStats, roomLastRead: { [ROOM]: 5000 } }).size).toBe(0);
  });
});

describe('latestIncomingDmByPeer', () => {
  it('returns the newest received DM per canonical peer and nothing without selfKey', () => {
    const contacts = [{ publicKey: PEER }];
    const messages = [
      { fromPublicKey: PEER.slice(0, 12), toPublicKey: SELF, timestamp: 1, receivedAt: 3000 },
      { fromPublicKey: PEER, toPublicKey: SELF, timestamp: 1, receivedAt: 2000 },
      { fromPublicKey: SELF, toPublicKey: PEER, timestamp: 1, receivedAt: 9000 },
    ];
    expect(latestIncomingDmByPeer({ messages, contacts, selfKey: SELF }).get(PEER)).toBe(3000);
    expect(latestIncomingDmByPeer({ messages, contacts, selfKey: undefined }).size).toBe(0);
  });
});
