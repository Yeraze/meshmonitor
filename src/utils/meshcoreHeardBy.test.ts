import { describe, it, expect } from 'vitest';
import {
  sortHeardBy,
  requiredRepeaterHeard,
  requiredRepeatersHeard,
  readRequiredRepeaters,
  RELAY_ADV_TYPES,
  mergeMeshCoreHeardBy,
} from './meshcoreHeardBy.js';

describe('sortHeardBy (#6000)', () => {
  it('sorts by hops ascending, then SNR descending', () => {
    const out = sortHeardBy([
      { hash: 'c', hops: 1, snr: 9 },
      { hash: 'a', hops: 0, snr: 2 },
      { hash: 'b', hops: 0, snr: 6 },
    ]);
    expect(out.map((e) => e.hash)).toEqual(['b', 'a', 'c']);
  });

  it('puts entries with no hop count (old rows) last, and missing SNR after present SNR', () => {
    const out = sortHeardBy([
      { hash: 'old', hops: null, snr: 10 },
      { hash: 'nosnr', hops: 0, snr: null },
      { hash: 'snr', hops: 0, snr: -3 },
      { hash: 'old2' },
    ]);
    expect(out.map((e) => e.hash)).toEqual(['snr', 'nosnr', 'old', 'old2']);
  });

  it('does not mutate its input', () => {
    const input = [{ hops: 2 }, { hops: 1 }];
    sortHeardBy(input);
    expect(input[0].hops).toBe(2);
  });
});

const REQ = 'aabbccddeeff00112233445566778899';
const OTHER = 'aabb00000000000000000000000000ff'; // shares 'aabb' prefix with REQ
const FAR = 'ffeeddccbbaa99887766554433221100';

describe('requiredRepeaterHeard (#6178)', () => {
  it('returns false when no required repeater is set', () => {
    expect(requiredRepeaterHeard([{ hash: 'aa' }], undefined, [{ publicKey: REQ, advType: 2 }])).toBe(false);
    expect(requiredRepeaterHeard([{ hash: 'aa' }], '', [{ publicKey: REQ, advType: 2 }])).toBe(false);
    expect(requiredRepeaterHeard([{ hash: 'aa' }], null, [{ publicKey: REQ, advType: 2 }])).toBe(false);
  });

  it('returns false when heardBy is empty or absent', () => {
    expect(requiredRepeaterHeard([], REQ, [{ publicKey: REQ, advType: 2 }])).toBe(false);
    expect(requiredRepeaterHeard(undefined, REQ, [{ publicKey: REQ, advType: 2 }])).toBe(false);
    expect(requiredRepeaterHeard(null, REQ, [{ publicKey: REQ, advType: 2 }])).toBe(false);
  });

  it('matches when a prefix uniquely resolves to the required repeater', () => {
    const repeaters = [
      { publicKey: REQ, advType: 2 },
      { publicKey: FAR, advType: 2 },
    ];
    expect(requiredRepeaterHeard([{ hash: 'aabb' }], REQ, repeaters)).toBe(true);
  });

  it('does NOT match when the prefix resolves to a different repeater', () => {
    const repeaters = [
      { publicKey: REQ, advType: 2 },
      { publicKey: FAR, advType: 2 },
    ];
    // 'ffee' uniquely resolves to FAR, not the required REQ.
    expect(requiredRepeaterHeard([{ hash: 'ffee' }], REQ, repeaters)).toBe(false);
  });

  it('does NOT match on an ambiguous prefix shared by two known relays', () => {
    const repeaters = [
      { publicKey: REQ, advType: 2 },
      { publicKey: OTHER, advType: 2 },
    ];
    // 'aabb' matches both REQ and OTHER → ambiguous → keep the button.
    expect(requiredRepeaterHeard([{ hash: 'aabb' }], REQ, repeaters)).toBe(false);
  });

  it('matches once a wider hash disambiguates the collision', () => {
    const repeaters = [
      { publicKey: REQ, advType: 2 },
      { publicKey: OTHER, advType: 2 },
    ];
    // 'aabbcc' only matches REQ now.
    expect(requiredRepeaterHeard([{ hash: 'aabbcc' }], REQ, repeaters)).toBe(true);
  });

  it('returns false when the required repeater is not among the known contacts', () => {
    expect(requiredRepeaterHeard([{ hash: 'aabb' }], REQ, [{ publicKey: FAR, advType: 2 }])).toBe(false);
  });

  it('is case-insensitive on both the hash and the public key', () => {
    const repeaters = [{ publicKey: REQ.toUpperCase(), advType: 2 }];
    expect(requiredRepeaterHeard([{ hash: 'AABB' }], REQ.toLowerCase(), repeaters)).toBe(true);
  });

  it('ignores non-relay contacts (companion advType 1) when counting uniqueness', () => {
    // A companion sharing the 'aabb' prefix must not block the unique match.
    const repeaters = [
      { publicKey: REQ, advType: 2 },
      { publicKey: OTHER, advType: 1 }, // COMPANION, not a relay
    ];
    expect(requiredRepeaterHeard([{ hash: 'aabb' }], REQ, repeaters)).toBe(true);
  });

  it('treats an unknown advType as a possible relay (conservative uniqueness)', () => {
    const repeaters = [
      { publicKey: REQ, advType: null },
      { publicKey: OTHER, advType: null },
    ];
    // both unknown-type contacts count → ambiguous 'aabb' → not matched.
    expect(requiredRepeaterHeard([{ hash: 'aabb' }], REQ, repeaters)).toBe(false);
  });

  it('skips blank hashes without throwing', () => {
    expect(requiredRepeaterHeard([{ hash: '' }], REQ, [{ publicKey: REQ, advType: 2 }])).toBe(false);
  });

  it('exposes REPEATER and ROOM_SERVER as the relay advert types', () => {
    expect(RELAY_ADV_TYPES.has(2)).toBe(true);
    expect(RELAY_ADV_TYPES.has(3)).toBe(true);
    expect(RELAY_ADV_TYPES.has(1)).toBe(false);
  });
});

