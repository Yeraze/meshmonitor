import { describe, it, expect } from 'vitest';
import { uniquePrefixMatch } from './meshcoreKeyMatch.js';

const A = '5708aa' + '1'.repeat(58);
const B = '5708bb' + '2'.repeat(58);
const C = '5710cc' + '3'.repeat(58);
const contacts = [{ publicKey: A }, { publicKey: B }, { publicKey: C }, { publicKey: undefined }];

describe('uniquePrefixMatch (#5349)', () => {
  it('returns the exact full-key hit', () => {
    expect(uniquePrefixMatch(contacts, B)?.publicKey).toBe(B);
  });

  it('returns the single contact for a unique 6-byte prefix', () => {
    expect(uniquePrefixMatch(contacts, A.substring(0, 12))?.publicKey).toBe(A);
  });

  it('returns undefined for an ambiguous prefix', () => {
    expect(uniquePrefixMatch(contacts, '57')).toBeUndefined();
    expect(uniquePrefixMatch(contacts, '5708')).toBeUndefined();
  });

  it('resolves a prefix that is unique', () => {
    expect(uniquePrefixMatch(contacts, '5710')?.publicKey).toBe(C);
  });

  it('is case-insensitive', () => {
    expect(uniquePrefixMatch(contacts, '5708AA')?.publicKey).toBe(A);
  });

  it('matches nothing for an empty or missing key', () => {
    expect(uniquePrefixMatch(contacts, '')).toBeUndefined();
    expect(uniquePrefixMatch(contacts, undefined)).toBeUndefined();
    expect(uniquePrefixMatch(contacts, null)).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(uniquePrefixMatch(contacts, 'ff')).toBeUndefined();
  });
});
