/** validateDirectory (#6337): what a live directory document may contain. */
import { describe, it, expect } from 'vitest';
import { getDirectory, validateDirectory, DIRECTORY_LIMITS } from './directory.js';

const good = (over: Record<string, unknown> = {}) => ({
  root: 'msh/US/CA/sacvalley',
  name: 'sacvalley',
  center: [38.64, -121.163],
  radiusKm: 60,
  ...over,
});

const doc = (entries: unknown[], extra: Record<string, unknown> = {}) => ({ entries, ...extra });

describe('validateDirectory (#6337)', () => {
  it('passes the bundled JSON through unchanged', () => {
    const bundled = getDirectory();
    expect(validateDirectory(JSON.parse(JSON.stringify(bundled)))).toEqual(bundled);
  });

  it('rejects a non-object or an empty document', () => {
    expect(validateDirectory(null)).toBeNull();
    expect(validateDirectory([])).toBeNull();
    expect(validateDirectory('x')).toBeNull();
    expect(validateDirectory({})).toBeNull();
    expect(validateDirectory(doc([]))).toBeNull();
  });

  it.each([
    ['a root outside msh/', { root: 'foo/US' }],
    ['a wildcard root', { root: 'msh/US/+' }],
    ['a root with whitespace', { root: 'msh/US/a b' }],
    ['a non-string root', { root: 5 }],
    ['latitude out of range', { center: [91, 0] }],
    ['longitude out of range', { center: [0, 181] }],
    ['a non-finite centre', { center: [NaN, 0] }],
    ['a radius over 250 km', { radiusKm: 251 }],
    ['a zero radius', { radiusKm: 0 }],
    ['a centre with no radius', { radiusKm: undefined }],
    ['a name over 64 characters', { name: 'x'.repeat(65) }],
    ['an empty name', { name: '\u0001' }],
    ['no location at all', { center: undefined, radiusKm: undefined }],
    ['a bad subdivision code', { center: undefined, radiusKm: undefined, subdivisions: ['texas'] }],
  ])('drops an entry with %s', (_label, over) => {
    const out = validateDirectory(doc([good({ root: 'msh/US/keep' }), good(over)]));
    expect(out?.entries.map((e) => e.root)).toEqual(['msh/US/keep']);
  });

  it('strips control characters from names', () => {
    const out = validateDirectory(doc([good({ name: 'sac\u0007valley\n' })]));
    expect(out?.entries[0].name).toBe('sacvalley');
  });

  it('keeps the first of duplicate roots', () => {
    const out = validateDirectory(doc([good({ name: 'first' }), good({ name: 'second' })]));
    expect(out?.entries).toHaveLength(1);
    expect(out?.entries[0].name).toBe('first');
  });

  it('rejects a document where more than half the entries are bad', () => {
    expect(validateDirectory(doc([good(), good({ root: 'x' }), good({ root: 'y' })]))).toBeNull();
    expect(validateDirectory(doc([good(), good({ root: 'x' })]))).not.toBeNull();
  });

  it('rejects a document over the entry cap', () => {
    const many = Array.from({ length: DIRECTORY_LIMITS.maxEntries + 1 }, (_, i) => good({ root: `msh/US/r${i}` }));
    expect(validateDirectory(doc(many))).toBeNull();
  });

  it('accepts a subdivisions-only entry (design#167)', () => {
    const out = validateDirectory(
      doc([{ root: 'msh/US/TX', name: 'Texas mesh', subdivisions: ['US-TX', 'US-TX'] }]),
    );
    expect(out?.entries[0]).toEqual({ root: 'msh/US/TX', name: 'Texas mesh', subdivisions: ['US-TX'] });
  });

  it('accepts a non-ASCII root (api#171)', () => {
    const out = validateDirectory(doc([good({ root: 'msh/EU_868/NO/Østlandet' })]));
    expect(out?.entries[0].root).toBe('msh/EU_868/NO/Østlandet');
  });

  it('filters neighbors to ISO 3166-2 codes and drops an oversized map', () => {
    const out = validateDirectory(
      doc([good()], { neighbors: { 'US-CA': ['US-NV', 'bogus', 7], bad: ['US-NV'], 'US-OR': 'US-CA' } }),
    );
    expect(out?.neighbors).toEqual({ 'US-CA': ['US-NV'] });

    const huge: Record<string, string[]> = {};
    for (let i = 0; i <= DIRECTORY_LIMITS.maxNeighborKeys; i++) huge[`US-${i}`] = ['US-CA'];
    expect(validateDirectory(doc([good()], { neighbors: huge }))?.neighbors).toEqual({});
  });

  it('filters subdivisionSegments to lowercase names and single segments', () => {
    const out = validateDirectory(
      doc([good()], {
        subdivisionSegments: {
          US: { texas: 'TX', Ohio: 'OH', utah: 'U/T', nevada: 'N V', oregon: 5 },
          usa: { texas: 'TX' },
        },
      }),
    );
    expect(out?.subdivisionSegments).toEqual({ US: { texas: 'TX' } });
  });
});
