import { describe, it, expect } from 'vitest';
import { validateFilterNameRegexOnSave } from './filterNameRegex.js';

// #3934: a stored RE2-incompatible filterNameRegex (client validates with native
// RegExp, which allows lookaround/backrefs) must not permanently brick the
// traceroute / remote-LocalStats automations. The guard hard-validates only when
// the regex will be applied OR the pattern changed.
describe('validateFilterNameRegexOnSave', () => {
  const LOOKAROUND = '^(?!.*Mobile).*$'; // valid native RegExp, rejected by RE2

  it('accepts a valid pattern when applied', () => {
    const r = validateFilterNameRegexOnSave('^Node', { willBeApplied: true, storedRegex: '.*' });
    expect(r).toEqual({ regex: '^Node' });
  });

  it('rejects a NEW RE2-incompatible pattern (lookaround) when it will be applied', () => {
    const r = validateFilterNameRegexOnSave(LOOKAROUND, { willBeApplied: true, storedRegex: '.*' });
    expect('error' in r).toBe(true);
  });

  it('rejects a NEW RE2-incompatible pattern even when NOT applied (changed → validated)', () => {
    // Supplying a brand-new invalid pattern is always rejected, per #3934 expected behavior.
    const r = validateFilterNameRegexOnSave(LOOKAROUND, { willBeApplied: false, storedRegex: '.*' });
    expect('error' in r).toBe(true);
  });

  it('ALLOWS re-saving an unchanged stored bad pattern while the filter is disabled (unsticks the section)', () => {
    // The core #3934 recovery path: pattern unchanged + not applied → no RE2 check.
    const r = validateFilterNameRegexOnSave(LOOKAROUND, { willBeApplied: false, storedRegex: LOOKAROUND });
    expect(r).toEqual({ regex: LOOKAROUND });
  });

  it('still rejects an unchanged stored bad pattern while the filter STAYS applied', () => {
    const r = validateFilterNameRegexOnSave(LOOKAROUND, { willBeApplied: true, storedRegex: LOOKAROUND });
    expect('error' in r).toBe(true);
  });

  it('ALLOWS clearing a stored bad pattern to a valid one', () => {
    const r = validateFilterNameRegexOnSave('.*', { willBeApplied: true, storedRegex: LOOKAROUND });
    expect(r).toEqual({ regex: '.*' });
  });

  it('enforces the length cap only when validating', () => {
    const long = 'a'.repeat(201);
    expect('error' in validateFilterNameRegexOnSave(long, { willBeApplied: true, storedRegex: '.*' })).toBe(true);
    // unchanged + not applied → skipped, so an over-long stored value can still be re-saved to unstick
    expect(validateFilterNameRegexOnSave(long, { willBeApplied: false, storedRegex: long })).toEqual({ regex: long });
  });

  it('flags catastrophic-backtracking patterns when validating', () => {
    const r = validateFilterNameRegexOnSave('.*.*.*', { willBeApplied: true, storedRegex: '.*' });
    expect('error' in r).toBe(true);
  });
});
