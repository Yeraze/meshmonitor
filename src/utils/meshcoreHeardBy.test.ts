import { describe, it, expect } from 'vitest';
import { sortHeardBy, requiredRepeaterHeard, RELAY_ADV_TYPES } from './meshcoreHeardBy.js';

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
