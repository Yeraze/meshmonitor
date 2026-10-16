/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  UNIFIED_CHANNEL_STORAGE_KEY,
  readStoredUnifiedChannel,
  resolveInitialUnifiedChannel,
  writeStoredUnifiedChannel,
} from './unifiedChannelPreference';

describe('unified channel preference (#5792)', () => {
  beforeEach(() => localStorage.clear());

  describe('resolveInitialUnifiedChannel', () => {
    const names = ['#Public', 'LongFast', '#test'];

    it('keeps the built-in default when nothing is stored', () => {
      expect(resolveInitialUnifiedChannel(names, null)).toBe('LongFast');
      expect(resolveInitialUnifiedChannel(['#Public', '#test'], null)).toBe('#Public');
    });

    it('restores All Channels', () => {
      expect(resolveInitialUnifiedChannel(names, '__all__')).toBe('__all__');
    });

    it('restores a stored channel that still exists', () => {
      expect(resolveInitialUnifiedChannel(names, '#test')).toBe('#test');
    });

    it('falls back to the default when the stored channel no longer exists', () => {
      expect(resolveInitialUnifiedChannel(names, '#gone')).toBe('LongFast');
    });

    it('returns empty for an empty channel list', () => {
      expect(resolveInitialUnifiedChannel([], '__all__')).toBe('');
    });
  });

  describe('storage', () => {
    it('round-trips through localStorage', () => {
      expect(readStoredUnifiedChannel()).toBeNull();
      writeStoredUnifiedChannel('__all__');
      expect(localStorage.getItem(UNIFIED_CHANNEL_STORAGE_KEY)).toBe('__all__');
      expect(readStoredUnifiedChannel()).toBe('__all__');
    });

    it('swallows storage errors', () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      expect(readStoredUnifiedChannel()).toBeNull();
      expect(() => writeStoredUnifiedChannel('x')).not.toThrow();
      spy.mockRestore();
      setSpy.mockRestore();
    });
  });
});
