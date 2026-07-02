/**
 * Tests for the MeshCore unread-marker store (#3891) — the pure unread
 * computation and the localStorage-backed read markers that drive the sidebar
 * red-dots and per-contact DM dots.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  canonicalizePeerKey,
  computeUnreadDmPeers,
  markChannelRead,
  loadChannelLastRead,
  markDmRead,
  loadDmLastRead,
} from './meshcoreUnreadStore';

const SELF = 'a'.repeat(64);
const PEER1 = 'b'.repeat(64);
const PEER2 = 'c'.repeat(64);
const contacts = [{ publicKey: SELF }, { publicKey: PEER1 }, { publicKey: PEER2 }];

function dm(from: string, to: string, timestamp: number, extra: Record<string, unknown> = {}) {
  return { fromPublicKey: from, toPublicKey: to, timestamp, ...extra };
}

describe('canonicalizePeerKey', () => {
  it('resolves a pubkey prefix to the full contact key', () => {
    expect(canonicalizePeerKey(PEER1.substring(0, 12), contacts)).toBe(PEER1);
  });
  it('returns an exact key unchanged', () => {
    expect(canonicalizePeerKey(PEER2, contacts)).toBe(PEER2);
  });
  it('returns an unknown key unchanged', () => {
    expect(canonicalizePeerKey('deadbeef', [])).toBe('deadbeef');
  });
});

describe('computeUnreadDmPeers', () => {
  it('flags a peer whose latest incoming message is newer than the last-read marker', () => {
    const messages = [dm(PEER1, SELF, 100)];
    const unread = computeUnreadDmPeers({ messages, contacts, selfKey: SELF, dmLastRead: {} });
    expect(unread.has(PEER1)).toBe(true);
  });

  it('does NOT flag own outgoing messages', () => {
    const messages = [dm(SELF, PEER1, 100)];
    const unread = computeUnreadDmPeers({ messages, contacts, selfKey: SELF, dmLastRead: {} });
    expect(unread.size).toBe(0);
  });

  it('respects the last-read marker', () => {
    const messages = [dm(PEER1, SELF, 100)];
    const unread = computeUnreadDmPeers({ messages, contacts, selfKey: SELF, dmLastRead: { [PEER1]: 100 } });
    expect(unread.has(PEER1)).toBe(false);
  });

  it('never flags the currently-open peer', () => {
    const messages = [dm(PEER1, SELF, 100)];
    const unread = computeUnreadDmPeers({ messages, contacts, selfKey: SELF, dmLastRead: {}, activePeerKey: PEER1 });
    expect(unread.has(PEER1)).toBe(false);
  });

  it('canonicalizes a prefixed sender so it matches the read marker', () => {
    const messages = [dm(PEER1.substring(0, 12), SELF, 100)];
    const unread = computeUnreadDmPeers({ messages, contacts, selfKey: SELF, dmLastRead: { [PEER1]: 100 } });
    expect(unread.has(PEER1)).toBe(false);
  });

  it('ignores channel pseudo-keys and room posts', () => {
    const messages = [
      dm('channel-0', SELF, 100),
      dm(PEER2, SELF, 100, { messageType: 'room_post' }),
    ];
    const unread = computeUnreadDmPeers({ messages, contacts, selfKey: SELF, dmLastRead: {} });
    expect(unread.size).toBe(0);
  });

  it('reports nothing when the local key is unknown (can not tell sent from received)', () => {
    const messages = [dm(PEER1, SELF, 100)];
    const unread = computeUnreadDmPeers({ messages, contacts, selfKey: undefined, dmLastRead: {} });
    expect(unread.size).toBe(0);
  });

  it('tracks multiple unread peers independently', () => {
    const messages = [dm(PEER1, SELF, 100), dm(PEER2, SELF, 200)];
    const unread = computeUnreadDmPeers({ messages, contacts, selfKey: SELF, dmLastRead: { [PEER1]: 150 } });
    expect(unread.has(PEER1)).toBe(false); // read past 100
    expect(unread.has(PEER2)).toBe(true);
  });
});

describe('read markers (localStorage round-trip)', () => {
  beforeEach(() => localStorage.clear());

  it('persists and reloads channel markers, never moving backwards', () => {
    markChannelRead('src1', 0, 500);
    expect(loadChannelLastRead('src1')[0]).toBe(500);
    markChannelRead('src1', 0, 300); // older — ignored
    expect(loadChannelLastRead('src1')[0]).toBe(500);
    markChannelRead('src1', 0, 900);
    expect(loadChannelLastRead('src1')[0]).toBe(900);
  });

  it('scopes markers by sourceId', () => {
    markChannelRead('src1', 0, 500);
    expect(loadChannelLastRead('src2')[0]).toBeUndefined();
  });

  it('persists and reloads DM markers per peer', () => {
    markDmRead('src1', PEER1, 500);
    markDmRead('src1', PEER2, 700);
    const map = loadDmLastRead('src1');
    expect(map[PEER1]).toBe(500);
    expect(map[PEER2]).toBe(700);
  });
});
