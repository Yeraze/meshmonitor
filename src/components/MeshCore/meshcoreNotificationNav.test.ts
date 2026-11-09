import { describe, it, expect } from 'vitest';
import { resolveMeshCoreNotificationTarget } from './meshcoreNotificationNav';

const ROOM = 'aa'.repeat(32);
const PEER = 'bb'.repeat(32);
const contacts = [
  { publicKey: ROOM, advType: 3 },
  { publicKey: PEER, advType: 1 },
];

describe('resolveMeshCoreNotificationTarget', () => {
  it('opens a channel by index, including slots above 7', () => {
    expect(resolveMeshCoreNotificationTarget({ type: 'channel', channelId: 12 }, contacts))
      .toEqual({ kind: 'channel', channelIdx: 12 });
  });

  it('opens the Rooms view for a room key', () => {
    expect(resolveMeshCoreNotificationTarget({ type: 'dm', senderNodeId: ROOM }, contacts))
      .toEqual({ kind: 'room', publicKey: ROOM });
  });

  it('opens the DM for a peer, resolving a 12-hex prefix to the full key', () => {
    expect(resolveMeshCoreNotificationTarget({ type: 'dm', senderNodeId: PEER.slice(0, 12) }, contacts))
      .toEqual({ kind: 'dm', publicKey: PEER });
  });

  it('does nothing without a target', () => {
    expect(resolveMeshCoreNotificationTarget({ type: 'dm' }, contacts)).toEqual({ kind: 'none' });
    expect(resolveMeshCoreNotificationTarget({ type: 'channel' }, contacts)).toEqual({ kind: 'none' });
  });
});
