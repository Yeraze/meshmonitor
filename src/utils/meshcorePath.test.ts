import { describe, it, expect } from 'vitest';
import {
  parsePathHops,
  joinPathHops,
  hopByteForKey,
  repeaterHopOptions,
  resolveHop,
} from './meshcorePath.js';
import type { MeshCoreContact } from './meshcoreHelpers';

const mk = (publicKey: string, advType: number, advName?: string): MeshCoreContact => ({
  publicKey,
  advType,
  advName,
});

describe('meshcorePath', () => {
  it('parsePathHops normalizes a hex chain to 2-char lowercase bytes', () => {
    expect(parsePathHops('A3,7f,2')).toEqual(['a3', '7f', '02']);
    expect(parsePathHops('')).toEqual([]);
    expect(parsePathHops(null)).toEqual([]);
    expect(parsePathHops(undefined)).toEqual([]);
    // drops junk tokens
    expect(parsePathHops('a3,zz,7f')).toEqual(['a3', '7f']);
  });

  it('joinPathHops round-trips with parsePathHops', () => {
    expect(joinPathHops(['a3', '7f', '02'])).toBe('a3,7f,02');
    expect(joinPathHops([])).toBe('');
    expect(parsePathHops(joinPathHops(['a3', '7f']))).toEqual(['a3', '7f']);
  });

  it('hopByteForKey returns the first key byte, lowercased', () => {
    expect(hopByteForKey('A3B4C5'.padEnd(64, '0'))).toBe('a3');
  });

  it('repeaterHopOptions includes only repeaters/rooms, sorted by name', () => {
    const contacts = [
      mk('aa'.repeat(32), 1, 'A Chat Node'), // Chat — excluded
      mk('b1'.repeat(32), 2, 'Zeta Repeater'),
      mk('c2'.repeat(32), 3, 'Alpha Room'),
      mk('d3'.repeat(32), 2, 'Mid Repeater'),
    ];
    const opts = repeaterHopOptions(contacts);
    expect(opts.map((o) => o.name)).toEqual(['Alpha Room', 'Mid Repeater', 'Zeta Repeater']);
    expect(opts.find((o) => o.name === 'Zeta Repeater')!.hopByte).toBe('b1');
  });

  it('repeaterHopOptions falls back to a key prefix when unnamed', () => {
    const opts = repeaterHopOptions([mk('ab'.repeat(32), 2)]);
    expect(opts[0].name).toBe('abababab…');
  });

  it('resolveHop labels known, ambiguous, and unknown hops', () => {
    const opts = repeaterHopOptions([
      mk('a3' + 'b'.repeat(62), 2, 'North Repeater'),
      mk('a3' + 'c'.repeat(62), 2, 'South Repeater'), // same hop byte → collision
      mk('7f' + 'd'.repeat(62), 2, 'East Repeater'),
    ]);
    expect(resolveHop('7f', opts).label).toBe('East Repeater');
    expect(resolveHop('a3', opts).label).toMatch(/^(North|South) Repeater \(\+1\)$/);
    expect(resolveHop('a3', opts).matches).toHaveLength(2);
    expect(resolveHop('ff', opts).label).toBe('Unknown (0xff)');
    expect(resolveHop('ff', opts).matches).toHaveLength(0);
  });
});
