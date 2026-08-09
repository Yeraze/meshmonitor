import { describe, it, expect } from 'vitest';
import { resolveUnreadAnchorId, shouldSuppressDivider } from './unreadAnchor.js';

const msgs = (...pairs: Array<[string, number]>) =>
  pairs.map(([id, sortTime]) => ({ id, sortTime }));

describe('resolveUnreadAnchorId (#4607)', () => {
  it('returns null without a watermark', () => {
    expect(resolveUnreadAnchorId({
      messages: msgs(['a', 1], ['b', 2]),
      watermarkMs: null,
      mode: 'lastRead',
    })).toBeNull();
    expect(resolveUnreadAnchorId({
      messages: msgs(['a', 1]),
      watermarkMs: Number.NaN,
      mode: 'lastRead',
    })).toBeNull();
  });

  it('returns null for an empty conversation', () => {
    expect(resolveUnreadAnchorId({ messages: [], watermarkMs: 5, mode: 'lastRead' })).toBeNull();
  });

  describe("mode 'lastRead' (MeshCore — watermark is the last message SEEN)", () => {
    it('anchors on the first message strictly newer than the watermark', () => {
      expect(resolveUnreadAnchorId({
        messages: msgs(['a', 1000], ['b', 2000], ['c', 3000]),
        watermarkMs: 2000,
        mode: 'lastRead',
      })).toBe('c');
    });

    it('does NOT anchor on a message exactly at the watermark — that one was read', () => {
      expect(resolveUnreadAnchorId({
        messages: msgs(['a', 1000], ['b', 2000]),
        watermarkMs: 2000,
        mode: 'lastRead',
      })).toBeNull();
    });

    it('anchors on the very first message when the watermark predates everything', () => {
      expect(resolveUnreadAnchorId({
        messages: msgs(['a', 1000], ['b', 2000]),
        watermarkMs: 0,
        mode: 'lastRead',
      })).toBe('a');
    });
  });

  describe("mode 'firstUnread' (Meshtastic — watermark IS the oldest unread message)", () => {
    it('anchors on the message at the watermark, inclusive', () => {
      expect(resolveUnreadAnchorId({
        messages: msgs(['a', 1000], ['b', 2000], ['c', 3000]),
        watermarkMs: 2000,
        mode: 'firstUnread',
      })).toBe('b');
    });

    it('falls forward when the exact watermark row is not loaded', () => {
      // The server computed the anchor from a row the client filtered out
      // (hidden MQTT, a reaction). The line still lands at the right boundary
      // rather than disappearing.
      expect(resolveUnreadAnchorId({
        messages: msgs(['a', 1000], ['c', 3000]),
        watermarkMs: 2000,
        mode: 'firstUnread',
      })).toBe('c');
    });

    it('returns null when everything loaded predates the watermark', () => {
      expect(resolveUnreadAnchorId({
        messages: msgs(['a', 1000]),
        watermarkMs: 5000,
        mode: 'firstUnread',
      })).toBeNull();
    });
  });

  it('skips the operator\'s own messages when picking the anchor', () => {
    // Our own outgoing message is never "unread" — anchoring on it would put
    // the line above something we just typed.
    expect(resolveUnreadAnchorId({
      messages: msgs(['mine', 2500], ['theirs', 2600]),
      watermarkMs: 2000,
      mode: 'lastRead',
      ownMessageIds: new Set(['mine']),
    })).toBe('theirs');
  });

  it('returns null when every unread message is our own', () => {
    expect(resolveUnreadAnchorId({
      messages: msgs(['mine1', 2500], ['mine2', 2600]),
      watermarkMs: 2000,
      mode: 'lastRead',
      ownMessageIds: new Set(['mine1', 'mine2']),
    })).toBeNull();
  });
});

describe('shouldSuppressDivider (#4607)', () => {
  it('suppresses when there is no anchor', () => {
    expect(shouldSuppressDivider({ anchorId: null, messages: msgs(['a', 1]) })).toBe(true);
  });

  it('suppresses a line above the very first message of a fully-loaded thread', () => {
    // "Everything is new" in a thread you have never opened is not information.
    expect(shouldSuppressDivider({
      anchorId: 'a',
      messages: msgs(['a', 1], ['b', 2]),
      hasMoreOlder: false,
    })).toBe(true);
  });

  it('keeps the line at the top when older history exists but is not loaded', () => {
    // There genuinely are read messages above; they just have not been paged in.
    expect(shouldSuppressDivider({
      anchorId: 'a',
      messages: msgs(['a', 1], ['b', 2]),
      hasMoreOlder: true,
    })).toBe(false);
  });

  it('keeps the line when the anchor is mid-conversation', () => {
    expect(shouldSuppressDivider({
      anchorId: 'b',
      messages: msgs(['a', 1], ['b', 2]),
      hasMoreOlder: false,
    })).toBe(false);
  });
});
