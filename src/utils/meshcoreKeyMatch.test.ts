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

import {
  parseCorruptedAuthorPrefix,
  isUsableSenderKey,
  resolveAuthorContact,
} from './meshcoreKeyMatch';

describe('corrupted room-post author prefixes (#5774)', () => {
  it('reads the issue examples back into surviving bytes', () => {
    expect(parseCorruptedAuthorPrefix('6afffdfffdfffd')).toEqual([0x6a, null, null, null]);
    expect(parseCorruptedAuthorPrefix('fffdfffdfffdfffd')).toEqual([null, null, null, null]);
    expect(parseCorruptedAuthorPrefix('fffd4d31fffd')).toEqual([null, 0x4d, 0x31, null]);
  });

  it('does not flag clean or foreign keys', () => {
    expect(parseCorruptedAuthorPrefix('6ab2c4d8')).toBeNull();
    expect(parseCorruptedAuthorPrefix('ab'.repeat(32))).toBeNull();
    expect(parseCorruptedAuthorPrefix('unknown')).toBeNull();
    expect(parseCorruptedAuthorPrefix('')).toBeNull();
  });

  it('marks only real keys as usable', () => {
    expect(isUsableSenderKey('6ab2c4d8')).toBe(true);
    expect(isUsableSenderKey('6afffdfffdfffd')).toBe(false);
    expect(isUsableSenderKey('unknown')).toBe(false);
    expect(isUsableSenderKey('')).toBe(false);
  });

  const roomContacts = [
    { publicKey: '6ab2c4d8' + '1'.repeat(56) },
    { publicKey: 'c54d319e' + '2'.repeat(56) },
    { publicKey: 'c64d319e' + '3'.repeat(56) },
    { publicKey: '12345678' + '4'.repeat(56) },
  ];

  it('matches a corrupted prefix when exactly one contact fits and 2+ bytes survive', () => {
    expect(resolveAuthorContact(roomContacts, 'fffd4d31fffd')).toBeUndefined(); // two fit (c5, c6)
    expect(resolveAuthorContact(roomContacts.slice(0, 2), 'fffd4d31fffd')).toBe(roomContacts[1]);
  });

  it('refuses to guess from fewer than 2 surviving bytes', () => {
    expect(resolveAuthorContact(roomContacts, '6afffdfffdfffd')).toBeUndefined();
  });

  it('still resolves clean prefixes uniquely', () => {
    expect(resolveAuthorContact(roomContacts, '6ab2c4d8')).toBe(roomContacts[0]);
  });
});
