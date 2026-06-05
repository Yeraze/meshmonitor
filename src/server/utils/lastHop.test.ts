import { describe, it, expect } from 'vitest';
import { resolveLastHopName, type LastHopCandidate } from './lastHop.js';

const node = (over: Partial<LastHopCandidate> & { nodeNum: number }): LastHopCandidate => ({
  shortName: null,
  role: null,
  hopsAway: null,
  lastHeard: null,
  ...over,
});

describe('resolveLastHopName', () => {
  it("returns 'unknown' when there is no relay info", () => {
    expect(resolveLastHopName(undefined, [])).toBe('unknown');
    expect(resolveLastHopName(null, [])).toBe('unknown');
    expect(resolveLastHopName(0, [node({ nodeNum: 0x1234ab00 })])).toBe('unknown');
  });

  it('returns the short name of a node matching the relay low byte', () => {
    // relay byte 0x4f matches nodeNum ...4f
    const nodes = [node({ nodeNum: 0xaabbcc4f, shortName: 'RLY1', hopsAway: 0 })];
    expect(resolveLastHopName(0x4f, nodes)).toBe('RLY1');
  });

  it('matches an exact full nodeNum when given one (defensive)', () => {
    const nodes = [node({ nodeNum: 0xaabbcc4f, shortName: 'FULL' })];
    expect(resolveLastHopName(0xaabbcc4f, nodes)).toBe('FULL');
  });

  it('falls back to the hex byte when the byte is known but no named node matches', () => {
    expect(resolveLastHopName(0x4f, [])).toBe('0x4F');
    // matching node exists but has no short name → still hex byte
    expect(resolveLastHopName(0x4f, [node({ nodeNum: 0x0000004f, shortName: '' })])).toBe('0x4F');
  });

  it('zero-pads and upper-cases the hex byte', () => {
    expect(resolveLastHopName(0x0a, [])).toBe('0x0A');
    expect(resolveLastHopName(0xff, [])).toBe('0xFF');
  });

  it('excludes CLIENT_MUTE nodes (role 4) from relay matching', () => {
    const nodes = [node({ nodeNum: 0x1111114f, shortName: 'MUTE', role: 4 })];
    // The only byte match is CLIENT_MUTE → no named match → hex byte
    expect(resolveLastHopName(0x4f, nodes)).toBe('0x4F');
  });

  it('prefers a plausible (≤1 hop) candidate over a distant one on byte collision', () => {
    const nodes = [
      node({ nodeNum: 0xaaaaaa4f, shortName: 'FAR', hopsAway: 5, lastHeard: 9999 }),
      node({ nodeNum: 0xbbbbbb4f, shortName: 'NEAR', hopsAway: 1, lastHeard: 1 }),
    ];
    expect(resolveLastHopName(0x4f, nodes)).toBe('NEAR');
  });

  it('breaks ties among plausible candidates by most-recently-heard', () => {
    const nodes = [
      node({ nodeNum: 0xaaaaaa4f, shortName: 'OLD', hopsAway: 0, lastHeard: 100 }),
      node({ nodeNum: 0xbbbbbb4f, shortName: 'RECENT', hopsAway: 0, lastHeard: 200 }),
    ];
    expect(resolveLastHopName(0x4f, nodes)).toBe('RECENT');
  });
});