// #6193 — Required Repeaters LIST reader + ANY/ALL gate.
const K1 = 'aabbccddeeff00112233445566778899';
const K2 = '1122334455667788990011223344abcd';
const K3 = 'ffeeddccbbaa99887766554433221100';

describe('readRequiredRepeaters (#6193 back-compat reader)', () => {
  it('reads the new list (JSON string) and defaults mode to any', () => {
    const r = readRequiredRepeaters({ meshcoreRequiredRepeaters: JSON.stringify([K1, K2]) });
    expect(r.keys).toEqual([K1, K2]);
    expect(r.mode).toBe('any');
  });

  it('accepts an already-parsed array for the list', () => {
    const r = readRequiredRepeaters({ meshcoreRequiredRepeaters: [K1] });
    expect(r.keys).toEqual([K1]);
  });

  it('reads mode "all"; anything else is "any"', () => {
    expect(readRequiredRepeaters({ meshcoreRequiredRepeaters: [K1], meshcoreRequiredRepeaterMode: 'all' }).mode).toBe('all');
    expect(readRequiredRepeaters({ meshcoreRequiredRepeaters: [K1], meshcoreRequiredRepeaterMode: 'ALL' }).mode).toBe('all');
    expect(readRequiredRepeaters({ meshcoreRequiredRepeaters: [K1], meshcoreRequiredRepeaterMode: 'nonsense' }).mode).toBe('any');
    expect(readRequiredRepeaters({ meshcoreRequiredRepeaters: [K1] }).mode).toBe('any');
  });

  it('falls back to the legacy single key when the list is absent or empty', () => {
    expect(readRequiredRepeaters({ meshcoreRequiredRepeater: K1 }).keys).toEqual([K1]);
    expect(readRequiredRepeaters({ meshcoreRequiredRepeaters: '[]', meshcoreRequiredRepeater: K1 }).keys).toEqual([K1]);
    expect(readRequiredRepeaters({ meshcoreRequiredRepeaters: '', meshcoreRequiredRepeater: `  ${K2}  ` }).keys).toEqual([K2]);
  });

  it('prefers the new list over the legacy key when both are set', () => {
    const r = readRequiredRepeaters({ meshcoreRequiredRepeaters: [K1], meshcoreRequiredRepeater: K3 });
    expect(r.keys).toEqual([K1]);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(readRequiredRepeaters({}).keys).toEqual([]);
    expect(readRequiredRepeaters(null).keys).toEqual([]);
    expect(readRequiredRepeaters(undefined).keys).toEqual([]);
  });

  it('drops blanks, non-strings, and case-insensitive duplicates', () => {
    const r = readRequiredRepeaters({ meshcoreRequiredRepeaters: [K1, '', K1.toUpperCase(), 42 as unknown as string, K2] });
    expect(r.keys).toEqual([K1, K2]);
  });

  it('ignores a malformed JSON string for the list (falls back / empty)', () => {
    expect(readRequiredRepeaters({ meshcoreRequiredRepeaters: '{not json' }).keys).toEqual([]);
    expect(readRequiredRepeaters({ meshcoreRequiredRepeaters: '{not json', meshcoreRequiredRepeater: K1 }).keys).toEqual([K1]);
  });
});

