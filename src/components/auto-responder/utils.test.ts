import { describe, it, expect } from 'vitest';
import {
  getFileIcon,
  splitTriggerPatterns,
  formatTriggerPatterns,
  extractParameters,
  buildRegexPattern,
  testSinglePattern,
  getMatchPositions,
  getExampleValueForParam,
} from './utils.js';

// ─── getFileIcon ──────────────────────────────────────────────────────────────

describe('getFileIcon', () => {
  it('returns 🐍 for .py files', () => {
    expect(getFileIcon('script.py')).toBe('🐍');
  });

  it('returns 📘 for .js files', () => {
    expect(getFileIcon('app.js')).toBe('📘');
  });

  it('returns 📘 for .mjs files', () => {
    expect(getFileIcon('module.mjs')).toBe('📘');
  });

  it('returns 💻 for .sh files', () => {
    expect(getFileIcon('run.sh')).toBe('💻');
  });

  it('returns 📄 for unknown extensions', () => {
    expect(getFileIcon('file.txt')).toBe('📄');
    expect(getFileIcon('data.json')).toBe('📄');
  });

  it('returns 📄 for files without extension', () => {
    expect(getFileIcon('Makefile')).toBe('📄');
  });

  it('is case-insensitive for extensions', () => {
    expect(getFileIcon('SCRIPT.PY')).toBe('🐍');
    expect(getFileIcon('APP.JS')).toBe('📘');
  });
});

// ─── splitTriggerPatterns ─────────────────────────────────────────────────────

describe('splitTriggerPatterns', () => {
  it('returns empty array for empty string', () => {
    expect(splitTriggerPatterns('')).toEqual([]);
  });

  it('returns empty array for null-ish string', () => {
    expect(splitTriggerPatterns('   ')).toEqual([]);
  });

  it('returns array as-is for array input', () => {
    expect(splitTriggerPatterns(['foo', 'bar'])).toEqual(['foo', 'bar']);
  });

  it('filters empty strings from array input', () => {
    expect(splitTriggerPatterns(['foo', '', 'bar'])).toEqual(['foo', 'bar']);
  });

  it('splits simple comma-separated patterns', () => {
    expect(splitTriggerPatterns('weather,forecast,temp')).toEqual([
      'weather',
      'forecast',
      'temp',
    ]);
  });

  it('trims whitespace around patterns', () => {
    expect(splitTriggerPatterns('weather, forecast, temp')).toEqual([
      'weather',
      'forecast',
      'temp',
    ]);
  });

  it('does not split commas inside braces', () => {
    expect(splitTriggerPatterns('weather {city, state}')).toEqual([
      'weather {city, state}',
    ]);
  });

  it('handles multiple patterns with brace-containing ones', () => {
    expect(
      splitTriggerPatterns('weather, weather {location}, w {location}')
    ).toEqual(['weather', 'weather {location}', 'w {location}']);
  });

  it('handles nested braces', () => {
    expect(splitTriggerPatterns('cmd {param:{\\d+}}')).toEqual([
      'cmd {param:{\\d+}}',
    ]);
  });
});

// ─── formatTriggerPatterns ────────────────────────────────────────────────────

describe('formatTriggerPatterns', () => {
  it('returns empty string for empty input', () => {
    expect(formatTriggerPatterns('')).toBe('');
  });

  it('returns empty string for null-ish input', () => {
    expect(formatTriggerPatterns(null as any)).toBe('');
  });

  it('joins array with comma and space', () => {
    expect(formatTriggerPatterns(['weather', 'forecast'])).toBe(
      'weather, forecast'
    );
  });

  it('adds spaces after commas in string format', () => {
    expect(formatTriggerPatterns('weather,forecast,temp')).toBe(
      'weather, forecast, temp'
    );
  });

  it('preserves brace patterns correctly', () => {
    expect(formatTriggerPatterns('weather {location}, w {location}')).toBe(
      'weather {location}, w {location}'
    );
  });
});

// ─── extractParameters ───────────────────────────────────────────────────────

describe('extractParameters', () => {
  it('returns empty array for pattern with no parameters', () => {
    expect(extractParameters('hello world')).toEqual([]);
  });

  it('extracts a single parameter by name', () => {
    const params = extractParameters('weather {city}');
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('city');
    expect(params[0].pattern).toBeUndefined();
  });

  it('extracts multiple parameters', () => {
    const params = extractParameters('weather {city} {state}');
    expect(params).toHaveLength(2);
    expect(params[0].name).toBe('city');
    expect(params[1].name).toBe('state');
  });

  it('extracts parameter with regex pattern', () => {
    const params = extractParameters('zip {zip:\\d{5}}');
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('zip');
    expect(params[0].pattern).toBe('\\d{5}');
  });

  it('deduplicates repeated parameters', () => {
    const params = extractParameters('{location} and {location}');
    expect(params).toHaveLength(1);
  });
});

// ─── buildRegexPattern ────────────────────────────────────────────────────────

