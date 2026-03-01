import { describe, it, expect } from 'vitest';
import { splitTriggerPatterns, normalizeTriggerPatterns, normalizeTriggerChannels } from './autoResponderUtils';

describe('autoResponderUtils', () => {
  describe('splitTriggerPatterns', () => {
    it('should split simple comma-separated patterns', () => {
      const result = splitTriggerPatterns('hello,hi,hey');
      expect(result).toEqual(['hello', 'hi', 'hey']);
    });

    it('should trim whitespace from patterns', () => {
      const result = splitTriggerPatterns('hello , hi , hey');
      expect(result).toEqual(['hello', 'hi', 'hey']);
    });

    it('should handle patterns with parameters', () => {
      const result = splitTriggerPatterns('hello,hi {name},hey {name}');
      expect(result).toEqual(['hello', 'hi {name}', 'hey {name}']);
    });

    it('should not split commas inside braces', () => {
      const result = splitTriggerPatterns('weather {city, state}');
      expect(result).toEqual(['weather {city, state}']);
    });

    it('should handle nested braces', () => {
      const result = splitTriggerPatterns('test {a {b}},other');
      expect(result).toEqual(['test {a {b}}', 'other']);
    });

    it('should return empty array for empty string', () => {
      const result = splitTriggerPatterns('');
      expect(result).toEqual([]);
    });

    it('should return empty array for whitespace-only string', () => {
      const result = splitTriggerPatterns('   ');
      expect(result).toEqual([]);
    });

    it('should handle single pattern without commas', () => {
      const result = splitTriggerPatterns('hello');
      expect(result).toEqual(['hello']);
    });

    it('should handle pattern with only parameters', () => {
      const result = splitTriggerPatterns('{name}');
      expect(result).toEqual(['{name}']);
    });
  });

  describe('normalizeTriggerPatterns', () => {
    it('should handle string triggers', () => {
      const result = normalizeTriggerPatterns('hello,hi');
      expect(result).toEqual(['hello', 'hi']);
    });

    it('should handle array triggers', () => {
      const result = normalizeTriggerPatterns(['hello', 'hi']);
      expect(result).toEqual(['hello', 'hi']);
    });

    it('should handle single-element array', () => {
      const result = normalizeTriggerPatterns(['hello']);
      expect(result).toEqual(['hello']);
    });

    it('should handle empty array', () => {
      const result = normalizeTriggerPatterns([]);
      expect(result).toEqual([]);
    });

    it('should handle array with patterns containing parameters', () => {
      const result = normalizeTriggerPatterns(['hello', 'hi {name}', 'weather {city, state}']);
      expect(result).toEqual(['hello', 'hi {name}', 'weather {city, state}']);
    });

    it('should handle string with complex patterns', () => {
      const result = normalizeTriggerPatterns('hello,hi {name},weather {city, state}');
      expect(result).toEqual(['hello', 'hi {name}', 'weather {city, state}']);
    });
  });

  describe('Edge Cases', () => {
    it('should handle pattern with trailing comma', () => {
      const result = splitTriggerPatterns('hello,hi,');
      expect(result).toEqual(['hello', 'hi']);
    });

    it('should handle pattern with leading comma', () => {
      const result = splitTriggerPatterns(',hello,hi');
      expect(result).toEqual(['hello', 'hi']);
    });

    it('should handle multiple consecutive commas', () => {
      const result = splitTriggerPatterns('hello,,hi');
      expect(result).toEqual(['hello', 'hi']);
    });

    it('should handle unmatched opening brace', () => {
      const result = splitTriggerPatterns('hello {name,hi');
      expect(result).toEqual(['hello {name,hi']);
    });

    it('should handle unmatched closing brace', () => {
      // Unmatched closing brace causes negative depth, preventing comma from splitting
      const result = splitTriggerPatterns('hello name},hi');
      // The closing brace doesn't have a matching opening brace, so depth goes negative (-1)
      // When the comma is encountered, braceDepth !== 0, so it doesn't split
      expect(result).toEqual(['hello name},hi']);
    });
  });

  describe('normalizeTriggerChannels', () => {
    it('should handle new channels array format', () => {
      const trigger = { channels: [0, 'dm'] as Array<number | 'dm' | 'none'> };
      expect(normalizeTriggerChannels(trigger)).toEqual([0, 'dm']);
    });

    it('should handle channels array with none', () => {
      const trigger = { channels: ['none'] as Array<number | 'dm' | 'none'> };
      expect(normalizeTriggerChannels(trigger)).toEqual(['none']);
    });

    it('should handle multi-channel array', () => {
      const trigger = { channels: [0, 1, 2] as Array<number | 'dm' | 'none'> };
      expect(normalizeTriggerChannels(trigger)).toEqual([0, 1, 2]);
    });

    it('should migrate old single channel number', () => {
      const trigger = { channel: 2 as number | 'dm' | 'none' };
      expect(normalizeTriggerChannels(trigger)).toEqual([2]);
    });

    it('should migrate old dm channel', () => {
      const trigger = { channel: 'dm' as number | 'dm' | 'none' };
      expect(normalizeTriggerChannels(trigger)).toEqual(['dm']);
    });

    it('should migrate old none channel', () => {
      const trigger = { channel: 'none' as number | 'dm' | 'none' };
      expect(normalizeTriggerChannels(trigger)).toEqual(['none']);
    });

    it('should default to dm when no channel field exists', () => {
      const trigger = {};
      expect(normalizeTriggerChannels(trigger)).toEqual(['dm']);
    });

    it('should prefer channels array over legacy channel field', () => {
      const trigger = {
        channels: [1, 2] as Array<number | 'dm' | 'none'>,
        channel: 'dm' as number | 'dm' | 'none'
      };
      expect(normalizeTriggerChannels(trigger)).toEqual([1, 2]);
    });

    it('should fall back to legacy channel when channels array is empty', () => {
      const trigger = {
        channels: [] as Array<number | 'dm' | 'none'>,
        channel: 3 as number | 'dm' | 'none'
      };
      expect(normalizeTriggerChannels(trigger)).toEqual([3]);
    });

    it('should default to dm when channels array is empty and no legacy channel', () => {
      const trigger = { channels: [] as Array<number | 'dm' | 'none'> };
      expect(normalizeTriggerChannels(trigger)).toEqual(['dm']);
    });
  });

  describe('Auto-responder channel matching logic', () => {
    // Helper that mirrors the server's matching logic in checkAutoResponder()
    function wouldTriggerMatch(
      trigger: { channels?: Array<number | 'dm' | 'none'>; channel?: number | 'dm' | 'none' },
      isDirectMessage: boolean,
      messageChannel: number
    ): boolean {
      const triggerChannels = normalizeTriggerChannels(trigger);
      if (isDirectMessage) {
        return triggerChannels.includes('dm');
      } else {
        return triggerChannels.includes(messageChannel);
      }
    }

    it('DM matches trigger configured for dm', () => {
      expect(wouldTriggerMatch({ channels: ['dm'] }, true, 0)).toBe(true);
    });

    it('DM does not match trigger configured only for channels', () => {
      expect(wouldTriggerMatch({ channels: [0, 1] }, true, 0)).toBe(false);
    });

    it('channel message matches trigger including that channel', () => {
      expect(wouldTriggerMatch({ channels: [1, 2, 3] }, false, 2)).toBe(true);
    });

    it('channel message does not match trigger for different channels', () => {
      expect(wouldTriggerMatch({ channels: ['dm', 0] }, false, 2)).toBe(false);
    });

    it('multi-channel trigger matches both DM and channel', () => {
      const trigger = { channels: ['dm', 0] as Array<number | 'dm' | 'none'> };
      expect(wouldTriggerMatch(trigger, true, 0)).toBe(true);
      expect(wouldTriggerMatch(trigger, false, 0)).toBe(true);
      expect(wouldTriggerMatch(trigger, false, 1)).toBe(false);
    });

    it('legacy single channel field works through normalization', () => {
      expect(wouldTriggerMatch({ channel: 2 }, false, 2)).toBe(true);
      expect(wouldTriggerMatch({ channel: 2 }, false, 3)).toBe(false);
      expect(wouldTriggerMatch({ channel: 'dm' }, true, 0)).toBe(true);
    });

    it('none channel does not match DM or channel messages', () => {
      const trigger = { channels: ['none'] as Array<number | 'dm' | 'none'> };
      expect(wouldTriggerMatch(trigger, true, 0)).toBe(false);
      expect(wouldTriggerMatch(trigger, false, 0)).toBe(false);
    });
  });
});
