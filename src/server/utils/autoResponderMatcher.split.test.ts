/**
 * #5466 browser check: inserting the lat/lon example showed "2 patterns".
 *
 * The example was `loc {lat:…},{lon:…}`. That comma sits OUTSIDE every brace,
 * and a top-level comma is the documented pattern separator, so both the UI
 * and the server really did split it in two. The example now uses a space.
 * These tests pin the separator rules the server and UI share, and check that
 * every example in the Pattern Examples card is one working pattern.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitTriggerPatterns, normalizeTriggerPatterns } from '../../utils/autoResponderUtils.js';
import { splitTriggerPatterns as uiSplit } from '../../components/auto-responder/utils.js';
import { matchAutoResponderPattern } from './autoResponderMatcher.js';

const here = dirname(fileURLToPath(import.meta.url));
const LAT_LON = 'loc {lat:-?\\d+\\.?\\d*} {lon:-?\\d+\\.?\\d*}';

describe('trigger pattern splitting (shared by server and UI)', () => {
  it.each([
    ['a, b', ['a', 'b']],
    ['hello,hi {name}', ['hello', 'hi {name}']],
    ['weather {city, state}', ['weather {city, state}']],
    ['battery {level:\\d{1,3}}, bat', ['battery {level:\\d{1,3}}', 'bat']],
    ['pick {sep:[,;]+}', ['pick {sep:[,;]+}']],
    [LAT_LON, [LAT_LON]],
    // Unchanged, pinned by autoResponderUtils.test.ts: a stray '}' leaves the
    // depth negative, so later commas stop splitting. The UI now agrees.
    ['hello name},hi', ['hello name},hi']],
  ])('%s', (input, expected) => {
    expect(splitTriggerPatterns(input)).toEqual(expected);
    expect(normalizeTriggerPatterns(input)).toEqual(expected);
    expect(uiSplit(input)).toEqual(expected);
  });

  it('a top-level comma between two parameters is a separator', () => {
    expect(splitTriggerPatterns('loc {lat},{lon}')).toEqual(['loc {lat}', '{lon}']);
  });

  it('the UI splitter delegates to the shared one', () => {
    const src = readFileSync(join(here, '../../components/auto-responder/utils.ts'), 'utf8');
    expect(src).toContain("from '../../utils/autoResponderUtils'");
    expect(src).not.toMatch(/braceDepth/);
  });
});

describe('the lat/lon example', () => {
  it('is one pattern and matches coordinates on the server', () => {
    expect(splitTriggerPatterns(LAT_LON)).toHaveLength(1);
    const m = matchAutoResponderPattern(LAT_LON, 'loc 28.5383 -81.3792');
    expect(m.matched).toBe(true);
    expect(m.params).toEqual({ lat: '28.5383', lon: '-81.3792' });
  });
});

describe('every Pattern Examples card entry', () => {
  // Read from source: exporting data from the .tsx would trip
  // react-refresh/only-export-components.
  const src = readFileSync(join(here, '../../components/auto-responder/PatternExamples.tsx'), 'utf8');
  const single = [...src.matchAll(/pattern: '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\\\/g, '\\'));

  it('finds the examples', () => {
    expect(single.length).toBeGreaterThanOrEqual(18);
    expect(single).toContain(LAT_LON);
  });

  it('inserts as exactly one pattern', () => {
    for (const p of single) expect(splitTriggerPatterns(p), p).toEqual([p]);
  });

  it('compiles on the server', () => {
    for (const p of single) {
      expect(() => matchAutoResponderPattern(p, 'x'), p).not.toThrow();
    }
  });
});
