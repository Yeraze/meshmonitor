import { describe, it, expect } from 'vitest';
import { splitTriggerPatterns, normalizeTriggerPatterns } from './autoResponderUtils';

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
});

