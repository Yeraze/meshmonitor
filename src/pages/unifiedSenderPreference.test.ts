/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  UNIFIED_SENDER_STORAGE_KEY,
  readStoredUnifiedSender,
  resolveUnifiedSender,
  writeStoredUnifiedSender,
} from './unifiedSenderPreference';
import type { SenderRef } from './unifiedSendRequest';

const ref = (sourceId: string, canSend = true): SenderRef => ({
  sourceId,
  sourceName: sourceId,
  channelNumber: 0,
  canSend,
  sendKind: 'meshtastic',
  sendBlockedReason: null,
});

describe('unified sender preference (#3045 P2)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips per channel and keeps channels independent', () => {
    writeStoredUnifiedSender('#Public', 'a');
    writeStoredUnifiedSender('#test', 'b');
    expect(readStoredUnifiedSender('#Public')).toBe('a');
    expect(readStoredUnifiedSender('#test')).toBe('b');
    expect(readStoredUnifiedSender('other')).toBeNull();
  });

  it('reads corrupt JSON as null', () => {
    localStorage.setItem(UNIFIED_SENDER_STORAGE_KEY, '{nope');
    expect(readStoredUnifiedSender('#Public')).toBeNull();
    localStorage.setItem(UNIFIED_SENDER_STORAGE_KEY, '[1]');
    expect(readStoredUnifiedSender('#Public')).toBeNull();
  });

  it('survives a storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(readStoredUnifiedSender('#Public')).toBeNull();
    expect(() => writeStoredUnifiedSender('#Public', 'a')).not.toThrow();
  });

  describe('resolveUnifiedSender', () => {
    it('keeps the stored node when it is eligible', () => {
      expect(resolveUnifiedSender([ref('a'), ref('b')], 'b')?.sourceId).toBe('b');
    });
    it('falls back to the first eligible when the stored node cannot send', () => {
      expect(resolveUnifiedSender([ref('a'), ref('b', false)], 'b')?.sourceId).toBe('a');
    });
    it('falls back to the first eligible when the stored id is missing', () => {
      expect(resolveUnifiedSender([ref('a'), ref('b')], 'zzz')?.sourceId).toBe('a');
      expect(resolveUnifiedSender([ref('a'), ref('b')], null)?.sourceId).toBe('a');
    });
    it('returns null when none is eligible', () => {
      expect(resolveUnifiedSender([], 'a')).toBeNull();
      expect(resolveUnifiedSender([ref('a', false)], 'a')).toBeNull();
    });
  });
});
