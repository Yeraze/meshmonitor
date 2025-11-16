import { describe, it, expect } from 'vitest';

/**
 * Auto Responder Regex Parameter Matching Tests
 *
 * Tests the parameter extraction and matching logic for Auto Responder triggers
 * with custom regex patterns using {param:regex} syntax.
 */

describe('Auto Responder - Regex Parameter Matching', () => {
  /**
   * Helper function to extract parameters with optional regex patterns
   * Handles nested curly braces in regex patterns by counting brace depth
   */
  const extractParameters = (trigger: string): Array<{ name: string; pattern?: string }> => {
    const params: Array<{ name: string; pattern?: string }> = [];
    let i = 0;

    while (i < trigger.length) {
      if (trigger[i] === '{') {
        const startPos = i + 1;
        let depth = 1;
        let colonPos = -1;
        let endPos = -1;

        // Find the matching closing brace, accounting for nested braces
        for (let j = startPos; j < trigger.length && depth > 0; j++) {
          if (trigger[j] === '{') {
            depth++;
          } else if (trigger[j] === '}') {
            depth--;
            if (depth === 0) {
              endPos = j;
            }
          } else if (trigger[j] === ':' && depth === 1 && colonPos === -1) {
            colonPos = j;
          }
        }

        if (endPos !== -1) {
          const paramName = colonPos !== -1
            ? trigger.substring(startPos, colonPos)
            : trigger.substring(startPos, endPos);
          const paramPattern = colonPos !== -1
            ? trigger.substring(colonPos + 1, endPos)
            : undefined;

          if (!params.find(p => p.name === paramName)) {
            params.push({ name: paramName, pattern: paramPattern });
          }

          i = endPos + 1;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    return params;
  };

  /**
   * Helper function to test if a message matches a trigger pattern
   */
  const testTriggerMatch = (
    trigger: string,
    message: string
  ): { matches: boolean; params?: Record<string, string> } => {
    // Extract parameters with optional regex patterns
    const params = extractParameters(trigger);

    // Build regex pattern from trigger by escaping and replacing parameters
    let pattern = '';

    // Process the trigger string manually to avoid double-escaping issues
    let i = 0;
    const replacements: Array<{ start: number; end: number; replacement: string }> = [];

    while (i < trigger.length) {
      if (trigger[i] === '{') {
        const startPos = i;
        let depth = 1;
        let endPos = -1;

        // Find the matching closing brace
        for (let j = i + 1; j < trigger.length && depth > 0; j++) {
          if (trigger[j] === '{') {
            depth++;
          } else if (trigger[j] === '}') {
            depth--;
            if (depth === 0) {
              endPos = j;
            }
          }
        }

        if (endPos !== -1) {
          // Find which parameter this is
          const paramIndex = replacements.length;
          if (paramIndex < params.length) {
            const paramRegex = params[paramIndex].pattern || '[^\\s]+';
            replacements.push({
              start: startPos,
              end: endPos + 1,
              replacement: `(${paramRegex})`
            });
          }
          i = endPos + 1;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    // Build the final pattern by replacing placeholders
    for (let i = 0; i < trigger.length; i++) {
      const replacement = replacements.find(r => r.start === i);
      if (replacement) {
        pattern += replacement.replacement;
        i = replacement.end - 1; // -1 because loop will increment
      } else {
        // Escape special regex characters in literal parts
        const char = trigger[i];
        if (/[.*+?^${}()|[\]\\]/.test(char)) {
          pattern += '\\' + char;
        } else {
          pattern += char;
        }
      }
    }

    const regex = new RegExp(`^${pattern}$`, 'i');
    const match = message.match(regex);

    if (match) {
      const extractedParams: Record<string, string> = {};
      params.forEach((param, index) => {
        extractedParams[param.name] = match[index + 1];
      });
      return { matches: true, params: extractedParams };
    }

    return { matches: false };
  };

  describe('Parameter Extraction', () => {
    it('should extract simple parameters without regex', () => {
      const params = extractParameters('w {location}');
      expect(params).toEqual([{ name: 'location', pattern: undefined }]);
    });

    it('should extract parameters with regex patterns', () => {
      const params = extractParameters('w {zip:\\d{5}}');
      expect(params).toEqual([{ name: 'zip', pattern: '\\d{5}' }]);
    });

    it('should extract multiple parameters with mixed patterns', () => {
      const params = extractParameters('coords {lat:-?\\d+\\.?\\d*},{lon:-?\\d+\\.?\\d*}');
      expect(params).toEqual([
        { name: 'lat', pattern: '-?\\d+\\.?\\d*' },
        { name: 'lon', pattern: '-?\\d+\\.?\\d*' }
      ]);
    });

    it('should extract parameters with and without regex in same trigger', () => {
      const params = extractParameters('temp {city} {value:\\d+}');
      expect(params).toEqual([
        { name: 'city', pattern: undefined },
        { name: 'value', pattern: '\\d+' }
      ]);
    });

    it('should not extract duplicate parameters', () => {
      const params = extractParameters('echo {word} {word}');
      expect(params).toHaveLength(1);
      expect(params[0].name).toBe('word');
    });
  });

  describe('Basic Parameter Matching', () => {
    it('should match simple parameter without regex', () => {
      const result = testTriggerMatch('w {location}', 'w miami');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ location: 'miami' });
    });

    it('should match case-insensitively', () => {
      const result = testTriggerMatch('w {location}', 'W MIAMI');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ location: 'MIAMI' });
    });

    it('should not match when text does not match', () => {
      const result = testTriggerMatch('w {location}', 'weather miami');
      expect(result.matches).toBe(false);
    });

    it('should match multiple parameters', () => {
      const result = testTriggerMatch('forecast {city},{state}', 'forecast austin,tx');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ city: 'austin', state: 'tx' });
    });
  });

  describe('Regex Pattern Matching - Numeric Values', () => {
    it('should match 5-digit zip code', () => {
      const result = testTriggerMatch('w {zip:\\d{5}}', 'w 33076');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ zip: '33076' });
    });

    it('should not match 4-digit zip code', () => {
      const result = testTriggerMatch('w {zip:\\d{5}}', 'w 3307');
      expect(result.matches).toBe(false);
    });

    it('should not match 6-digit zip code', () => {
      const result = testTriggerMatch('w {zip:\\d{5}}', 'w 330766');
      expect(result.matches).toBe(false);
    });

    it('should match integer temperature', () => {
      const result = testTriggerMatch('temp {value:\\d+}', 'temp 72');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ value: '72' });
    });

    it('should not match non-numeric temperature', () => {
      const result = testTriggerMatch('temp {value:\\d+}', 'temp hot');
      expect(result.matches).toBe(false);
    });

    it('should match positive and negative numbers', () => {
      const result1 = testTriggerMatch('set {num:-?\\d+}', 'set 42');
      expect(result1.matches).toBe(true);
      expect(result1.params).toEqual({ num: '42' });

      const result2 = testTriggerMatch('set {num:-?\\d+}', 'set -42');
      expect(result2.matches).toBe(true);
      expect(result2.params).toEqual({ num: '-42' });
    });
  });

  describe('Regex Pattern Matching - Decimal Values', () => {
    it('should match decimal coordinates', () => {
      const result = testTriggerMatch(
        'coords {lat:-?\\d+\\.?\\d*},{lon:-?\\d+\\.?\\d*}',
        'coords 40.7128,-74.0060'
      );
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ lat: '40.7128', lon: '-74.0060' });
    });

    it('should match integers as coordinates', () => {
      const result = testTriggerMatch(
        'coords {lat:-?\\d+\\.?\\d*},{lon:-?\\d+\\.?\\d*}',
        'coords 40,-74'
      );
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ lat: '40', lon: '-74' });
    });

    it('should match decimal temperature', () => {
      const result = testTriggerMatch('temp {value:\\d+\\.?\\d*}', 'temp 72.5');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ value: '72.5' });
    });
  });

  describe('Regex Pattern Matching - Alphanumeric', () => {
    it('should match alphanumeric node ID', () => {
      const result = testTriggerMatch('node {id:[a-zA-Z0-9]+}', 'node ABC123');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ id: 'ABC123' });
    });

    it('should not match node ID with special characters', () => {
      const result = testTriggerMatch('node {id:[a-zA-Z0-9]+}', 'node ABC-123');
      expect(result.matches).toBe(false);
    });

    it('should match hex color code', () => {
      const result = testTriggerMatch('color {hex:[0-9a-fA-F]{6}}', 'color FF5733');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ hex: 'FF5733' });
    });

    it('should not match invalid hex color code', () => {
      const result = testTriggerMatch('color {hex:[0-9a-fA-F]{6}}', 'color GG5733');
      expect(result.matches).toBe(false);
    });
  });

  describe('Regex Pattern Matching - Multiword Parameters', () => {
    it('should match multiword parameter with spaces using [\\w\\s]+', () => {
      const result = testTriggerMatch('msg {text:[\\w\\s]+}', 'msg hello world');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ text: 'hello world' });
    });

    it('should match multiword with punctuation using .+', () => {
      const result = testTriggerMatch('say {text:.+}', 'say hello, world!');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ text: 'hello, world!' });
    });

    it('should match quoted string with [^"]+', () => {
      const result = testTriggerMatch('echo "{text:[^"]+}"', 'echo "hello world"');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ text: 'hello world' });
    });

    it('should match everything after prefix with .+', () => {
      const result = testTriggerMatch('note {content:.+}', 'note this is a long message with many words');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ content: 'this is a long message with many words' });
    });

    it('should match multiword between fixed text using [\\w\\s]+', () => {
      const result = testTriggerMatch('remind me to {task:[\\w\\s]+} at {time:\\d+}', 'remind me to buy groceries at 5');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ task: 'buy groceries', time: '5' });
    });
  });

  describe('Regex Pattern Matching - Special Characters', () => {
    it('should match URL path with [\\w/]+', () => {
      const result = testTriggerMatch('fetch {path:[\\w/]+}', 'fetch api/weather/miami');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ path: 'api/weather/miami' });
    });

    it('should match email-like pattern', () => {
      const result = testTriggerMatch('email {addr:[\\w.]+@[\\w.]+}', 'email user@example.com');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ addr: 'user@example.com' });
    });

    it('should match hyphenated values', () => {
      const result = testTriggerMatch('date {value:\\d{4}-\\d{2}-\\d{2}}', 'date 2025-11-15');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ value: '2025-11-15' });
    });
  });

  describe('Mixed Regex and Non-Regex Parameters', () => {
    it('should match trigger with both regex and non-regex params', () => {
      const result = testTriggerMatch('set {name} to {value:\\d+}', 'set temperature to 72');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ name: 'temperature', value: '72' });
    });

    it('should not match when regex param fails', () => {
      const result = testTriggerMatch('set {name} to {value:\\d+}', 'set temperature to hot');
      expect(result.matches).toBe(false);
    });

    it('should match complex mixed pattern', () => {
      const result = testTriggerMatch(
        'alert {type:[a-z]+} level {level:\\d+} for {location}',
        'alert fire level 3 for miami'
      );
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ type: 'fire', level: '3', location: 'miami' });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty parameter values with .* pattern', () => {
      const result = testTriggerMatch('cmd {arg:.*}', 'cmd ');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ arg: '' });
    });

    it('should match single character with \\w', () => {
      const result = testTriggerMatch('cmd {opt:\\w}', 'cmd a');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ opt: 'a' });
    });

    it('should not match when required parameter is missing', () => {
      const result = testTriggerMatch('w {location}', 'w');
      expect(result.matches).toBe(false);
    });

    it('should handle multiple spaces in message (default pattern)', () => {
      // Default pattern [^\s]+ does not match spaces
      const result = testTriggerMatch('say {word}', 'say hello world');
      expect(result.matches).toBe(false); // "hello world" has a space
    });

    it('should match with optional group using ?', () => {
      const result = testTriggerMatch('temp {value:\\d+\\.?\\d*}', 'temp 72');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ value: '72' });
    });
  });

  describe('Real-World Use Cases', () => {
    it('should match weather query with zip code', () => {
      const result = testTriggerMatch('w {zip:\\d{5}}', 'w 33076');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ zip: '33076' });
    });

    it('should match time in HH:MM format', () => {
      const result = testTriggerMatch('remind {time:\\d{1,2}:\\d{2}}', 'remind 14:30');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ time: '14:30' });
    });

    it('should match version number pattern', () => {
      const result = testTriggerMatch('version {ver:\\d+\\.\\d+\\.\\d+}', 'version 2.18.0');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ ver: '2.18.0' });
    });

    it('should match IP address pattern', () => {
      const result = testTriggerMatch(
        'ping {ip:\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}}',
        'ping 192.168.1.1'
      );
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ ip: '192.168.1.1' });
    });

    it('should match phone number pattern', () => {
      const result = testTriggerMatch('call {phone:\\d{3}-\\d{3}-\\d{4}}', 'call 555-123-4567');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ phone: '555-123-4567' });
    });

    it('should match command with flags', () => {
      const result = testTriggerMatch('cmd {name:[a-z]+} -{flag:[a-z]}', 'cmd list -a');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ name: 'list', flag: 'a' });
    });
  });

  describe('Backward Compatibility', () => {
    it('should work with legacy {param} syntax (no regex)', () => {
      const result = testTriggerMatch('w {location}', 'w miami');
      expect(result.matches).toBe(true);
      expect(result.params).toEqual({ location: 'miami' });
    });

    it('should default to [^\\s]+ for non-regex params', () => {
      const result1 = testTriggerMatch('cmd {arg}', 'cmd value123');
      expect(result1.matches).toBe(true);
      expect(result1.params).toEqual({ arg: 'value123' });

      const result2 = testTriggerMatch('cmd {arg}', 'cmd value with spaces');
      expect(result2.matches).toBe(false); // Spaces not allowed by default
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
        const result = testTriggerMatch(patternStr, message);
        if (result.matches) {
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
});