describe('requiredRepeatersHeard (#6193 ANY/ALL gate)', () => {
  const relays = [
    { publicKey: K1, advType: 2 },
    { publicKey: K2, advType: 2 },
    { publicKey: K3, advType: 2 },
  ];

  it('empty list -> #6184 fallback: satisfied once any repeater is heard', () => {
    expect(requiredRepeatersHeard([{ hash: 'aa' }], [], 'any', relays)).toBe(true);
    expect(requiredRepeatersHeard([], [], 'any', relays)).toBe(false);
    expect(requiredRepeatersHeard(undefined, [], 'all', relays)).toBe(false);
  });

  it('ANY: satisfied once one of several listed repeaters is heard', () => {
    // 'aabb' uniquely resolves to K1 only.
    expect(requiredRepeatersHeard([{ hash: 'aabb' }], [K1, K2], 'any', relays)).toBe(true);
    // 'ffee' resolves to K3, which is not in the required list -> not satisfied.
    expect(requiredRepeatersHeard([{ hash: 'ffee' }], [K1, K2], 'any', relays)).toBe(false);
  });

  it('ALL: not satisfied until every listed repeater is heard', () => {
    expect(requiredRepeatersHeard([{ hash: 'aabb' }], [K1, K2], 'all', relays)).toBe(false);
    expect(requiredRepeatersHeard([{ hash: 'aabb' }, { hash: '1122' }], [K1, K2], 'all', relays)).toBe(true);
  });

  it('ambiguous prefix still does not count (ALL stays unsatisfied)', () => {
    const colliding = [
      { publicKey: 'aabb00000000000000000000000000ff', advType: 2 }, // shares 'aabb' with K1
      ...relays,
    ];
    expect(requiredRepeatersHeard([{ hash: 'aabb' }, { hash: '1122' }], [K1, K2], 'all', colliding)).toBe(false);
    // The single-key matcher is the same building block.
    expect(requiredRepeaterHeard([{ hash: 'aabb' }], K1, colliding)).toBe(false);
  });
});

describe('mergeMeshCoreHeardBy', () => {
  it('keeps relay evidence when a stale update has none', () => {
    const previous = [{ hash: 'ab', name: 'R1', snr: 3, hops: 1 }];
    expect(mergeMeshCoreHeardBy(previous, undefined)).toEqual(previous);
    expect(mergeMeshCoreHeardBy(previous, [])).toEqual(previous);
  });

  it('accumulates new relays and keeps the best SNR / fewest hops', () => {
    const merged = mergeMeshCoreHeardBy(
      [{ hash: 'ab', name: 'R1', snr: 3, hops: 2 }],
      [
        { hash: 'ab', snr: 5, hops: 1 },
        { hash: 'cd', name: 'R2', snr: -1, hops: 0 },
      ],
    );
    expect(merged).toEqual([
      { hash: 'ab', name: 'R1', snr: 5, hops: 1 },
      { hash: 'cd', name: 'R2', snr: -1, hops: 0 },
    ]);
  });

  it('does not invent data when an update has no name/SNR/hops', () => {
    const merged = mergeMeshCoreHeardBy(
      [{ hash: 'ab', name: 'R1', snr: 4, hops: 2 }],
      [{ hash: 'ab' }],
    );
    expect(merged).toEqual([{ hash: 'ab', name: 'R1', snr: 4, hops: 2 }]);
  });

  it('returns undefined when there is nothing to keep', () => {
    expect(mergeMeshCoreHeardBy(undefined, undefined)).toBeUndefined();
    expect(mergeMeshCoreHeardBy([], undefined)).toBeUndefined();
  });
});
