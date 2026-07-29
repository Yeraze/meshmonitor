/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  readNodeDisplayLocal,
  writeNodeDisplayLocal,
  purgeLegacyNodeDisplayLocal,
} from './nodeDisplayStorage';
import { NODE_DISPLAY_SETTING_KEYS } from '../constants/nodeDisplayDefaults';

describe('nodeDisplayStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('key namespacing', () => {
    it('writes under nodeDisplay:{sourceId}:{key}', () => {
      writeNodeDisplayLocal('source-a', 'maxNodeAgeHours', '72');
      expect(localStorage.getItem('nodeDisplay:source-a:maxNodeAgeHours')).toBe('72');
    });

    it('reads back what was written for the same source', () => {
      writeNodeDisplayLocal('source-a', 'maxNodeAgeHours', '72');
      expect(readNodeDisplayLocal('source-a', 'maxNodeAgeHours')).toBe('72');
    });

    it('a value written under one source is not visible under another', () => {
      writeNodeDisplayLocal('source-a', 'maxNodeAgeHours', '72');
      expect(readNodeDisplayLocal('source-b', 'maxNodeAgeHours')).toBeNull();
    });

    it('an unset key reads null', () => {
      expect(readNodeDisplayLocal('source-a', 'maxNodeAgeHours')).toBeNull();
    });
  });

  describe('sourceId === null', () => {
    it('read returns null', () => {
      expect(readNodeDisplayLocal(null, 'maxNodeAgeHours')).toBeNull();
    });

    it('write is a no-op — no key is created in storage', () => {
      writeNodeDisplayLocal(null, 'maxNodeAgeHours', '72');
      expect(localStorage.length).toBe(0);
    });
  });

  describe('purgeLegacyNodeDisplayLocal', () => {
    it('removes exactly the ten bare legacy keys', () => {
      for (const key of NODE_DISPLAY_SETTING_KEYS) {
        localStorage.setItem(key, 'stale');
      }
      // A namespaced key and an unrelated bare key must survive the purge.
      localStorage.setItem('nodeDisplay:source-a:maxNodeAgeHours', '72');
      localStorage.setItem('someUnrelatedKey', 'keep-me');

      purgeLegacyNodeDisplayLocal();

      for (const key of NODE_DISPLAY_SETTING_KEYS) {
        expect(localStorage.getItem(key)).toBeNull();
      }
      expect(localStorage.getItem('nodeDisplay:source-a:maxNodeAgeHours')).toBe('72');
      expect(localStorage.getItem('someUnrelatedKey')).toBe('keep-me');
    });

    it('is idempotent — calling it twice does not throw', () => {
      purgeLegacyNodeDisplayLocal();
      expect(() => purgeLegacyNodeDisplayLocal()).not.toThrow();
    });
  });

  describe('a throwing localStorage does not propagate', () => {
    it('read swallows the error and returns null', () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError: private mode');
      });
      expect(() => readNodeDisplayLocal('source-a', 'maxNodeAgeHours')).not.toThrow();
      expect(readNodeDisplayLocal('source-a', 'maxNodeAgeHours')).toBeNull();
      spy.mockRestore();
    });

    it('write swallows the error', () => {
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('SecurityError: private mode');
      });
      expect(() => writeNodeDisplayLocal('source-a', 'maxNodeAgeHours', '72')).not.toThrow();
      spy.mockRestore();
    });

    it('purge swallows the error', () => {
      const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('SecurityError: private mode');
      });
      expect(() => purgeLegacyNodeDisplayLocal()).not.toThrow();
      spy.mockRestore();
    });
  });
});
