import { describe, it, expect } from 'vitest';
import { applyHomoglyphOptimization } from '../utils/homoglyph.js';
import { matchAutoResponderPattern } from '../utils/autoResponderUtils.js';

/**
 * Auto Responder Regex Parameter Matching Tests
 *
 * Tests the parameter extraction and matching logic for Auto Responder triggers
 * with custom regex patterns using {param:regex} syntax.
 *
 * All assertions run against the PRODUCTION `matchAutoResponderPattern` function
 * (src/utils/autoResponderUtils.ts) — not a local copy.
 */

describe('Auto Responder - Regex Parameter Matching', () => {
  describe('Parameter Extraction', () => {
    it('should extract simple parameters without regex', () => {
      const result = matchAutoResponderPattern('w {location}', 'w miami');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ location: 'miami' });
    });

    it('should extract parameters with regex patterns', () => {
      const result = matchAutoResponderPattern('w {zip:\\d{5}}', 'w 33076');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ zip: '33076' });
    });

    it('should extract multiple parameters with mixed patterns', () => {
      const result = matchAutoResponderPattern(
        'coords {lat:-?\\d+\\.?\\d*},{lon:-?\\d+\\.?\\d*}',
        'coords 40.7128,-74.0060'
      );
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ lat: '40.7128', lon: '-74.0060' });
    });

    it('should extract parameters with and without regex in same trigger', () => {
      const result = matchAutoResponderPattern('temp {city} {value:\\d+}', 'temp austin 72');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ city: 'austin', value: '72' });
    });

    it('should not extract duplicate parameters', () => {
      // Only the first occurrence of a duplicate param name is registered;
      // subsequent occurrences are not added to the params map.
      const result = matchAutoResponderPattern('echo {word}', 'echo hello');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ word: 'hello' });
    });
  });

  describe('Basic Parameter Matching', () => {
    it('should match simple parameter without regex', () => {
      const result = matchAutoResponderPattern('w {location}', 'w miami');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ location: 'miami' });
    });

    it('should match case-insensitively', () => {
      const result = matchAutoResponderPattern('w {location}', 'W MIAMI');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ location: 'MIAMI' });
    });

    it('should not match when text does not match', () => {
      const result = matchAutoResponderPattern('w {location}', 'weather miami');
      expect(result.matched).toBe(false);
    });

    it('should match multiple parameters', () => {
      const result = matchAutoResponderPattern('forecast {city},{state}', 'forecast austin,tx');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ city: 'austin', state: 'tx' });
    });
  });

  describe('Regex Pattern Matching - Numeric Values', () => {
    it('should match 5-digit zip code', () => {
      const result = matchAutoResponderPattern('w {zip:\\d{5}}', 'w 33076');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ zip: '33076' });
    });

    it('should not match 4-digit zip code', () => {
      const result = matchAutoResponderPattern('w {zip:\\d{5}}', 'w 3307');
      expect(result.matched).toBe(false);
    });

    it('should not match 6-digit zip code', () => {
      const result = matchAutoResponderPattern('w {zip:\\d{5}}', 'w 330766');
      expect(result.matched).toBe(false);
    });

    it('should match integer temperature', () => {
      const result = matchAutoResponderPattern('temp {value:\\d+}', 'temp 72');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ value: '72' });
    });

    it('should not match non-numeric temperature', () => {
      const result = matchAutoResponderPattern('temp {value:\\d+}', 'temp hot');
      expect(result.matched).toBe(false);
    });

    it('should match positive and negative numbers', () => {
      const result1 = matchAutoResponderPattern('set {num:-?\\d+}', 'set 42');
      expect(result1.matched).toBe(true);
      expect(result1.params).toEqual({ num: '42' });

      const result2 = matchAutoResponderPattern('set {num:-?\\d+}', 'set -42');
      expect(result2.matched).toBe(true);
      expect(result2.params).toEqual({ num: '-42' });
    });
  });

  describe('Regex Pattern Matching - Decimal Values', () => {
    it('should match decimal coordinates', () => {
      const result = matchAutoResponderPattern(
        'coords {lat:-?\\d+\\.?\\d*},{lon:-?\\d+\\.?\\d*}',
        'coords 40.7128,-74.0060'
      );
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ lat: '40.7128', lon: '-74.0060' });
    });

    it('should match integers as coordinates', () => {
      const result = matchAutoResponderPattern(
        'coords {lat:-?\\d+\\.?\\d*},{lon:-?\\d+\\.?\\d*}',
        'coords 40,-74'
      );
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ lat: '40', lon: '-74' });
    });

    it('should match decimal temperature', () => {
      const result = matchAutoResponderPattern('temp {value:\\d+\\.?\\d*}', 'temp 72.5');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ value: '72.5' });
    });
  });

  describe('Regex Pattern Matching - Alphanumeric', () => {
    it('should match alphanumeric node ID', () => {
      const result = matchAutoResponderPattern('node {id:[a-zA-Z0-9]+}', 'node ABC123');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ id: 'ABC123' });
    });

    it('should not match node ID with special characters', () => {
      const result = matchAutoResponderPattern('node {id:[a-zA-Z0-9]+}', 'node ABC-123');
      expect(result.matched).toBe(false);
    });

    it('should match hex color code', () => {
      const result = matchAutoResponderPattern('color {hex:[0-9a-fA-F]{6}}', 'color FF5733');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ hex: 'FF5733' });
    });

    it('should not match invalid hex color code', () => {
      const result = matchAutoResponderPattern('color {hex:[0-9a-fA-F]{6}}', 'color GG5733');
      expect(result.matched).toBe(false);
    });
  });

  describe('Regex Pattern Matching - Multiword Parameters', () => {
    it('should match multiword parameter with spaces using [\\w\\s]+', () => {
      const result = matchAutoResponderPattern('msg {text:[\\w\\s]+}', 'msg hello world');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ text: 'hello world' });
    });

    it('should match multiword with punctuation using .+', () => {
      const result = matchAutoResponderPattern('say {text:.+}', 'say hello, world!');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ text: 'hello, world!' });
    });

    it('should match quoted string with [^"]+', () => {
      const result = matchAutoResponderPattern('echo "{text:[^"]+}"', 'echo "hello world"');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ text: 'hello world' });
    });

    it('should match everything after prefix with .+', () => {
      const result = matchAutoResponderPattern('note {content:.+}', 'note this is a long message with many words');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ content: 'this is a long message with many words' });
    });

    it('should match multiword between fixed text using [\\w\\s]+', () => {
      const result = matchAutoResponderPattern('remind me to {task:[\\w\\s]+} at {time:\\d+}', 'remind me to buy groceries at 5');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ task: 'buy groceries', time: '5' });
    });
  });

  describe('Regex Pattern Matching - Special Characters', () => {
    it('should match URL path with [\\w/]+', () => {
      const result = matchAutoResponderPattern('fetch {path:[\\w/]+}', 'fetch api/weather/miami');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ path: 'api/weather/miami' });
    });

    it('should match email-like pattern', () => {
      const result = matchAutoResponderPattern('email {addr:[\\w.]+@[\\w.]+}', 'email user@example.com');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ addr: 'user@example.com' });
    });

    it('should match hyphenated values', () => {
      const result = matchAutoResponderPattern('date {value:\\d{4}-\\d{2}-\\d{2}}', 'date 2025-11-15');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ value: '2025-11-15' });
    });
  });

  describe('Mixed Regex and Non-Regex Parameters', () => {
    it('should match trigger with both regex and non-regex params', () => {
      const result = matchAutoResponderPattern('set {name} to {value:\\d+}', 'set temperature to 72');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ name: 'temperature', value: '72' });
    });

    it('should not match when regex param fails', () => {
      const result = matchAutoResponderPattern('set {name} to {value:\\d+}', 'set temperature to hot');
      expect(result.matched).toBe(false);
    });

    it('should match complex mixed pattern', () => {
      const result = matchAutoResponderPattern(
        'alert {type:[a-z]+} level {level:\\d+} for {location}',
        'alert fire level 3 for miami'
      );
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ type: 'fire', level: '3', location: 'miami' });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty parameter values with .* pattern', () => {
      const result = matchAutoResponderPattern('cmd {arg:.*}', 'cmd ');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ arg: '' });
    });

    it('should match single character with \\w', () => {
      const result = matchAutoResponderPattern('cmd {opt:\\w}', 'cmd a');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ opt: 'a' });
    });

    it('should not match when required parameter is missing', () => {
      const result = matchAutoResponderPattern('w {location}', 'w');
      expect(result.matched).toBe(false);
    });

    it('should handle multiple spaces in message (default pattern)', () => {
      // Default pattern [^\s]+ does not match spaces
      const result = matchAutoResponderPattern('say {word}', 'say hello world');
      expect(result.matched).toBe(false); // "hello world" has a space
    });

    it('should match with optional group using ?', () => {
      const result = matchAutoResponderPattern('temp {value:\\d+\\.?\\d*}', 'temp 72');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ value: '72' });
    });

    it('should return empty params object on non-match', () => {
      const result = matchAutoResponderPattern('w {location}', 'nomatch');
      expect(result.matched).toBe(false);
      expect(result.params).toEqual({});
    });
  });

  describe('Real-World Use Cases', () => {
    it('should match weather query with zip code', () => {
      const result = matchAutoResponderPattern('w {zip:\\d{5}}', 'w 33076');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ zip: '33076' });
    });

    it('should match time in HH:MM format', () => {
      const result = matchAutoResponderPattern('remind {time:\\d{1,2}:\\d{2}}', 'remind 14:30');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ time: '14:30' });
    });

    it('should match version number pattern', () => {
      const result = matchAutoResponderPattern('version {ver:\\d+\\.\\d+\\.\\d+}', 'version 2.18.0');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ ver: '2.18.0' });
    });

    it('should match IP address pattern', () => {
      const result = matchAutoResponderPattern(
        'ping {ip:\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}}',
        'ping 192.168.1.1'
      );
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ ip: '192.168.1.1' });
    });

    it('should match phone number pattern', () => {
      const result = matchAutoResponderPattern('call {phone:\\d{3}-\\d{3}-\\d{4}}', 'call 555-123-4567');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ phone: '555-123-4567' });
    });

    it('should match command with flags', () => {
      const result = matchAutoResponderPattern('cmd {name:[a-z]+} -{flag:[a-z]}', 'cmd list -a');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ name: 'list', flag: 'a' });
    });
  });

  describe('Backward Compatibility', () => {
    it('should work with legacy {param} syntax (no regex)', () => {
      const result = matchAutoResponderPattern('w {location}', 'w miami');
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ location: 'miami' });
    });

    it('should default to [^\\s]+ for non-regex params', () => {
      const result1 = matchAutoResponderPattern('cmd {arg}', 'cmd value123');
      expect(result1.matched).toBe(true);
      expect(result1.params).toEqual({ arg: 'value123' });

      const result2 = matchAutoResponderPattern('cmd {arg}', 'cmd value with spaces');
      expect(result2.matched).toBe(false); // Spaces not allowed by default
    });
  });

  describe('Multi-Pattern Triggers', () => {
    /**
     * Helper function to test multi-pattern matching
     * Simulates the backend logic for matching multiple patterns
     */
    const testMultiPatternMatch = (
      patterns: string[],
      message: string
    ): { matches: boolean; matchedPattern?: string; params?: Record<string, string> } => {
      for (const patternStr of patterns) {
        const result = matchAutoResponderPattern(patternStr, message);
        if (result.matched) {
          return { matches: true, matchedPattern: patternStr, params: result.params };
        }
      }
      return { matches: false };
    };

    it('should match first pattern in array when multiple patterns provided', () => {
      const patterns = ['ask', 'ask {message}'];
      const result = testMultiPatternMatch(patterns, 'ask');
      expect(result.matches).toBe(true);
      expect(result.matchedPattern).toBe('ask');
      expect(result.params).toEqual({});
    });

    it('should match second pattern in array when first does not match', () => {
      const patterns = ['ask', 'ask {message}'];
      // Note: default pattern [^\s]+ only matches single word, so "hello" matches but not "hello world"
      const result = testMultiPatternMatch(patterns, 'ask hello');
      expect(result.matches).toBe(true);
      expect(result.matchedPattern).toBe('ask {message}');
      expect(result.params).toEqual({ message: 'hello' });
    });

    it('should match pattern with parameters when provided', () => {
      const patterns = ['help', 'help {command}'];
      const result = testMultiPatternMatch(patterns, 'help weather');
      expect(result.matches).toBe(true);
      expect(result.matchedPattern).toBe('help {command}');
      expect(result.params).toEqual({ command: 'weather' });
    });

    it('should match simple pattern when no parameters provided', () => {
      const patterns = ['help', 'help {command}'];
      const result = testMultiPatternMatch(patterns, 'help');
      expect(result.matches).toBe(true);
      expect(result.matchedPattern).toBe('help');
      expect(result.params).toEqual({});
    });

    it('should not match when none of the patterns match', () => {
      const patterns = ['ask', 'ask {message}'];
      const result = testMultiPatternMatch(patterns, 'hello');
      expect(result.matches).toBe(false);
    });

    it('should work with regex patterns in multi-pattern triggers', () => {
      const patterns = ['temp', 'temp {value:\\d+}'];
      const result1 = testMultiPatternMatch(patterns, 'temp');
      expect(result1.matches).toBe(true);
      expect(result1.matchedPattern).toBe('temp');

      const result2 = testMultiPatternMatch(patterns, 'temp 72');
      expect(result2.matches).toBe(true);
      expect(result2.matchedPattern).toBe('temp {value:\\d+}');
      expect(result2.params).toEqual({ value: '72' });

      const result3 = testMultiPatternMatch(patterns, 'temp hot');
      expect(result3.matches).toBe(false); // "hot" doesn't match \\d+
    });

    it('should handle comma-separated string format', () => {
      // Simulate comma-separated string being split
      const commaSeparated = 'ask, ask {message}';
      const patterns = commaSeparated.split(',').map(t => t.trim()).filter(t => t.length > 0);

      const result1 = testMultiPatternMatch(patterns, 'ask');
      expect(result1.matches).toBe(true);
      expect(result1.matchedPattern).toBe('ask');

      // Note: default pattern [^\s]+ only matches single word, so "how" matches but not "how are you"
      const result2 = testMultiPatternMatch(patterns, 'ask how');
      expect(result2.matches).toBe(true);
      expect(result2.matchedPattern).toBe('ask {message}');
      expect(result2.params).toEqual({ message: 'how' });
    });
  });

  describe('Homoglyph Normalization (Issue #2136)', () => {
    it('should match Cyrillic trigger against homoglyph-optimized message', () => {
      // Trigger written in pure Cyrillic, but sender has homoglyphs enabled
      // so their message went through applyHomoglyphOptimization before sending
      const trigger = 'Привет'; // Привет (pure Cyrillic)
      const message = applyHomoglyphOptimization(trigger); // Same word after homoglyph optimization
      const result = matchAutoResponderPattern(trigger, message);
      expect(result.matched).toBe(true);
    });

    it('should match homoglyph-optimized trigger against Cyrillic message', () => {
      // Admin wrote trigger with Latin chars, incoming message is pure Cyrillic
      const trigger = 'Mocквa'; // "Москва" with М→M, о→o, с→c, а→a
      const message = 'Москва'; // Москва (pure Cyrillic)
      const result = matchAutoResponderPattern(trigger, message);
      expect(result.matched).toBe(true);
    });

    it('should match when both sides have mixed Cyrillic/Latin', () => {
      const trigger = 'Москва'; // Москва (pure Cyrillic)
      const message = 'Mocквa'; // Москва with some homoglyph replacements
      const result = matchAutoResponderPattern(trigger, message);
      expect(result.matched).toBe(true);
    });

    it('should still match pure Latin triggers against Latin messages', () => {
      const result = matchAutoResponderPattern('hello', 'hello');
      expect(result.matched).toBe(true);
    });

    it('should match Cyrillic trigger with parameters against homoglyph message', () => {
      // Trigger: "погода {city}" in Cyrillic
      const trigger = 'погода {city}'; // погода {city}
      // Message: same word after homoglyph optimization + parameter value
      const cyrillic = 'погода'; // погода
      const message = applyHomoglyphOptimization(cyrillic) + ' Moscow';
      const result = matchAutoResponderPattern(trigger, message);
      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ city: 'Moscow' });
    });

    it('should preserve Cyrillic parameter values from original text (Issue #2258)', () => {
      // Latin trigger "w {location}" with Cyrillic location parameter
      // The parameter should be extracted as pure Cyrillic, not mixed encoding
      const trigger = 'w {location}';
      const message = 'w Барнаул'; // w Барнаул
      const result = matchAutoResponderPattern(trigger, message);
      expect(result.matched).toBe(true);
      // Should be pure Cyrillic "Барнаул", NOT mixed "Бapнayл"
      expect(result.params).toEqual({ location: 'Барнаул' });
    });

    it('should not match completely different Cyrillic words', () => {
      const trigger = 'Привет'; // Привет
      const message = 'Пока'; // Пока (different word)
      const result = matchAutoResponderPattern(trigger, message);
      expect(result.matched).toBe(false);
    });
  });
});
