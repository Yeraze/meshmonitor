/**
 * Tests for Auto Responder Utility Functions
 * 
 * Tests the splitTriggerPatterns and formatTriggerPatterns utility functions
 * that handle multi-pattern trigger parsing and formatting.
 */

import { describe, it, expect } from 'vitest';
import { splitTriggerPatterns, formatTriggerPatterns, getFileIcon } from '../../src/components/auto-responder/utils';

describe('splitTriggerPatterns', () => {
  describe('string input', () => {
    it('should split simple comma-separated patterns', () => {
      const result = splitTriggerPatterns('weather, status, ping');
      expect(result).toEqual(['weather', 'status', 'ping']);
    });

    it('should handle patterns with parameters', () => {
      const result = splitTriggerPatterns('weather, weather {location}, w {location}');
      expect(result).toEqual(['weather', 'weather {location}', 'w {location}']);
    });

    it('should not split commas inside braces', () => {
      // Comma inside a single brace (regex pattern)
      const result = splitTriggerPatterns('match {pattern:a,b,c}');
      expect(result).toEqual(['match {pattern:a,b,c}']);
    });

    it('should split commas between separate parameter braces', () => {
      // Comma between two separate braces should be split
      const result = splitTriggerPatterns('coords {lat:-?\\d+\\.?\\d*},{lon:-?\\d+\\.?\\d*}');
      expect(result).toEqual(['coords {lat:-?\\d+\\.?\\d*}', '{lon:-?\\d+\\.?\\d*}']);
    });

    it('should handle nested braces', () => {
      const result = splitTriggerPatterns('cmd {param:{a,b}}, other');
      expect(result).toEqual(['cmd {param:{a,b}}', 'other']);
    });

    it('should trim whitespace from patterns', () => {
      const result = splitTriggerPatterns('weather , status , ping');
      expect(result).toEqual(['weather', 'status', 'ping']);
    });

    it('should handle single pattern without comma', () => {
      const result = splitTriggerPatterns('ping');
      expect(result).toEqual(['ping']);
    });

    it('should handle empty string', () => {
      const result = splitTriggerPatterns('');
      expect(result).toEqual([]);
    });

    it('should handle whitespace-only string', () => {
      const result = splitTriggerPatterns('   ');
      expect(result).toEqual([]);
    });

    it('should handle null or undefined', () => {
      expect(splitTriggerPatterns(null as any)).toEqual([]);
      expect(splitTriggerPatterns(undefined as any)).toEqual([]);
    });
  });

  describe('array input', () => {
    it('should return array as-is when already split', () => {
      const input = ['weather', 'weather {location}', 'w {location}'];
      const result = splitTriggerPatterns(input);
      expect(result).toEqual(input);
    });

    it('should filter out empty strings from array', () => {
      const input = ['weather', '', 'status', '  ', 'ping'];
      const result = splitTriggerPatterns(input);
      expect(result).toEqual(['weather', 'status', 'ping']);
    });

    it('should filter out non-string values from array', () => {
      const input = ['weather', null as any, 'status', 123 as any, 'ping'];
      const result = splitTriggerPatterns(input);
      expect(result).toEqual(['weather', 'status', 'ping']);
    });

    it('should handle empty array', () => {
      const result = splitTriggerPatterns([]);
      expect(result).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('should handle patterns with multiple parameters', () => {
      const result = splitTriggerPatterns('set {name} to {value:\\d+}, get {name}');
      expect(result).toEqual(['set {name} to {value:\\d+}', 'get {name}']);
    });

    it('should handle patterns with escaped characters in regex', () => {
      const result = splitTriggerPatterns('match {pattern:\\d+\\.\\d+}, other');
      expect(result).toEqual(['match {pattern:\\d+\\.\\d+}', 'other']);
    });

    it('should handle trailing comma', () => {
      const result = splitTriggerPatterns('weather, status,');
      expect(result).toEqual(['weather', 'status']);
    });

    it('should handle leading comma', () => {
      const result = splitTriggerPatterns(', weather, status');
      expect(result).toEqual(['weather', 'status']);
    });
  });
});

describe('formatTriggerPatterns', () => {
  describe('string input', () => {
    it('should format comma-separated patterns with spaces', () => {
      const result = formatTriggerPatterns('weather,status,ping');
      expect(result).toBe('weather, status, ping');
    });

    it('should preserve existing spacing', () => {
      const result = formatTriggerPatterns('weather, status, ping');
      expect(result).toBe('weather, status, ping');
    });

    it('should handle patterns with parameters', () => {
      const result = formatTriggerPatterns('weather,weather {location},w {location}');
      expect(result).toBe('weather, weather {location}, w {location}');
    });

    it('should handle single pattern', () => {
      const result = formatTriggerPatterns('ping');
      expect(result).toBe('ping');
    });

    it('should handle empty string', () => {
      const result = formatTriggerPatterns('');
      expect(result).toBe('');
    });

    it('should handle null or undefined', () => {
      expect(formatTriggerPatterns(null as any)).toBe('');
      expect(formatTriggerPatterns(undefined as any)).toBe('');
    });
  });

  describe('array input', () => {
    it('should join array with comma and space', () => {
      const input = ['weather', 'status', 'ping'];
      const result = formatTriggerPatterns(input);
      expect(result).toBe('weather, status, ping');
    });

    it('should filter out non-string values', () => {
      const input = ['weather', null as any, 'status', 123 as any, 'ping'];
      const result = formatTriggerPatterns(input);
      expect(result).toBe('weather, status, ping');
    });

    it('should handle empty array', () => {
      const result = formatTriggerPatterns([]);
      expect(result).toBe('');
    });

    it('should handle single element array', () => {
      const result = formatTriggerPatterns(['ping']);
      expect(result).toBe('ping');
    });
  });
});

describe('getFileIcon', () => {
  it('should return Python icon for .py files', () => {
    expect(getFileIcon('script.py')).toBe('🐍');
    expect(getFileIcon('weather.py')).toBe('🐍');
    expect(getFileIcon('path/to/script.py')).toBe('🐍');
  });

  it('should return JavaScript icon for .js files', () => {
    expect(getFileIcon('script.js')).toBe('📘');
    expect(getFileIcon('weather.mjs')).toBe('📘');
    expect(getFileIcon('path/to/script.js')).toBe('📘');
  });

  it('should return shell icon for .sh files', () => {
    expect(getFileIcon('script.sh')).toBe('💻');
    expect(getFileIcon('weather.sh')).toBe('💻');
  });

  it('should return default icon for unknown extensions', () => {
    expect(getFileIcon('script.txt')).toBe('📄');
    expect(getFileIcon('script')).toBe('📄');
    expect(getFileIcon('script.unknown')).toBe('📄');
  });

  it('should handle case-insensitive extensions', () => {
    expect(getFileIcon('script.PY')).toBe('🐍');
    expect(getFileIcon('script.JS')).toBe('📘');
    expect(getFileIcon('script.SH')).toBe('💻');
  });
});

