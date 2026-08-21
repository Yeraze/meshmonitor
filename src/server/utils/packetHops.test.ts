import { describe, it, expect } from 'vitest';
import { meshtasticPacketHopsAway, isRelayedReception } from './packetHops.js';

describe('meshtasticPacketHopsAway (#4849)', () => {
  it('returns 0 for a direct reception (hop_start == hop_limit)', () => {
    expect(meshtasticPacketHopsAway(3, 3)).toBe(0);
    expect(meshtasticPacketHopsAway(7, 7)).toBe(0);
  });

  it('returns the hop count for a relayed reception', () => {
    expect(meshtasticPacketHopsAway(3, 1)).toBe(2);
    expect(meshtasticPacketHopsAway(3, 0)).toBe(3);
  });

  it('returns null when hop_start is 0/absent (unknown, not "0 hops")', () => {
    expect(meshtasticPacketHopsAway(0, 0)).toBeNull();
    expect(meshtasticPacketHopsAway(undefined, 3)).toBeNull();
    expect(meshtasticPacketHopsAway(null, 3)).toBeNull();
  });

  it('returns null when hop_limit is absent', () => {
    expect(meshtasticPacketHopsAway(3, undefined)).toBeNull();
    expect(meshtasticPacketHopsAway(3, null)).toBeNull();
  });

  it('returns null for the impossible hop_start < hop_limit case', () => {
    expect(meshtasticPacketHopsAway(3, 5)).toBeNull();
  });
});

describe('isRelayedReception (#4849)', () => {
  it('is false for a direct reception', () => {
    expect(isRelayedReception(3, 3)).toBe(false);
  });

  it('is true only when hops are known to be > 0', () => {
    expect(isRelayedReception(3, 1)).toBe(true);
    expect(isRelayedReception(2, 1)).toBe(true);
  });

  it('is false when the hop count cannot be determined (do not over-drop)', () => {
    expect(isRelayedReception(0, 0)).toBe(false);
    expect(isRelayedReception(undefined, undefined)).toBe(false);
    expect(isRelayedReception(null, 2)).toBe(false);
    expect(isRelayedReception(3, undefined)).toBe(false);
  });
});