describe('buildRegexPattern', () => {
  it('matches simple literal pattern', () => {
    const pattern = buildRegexPattern('hello');
    expect(pattern).toBe('^hello$');
  });

  it('wraps parameter in capture group', () => {
    const pattern = buildRegexPattern('weather {city}');
    expect(pattern).toContain('(');
    expect(pattern).toContain(')');
    expect(pattern).toMatch(/^\^weather \(/);
  });

  it('escapes special regex chars in literals', () => {
    const pattern = buildRegexPattern('hello.world');
    expect(pattern).toContain('\\.');
  });

  it('uses custom pattern for typed parameters', () => {
    const pattern = buildRegexPattern('zip {zip:\\d{5}}');
    expect(pattern).toContain('(\\d{5})');
  });
});

// ─── testSinglePattern ────────────────────────────────────────────────────────

describe('testSinglePattern', () => {
  it('returns null for non-matching message', () => {
    expect(testSinglePattern('hello', 'goodbye')).toBeNull();
  });

  it('matches exact literal pattern', () => {
    const result = testSinglePattern('hello', 'hello');
    expect(result).not.toBeNull();
  });

  it('is case-insensitive', () => {
    const result = testSinglePattern('hello', 'HELLO');
    expect(result).not.toBeNull();
  });

  it('extracts parameter value', () => {
    const result = testSinglePattern('weather {city}', 'weather Miami');
    expect(result).not.toBeNull();
    expect(result?.params?.city).toBe('Miami');
  });

  it('extracts multiple parameters', () => {
    const result = testSinglePattern('forecast {city} {state}', 'forecast Miami FL');
    expect(result).not.toBeNull();
    expect(result?.params?.city).toBe('Miami');
    expect(result?.params?.state).toBe('FL');
  });

  it('uses custom regex for typed parameters', () => {
    const result = testSinglePattern('zip {code:\\d+}', 'zip 33076');
    expect(result).not.toBeNull();
    expect(result?.params?.code).toBe('33076');
  });

  it('rejects non-matching typed parameter', () => {
    const result = testSinglePattern('zip {code:\\d+}', 'zip abc');
    expect(result).toBeNull();
  });

  it('returns empty params for no-param pattern', () => {
    const result = testSinglePattern('ping', 'ping');
    expect(result).not.toBeNull();
    expect(result?.params).toEqual({});
  });
});

// ─── getMatchPositions ────────────────────────────────────────────────────────

describe('getMatchPositions', () => {
  it('returns empty array when no match', () => {
    const positions = getMatchPositions('hello', 'goodbye', {});
    expect(positions).toEqual([]);
  });

  it('returns positions for matching literal pattern', () => {
    const positions = getMatchPositions('hello', 'hello', {});
    expect(positions.length).toBeGreaterThan(0);
    expect(positions[0].type).toBe('literal');
    expect(positions[0].start).toBe(0);
    expect(positions[0].end).toBe(5);
  });

  it('returns parameter positions', () => {
    const positions = getMatchPositions('weather {city}', 'weather Miami', { city: 'Miami' });
    const paramPos = positions.find(p => p.type === 'parameter');
    expect(paramPos).toBeDefined();
    expect(paramPos?.start).toBe(8);
    expect(paramPos?.end).toBe(13);
  });
});

// ─── getExampleValueForParam ──────────────────────────────────────────────────

describe('getExampleValueForParam', () => {
  it('returns 33076 for zip parameters', () => {
    expect(getExampleValueForParam('zip')).toBe('33076');
    expect(getExampleValueForParam('postal')).toBe('33076');
  });

  it('returns a temperature value for temp parameters', () => {
    expect(getExampleValueForParam('temp')).toBe('72');
    expect(getExampleValueForParam('temperature')).toBe('72');
  });

  it('returns a city name for location parameters', () => {
    expect(getExampleValueForParam('city')).toBe('Miami');
    expect(getExampleValueForParam('location')).toBe('Miami');
  });

  it('returns state abbreviation for state parameters', () => {
    expect(getExampleValueForParam('state')).toBe('FL');
  });

  it('returns node ID format for id/node parameters', () => {
    expect(getExampleValueForParam('id')).toBe('!a1b2c3d4');
    expect(getExampleValueForParam('node')).toBe('!a1b2c3d4');
  });

  it('returns a name for name parameters', () => {
    expect(getExampleValueForParam('name')).toBe('John');
  });

  it('returns generic example for unknown parameter', () => {
    expect(getExampleValueForParam('unknownparam')).toBe('example');
  });

  it('generates numeric example from \\d pattern', () => {
    expect(getExampleValueForParam('code', '\\d{5}')).toBe('12345');
    expect(getExampleValueForParam('year', '\\d{4}')).toBe('2024');
    expect(getExampleValueForParam('num', '\\d+')).toBe('42');
  });

  it('generates letter example from [a-zA-Z] pattern', () => {
    expect(getExampleValueForParam('code', '[a-zA-Z]+')).toBe('ABC');
  });

  it('generates word example from \\w pattern', () => {
    expect(getExampleValueForParam('word', '\\w+')).toBe('example');
  });
});
