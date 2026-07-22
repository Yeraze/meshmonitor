import { describe, it, expect } from 'vitest';
import {
  parsePathHops,
  joinPathHops,
  hopByteForKey,
  pathHashBytesOf,
  repeaterHopOptions,
  resolveHop,
  resolveRoute,
  resolveRouteNames,
} from './meshcorePath.js';
import type { MeshCoreContact } from './meshcoreHelpers';

const mk = (publicKey: string, advType: number, advName?: string): MeshCoreContact => ({
  publicKey,
  advType,
  advName,
});

const mkPos = (
  publicKey: string,
  advType: number,
  advName: string,
  latitude: number,
  longitude: number,
): MeshCoreContact => ({ publicKey, advType, advName, latitude, longitude });

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

  it('parsePathHops preserves multi-byte hop tokens (2/3-byte widths)', () => {
    expect(parsePathHops('a3f2,7f01')).toEqual(['a3f2', '7f01']);
    expect(parsePathHops('A3F2C1,7F0102')).toEqual(['a3f2c1', '7f0102']);
    // drops odd-length / oversize tokens but keeps valid ones
    expect(parsePathHops('a3f2,abc,7f0102')).toEqual(['a3f2', '7f0102']);
  });

  it('hopByteForKey honors the hash width', () => {
    const key = 'a3f2c1'.padEnd(64, '0');
    expect(hopByteForKey(key, 1)).toBe('a3');
    expect(hopByteForKey(key, 2)).toBe('a3f2');
    expect(hopByteForKey(key, 3)).toBe('a3f2c1');
  });

  it('pathHashBytesOf infers width from the first hop, defaulting to 1', () => {
    expect(pathHashBytesOf([])).toBe(1);
    expect(pathHashBytesOf(['a3'])).toBe(1);
    expect(pathHashBytesOf(['a3f2', '7f01'])).toBe(2);
    expect(pathHashBytesOf(['a3f2c1'])).toBe(3);
  });

  it('repeaterHopOptions widens hop hashes to the requested width', () => {
    const contacts = [mk('a3f2c1'.padEnd(64, '0'), 2, 'Wide Repeater')];
    expect(repeaterHopOptions(contacts, 1)[0].hopByte).toBe('a3');
    expect(repeaterHopOptions(contacts, 2)[0].hopByte).toBe('a3f2');
    expect(repeaterHopOptions(contacts, 3)[0].hopByte).toBe('a3f2c1');
  });

  it('resolveHop matches and labels multi-byte hops', () => {
    const opts = repeaterHopOptions(
      [
        mk('a3f2'.padEnd(64, '0'), 2, 'North Repeater'),
        mk('a3c9'.padEnd(64, '0'), 2, 'South Repeater'), // shares 1-byte prefix, differs at 2-byte
      ],
      2,
    );
    // At 2-byte width the 1-byte collision disappears.
    expect(resolveHop('a3f2', opts).label).toBe('North Repeater');
    expect(resolveHop('a3f2', opts).matches).toHaveLength(1);
    expect(resolveHop('a3c9', opts).label).toBe('South Repeater');
    expect(resolveHop('beef', opts).label).toBe('Unknown (0xbeef)');
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

  describe('resolveRouteNames', () => {
    it('resolves unique matches to names and leaves unknown hashes as raw hex', () => {
      const contacts = [
        mk('a3' + 'b'.repeat(62), 2, 'Hilltop'),
        mk('7f' + 'c'.repeat(62), 3, 'Downtown Room'),
        mk('02' + 'd'.repeat(62), 1, 'Chat Node'), // companion — never in a path, excluded
      ];
      expect(resolveRouteNames(['a3', '7f', '02'], contacts)).toEqual(['Hilltop', 'Downtown Room', '02']);
    });

    it('infers the hash width from the hop hex length (2-byte hops)', () => {
      const contacts = [
        mk('a3f2'.padEnd(64, '0'), 2, 'North'),
        mk('a3c9'.padEnd(64, '0'), 2, 'South'), // 1-byte collision, distinct at 2 bytes
      ];
      expect(resolveRouteNames(['a3f2'], contacts)).toEqual(['North']);
      expect(resolveRouteNames(['a3c9'], contacts)).toEqual(['South']);
    });

    it('breaks a collision by picking the candidate closest to the neighbouring hops', () => {
      // Route west→ambiguous→east along a line. Two repeaters share hash "a3":
      // "Far Twin" is ~300 km away; "Near Twin" sits between the neighbours.
      const contacts = [
        mkPos('11' + 'a'.repeat(62), 2, 'West Anchor', 30.0, -90.0),
        mkPos('22' + 'b'.repeat(62), 2, 'East Anchor', 30.0, -89.8),
        mkPos('a3' + 'c'.repeat(62), 2, 'Near Twin', 30.0, -89.9),
        mkPos('a3' + 'd'.repeat(62), 2, 'Far Twin', 33.0, -89.9),
      ];
      expect(resolveRouteNames(['11', 'a3', '22'], contacts)).toEqual(['West Anchor', 'Near Twin', 'East Anchor']);
    });

    it('uses the previous hop as the only anchor for a trailing ambiguous hop', () => {
      const contacts = [
        mkPos('11' + 'a'.repeat(62), 2, 'Anchor', 30.0, -90.0),
        mkPos('a3' + 'c'.repeat(62), 2, 'Near Twin', 30.0, -89.95),
        mkPos('a3' + 'd'.repeat(62), 2, 'Far Twin', 35.0, -80.0),
      ];
      expect(resolveRouteNames(['11', 'a3'], contacts)).toEqual(['Anchor', 'Near Twin']);
    });

    it('falls back to the first (alphabetical) match when no position data exists', () => {
      const contacts = [
        mk('a3' + 'c'.repeat(62), 2, 'Zulu Twin'),
        mk('a3' + 'd'.repeat(62), 2, 'Alpha Twin'),
      ];
      expect(resolveRouteNames(['a3'], contacts)).toEqual(['Alpha Twin']);
    });

    it('ignores null-island coordinates when tie-breaking', () => {
      const contacts = [
        mkPos('11' + 'a'.repeat(62), 2, 'Anchor', 30.0, -90.0),
        mkPos('a3' + 'c'.repeat(62), 2, 'Zulu Positioned', 30.0, -89.99),
        mkPos('a3' + 'd'.repeat(62), 2, 'Alpha NullIsland', 0, 0),
      ];
      // Alpha sorts first, but its (0,0) position is bogus — the genuinely
      // positioned candidate wins the tie-break against the anchor.
      expect(resolveRouteNames(['11', 'a3'], contacts)).toEqual(['Anchor', 'Zulu Positioned']);
    });

    it('returns an empty list for an empty route', () => {
      expect(resolveRouteNames([], [mk('a3'.padEnd(64, '0'), 2, 'X')])).toEqual([]);
    });
  });

  describe('resolveRoute', () => {
    it('surfaces the chosen candidate position, match count, and null name for unknowns', () => {
      const contacts = [
        mkPos('a3' + 'b'.repeat(62), 2, 'Hilltop', 30.0, -90.0),
        mk('7f' + 'c'.repeat(62), 3, 'Downtown Room'), // known but unpositioned
      ];
      const route = resolveRoute(['a3', '7f', 'ff'], contacts);
      expect(route).toHaveLength(3);
      expect(route[0]).toEqual({ byte: 'a3', name: 'Hilltop', matchCount: 1, position: { lat: 30.0, lon: -90.0 } });
      expect(route[1]).toEqual({ byte: '7f', name: 'Downtown Room', matchCount: 1, position: null });
      expect(route[2]).toEqual({ byte: 'ff', name: null, matchCount: 0, position: null });
    });

    it('reports the collision winner with its position and match count', () => {
      const contacts = [
        mkPos('11' + 'a'.repeat(62), 2, 'Anchor', 30.0, -90.0),
        mkPos('a3' + 'c'.repeat(62), 2, 'Near Twin', 30.0, -89.95),
        mkPos('a3' + 'd'.repeat(62), 2, 'Far Twin', 35.0, -80.0),
      ];
      const route = resolveRoute(['11', 'a3'], contacts);
      expect(route[1].name).toBe('Near Twin');
      expect(route[1].matchCount).toBe(2);
      expect(route[1].position).toEqual({ lat: 30.0, lon: -89.95 });
    });
  });
});
