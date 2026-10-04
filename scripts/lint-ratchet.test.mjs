/**
 * Unit tests for the lint-ratchet compare() and tally() pure functions.
 * No ESLint is spawned — only the diff-logic is exercised.
 */
import { describe, it, expect } from 'vitest';
import { compare, tally, sortObj, mergeRule } from './lint-ratchet.mjs';

// ---- compare() tests -------------------------------------------------------

describe('compare()', () => {
  it('returns no failures when current equals baseline', () => {
    const counts = { 'src/foo.ts': { '@typescript-eslint/no-explicit-any': 2 } };
    const base = { 'src/foo.ts': { '@typescript-eslint/no-explicit-any': 2 } };
    const { failures, advisories } = compare(counts, base, {});
    expect(failures).toHaveLength(0);
    expect(advisories).toHaveLength(0);
  });

  it('returns a failure when current exceeds baseline', () => {
    const counts = { 'src/bar.ts': { '@typescript-eslint/no-explicit-any': 3 } };
    const base = { 'src/bar.ts': { '@typescript-eslint/no-explicit-any': 2 } };
    const lines = { 'src/bar.ts': { '@typescript-eslint/no-explicit-any': [10, 20, 30] } };
    const { failures, advisories } = compare(counts, base, lines);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/2→3/);
    expect(failures[0]).toMatch(/FAIL src\/bar\.ts/);
    expect(advisories).toHaveLength(0);
  });

  it('returns a failure for a file absent from baseline', () => {
    const counts = { 'src/new-file.ts': { 'prefer-const': 1 } };
    const base = {};
    const lines = { 'src/new-file.ts': { 'prefer-const': [5] } };
    const { failures } = compare(counts, base, lines);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/0→1/);
  });

  it('returns advisory (not failure) when current is below baseline', () => {
    const counts = { 'src/baz.ts': { 'no-unused-vars': 1 } };
    const base = { 'src/baz.ts': { 'no-unused-vars': 3 } };
    const { failures, advisories } = compare(counts, base, {});
    expect(failures).toHaveLength(0);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatch(/3→1/);
  });

  it('generates advisory when a file is entirely absent from current counts (fully fixed)', () => {
    const counts = {}; // file completely clean now
    const base = { 'src/clean.ts': { 'no-unused-vars': 2 } };
    const { failures, advisories } = compare(counts, base, {});
    expect(failures).toHaveLength(0);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatch(/2→0/);
  });

  it('handles multiple files and rules independently', () => {
    const counts = {
      'a.ts': { 'no-unused-vars': 2, '@typescript-eslint/no-explicit-any': 1 },
      'b.ts': { 'no-unused-vars': 5 },
    };
    const base = {
      'a.ts': { 'no-unused-vars': 2, '@typescript-eslint/no-explicit-any': 3 },
      'b.ts': { 'no-unused-vars': 4 },
    };
    const { failures, advisories } = compare(counts, base, {});
    // a.ts: no-unused-vars same → neither; no-explicit-any improved (3→1) → advisory
    // b.ts: no-unused-vars regressed (4→5) → failure
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/b\.ts/);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatch(/a\.ts/);
    expect(advisories[0]).toMatch(/3→1/);
  });
});

// ---- tally() tests ---------------------------------------------------------

describe('tally()', () => {
  it('counts violations grouped by file and rule', () => {
    const results = [
      {
        filePath: '/root/src/foo.ts',
        messages: [
          { ruleId: 'prefer-const', line: 1 },
          { ruleId: 'prefer-const', line: 5 },
          { ruleId: 'no-unused-vars', line: 10 },
        ],
      },
      {
        filePath: '/root/src/bar.ts',
        messages: [],
      },
    ];
    const { counts, lines } = tally(results, '/root');
    expect(counts['src/foo.ts']['prefer-const']).toBe(2);
    expect(counts['src/foo.ts']['no-unused-vars']).toBe(1);
    expect(counts['src/bar.ts']).toBeUndefined();
    expect(lines['src/foo.ts']['prefer-const']).toEqual([1, 5]);
  });

  it('uses (parse) as the rule id for messages without a ruleId', () => {
    const results = [
      {
        filePath: '/root/src/bad.ts',
        messages: [{ ruleId: null, line: 3, message: 'Parse error' }],
      },
    ];
    const { counts } = tally(results, '/root');
    expect(counts['src/bad.ts']['(parse)']).toBe(1);
  });
});

// ---- sortObj() tests -------------------------------------------------------

describe('sortObj()', () => {
  it('sorts top-level keys alphabetically', () => {
    const input = { z: 1, a: 2, m: 3 };
    const sorted = sortObj(input);
    expect(Object.keys(sorted)).toEqual(['a', 'm', 'z']);
  });

  it('sorts nested object keys recursively', () => {
    const input = { b: { y: 1, x: 2 }, a: { d: 3, c: 4 } };
    const sorted = sortObj(input);
    expect(Object.keys(sorted)).toEqual(['a', 'b']);
    expect(Object.keys(sorted.a)).toEqual(['c', 'd']);
    expect(Object.keys(sorted.b)).toEqual(['x', 'y']);
  });

  it('does not sort array values', () => {
    const input = { a: [3, 1, 2] };
    const sorted = sortObj(input);
    expect(sorted.a).toEqual([3, 1, 2]);
  });
});

// ---- mergeRule() tests -----------------------------------------------------

describe('mergeRule()', () => {
  const RULE = 'meshmonitor-ui/no-hardcoded-color';

  it('adds the new rule and leaves every other number alone', () => {
    const base = {
      'src/a.tsx': { '@typescript-eslint/no-explicit-any': 5 },
      'src/b.ts': { 'prefer-const': 1 },
    };
    // The live tally has drifted on other rules: `any` improved in a.tsx and a
    // new file carries an unrelated violation. Neither may leak into the result.
    const counts = {
      'src/a.tsx': { '@typescript-eslint/no-explicit-any': 2, [RULE]: 7 },
      'src/c.tsx': { [RULE]: 3, 'react-hooks/exhaustive-deps': 1 },
      'src/d.ts': { '@typescript-eslint/no-explicit-any': 9 },
    };
    expect(mergeRule(base, counts, RULE)).toEqual({
      'src/a.tsx': { '@typescript-eslint/no-explicit-any': 5, [RULE]: 7 },
      'src/b.ts': { 'prefer-const': 1 },
      'src/c.tsx': { [RULE]: 3 },
    });
  });

  it('rewrites the rule where it already exists and drops it where it is gone', () => {
    const base = {
      'src/a.tsx': { [RULE]: 7, 'prefer-const': 1 },
      'src/b.tsx': { [RULE]: 4 },
    };
    const counts = { 'src/a.tsx': { [RULE]: 2 } };
    expect(mergeRule(base, counts, RULE)).toEqual({
      'src/a.tsx': { [RULE]: 2, 'prefer-const': 1 },
    });
  });

  it('does not mutate its inputs', () => {
    const base = { 'src/a.tsx': { 'prefer-const': 1 } };
    const counts = { 'src/a.tsx': { [RULE]: 1 } };
    mergeRule(base, counts, RULE);
    expect(base).toEqual({ 'src/a.tsx': { 'prefer-const': 1 } });
  });
});
