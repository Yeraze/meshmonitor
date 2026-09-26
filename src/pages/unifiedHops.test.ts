/**
 * Hop-count derivation for Unified Messages receptions (issue #5366).
 */
import { describe, it, expect } from 'vitest';
import { hopDisplay, receptionHopCount } from './unifiedHops';

const t = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;

describe('receptionHopCount (#5366)', () => {
  it('derives hopStart - hopLimit for Meshtastic receptions', () => {
    expect(receptionHopCount({ hopStart: 3, hopLimit: 1 })).toBe(2);
    expect(receptionHopCount({ hopStart: 7, hopLimit: 0 })).toBe(7);
  });

  it('treats equal hopStart and hopLimit as direct (0 hops)', () => {
    expect(receptionHopCount({ hopStart: 3, hopLimit: 3 })).toBe(0);
    expect(receptionHopCount({ hopStart: 0, hopLimit: 0 })).toBe(0);
  });

  it('returns null (unknown, not 0) when hopStart is missing', () => {
    expect(receptionHopCount({ hopStart: null, hopLimit: 3 })).toBeNull();
    expect(receptionHopCount({ hopStart: null, hopLimit: null })).toBeNull();
  });

  it('returns null when hopLimit is missing', () => {
    expect(receptionHopCount({ hopStart: 3, hopLimit: null })).toBeNull();
  });

  it('returns null for a corrupt pair where hopLimit exceeds hopStart', () => {
    expect(receptionHopCount({ hopStart: 1, hopLimit: 3 })).toBeNull();
  });

  it('uses the decoded MeshCore hopCount when present', () => {
    expect(receptionHopCount({ hopStart: null, hopLimit: null, hopCount: 4 })).toBe(4);
    expect(receptionHopCount({ hopStart: null, hopLimit: null, hopCount: 0 })).toBe(0);
  });

  it('ignores an invalid hopCount and falls back to hopStart/hopLimit', () => {
    expect(receptionHopCount({ hopStart: 3, hopLimit: 2, hopCount: -1 })).toBe(1);
    expect(receptionHopCount({ hopStart: null, hopLimit: null, hopCount: null })).toBeNull();
    expect(receptionHopCount({ hopStart: null, hopLimit: null, hopCount: Number.NaN })).toBeNull();
  });

  it('handles counts of 10 and above', () => {
    expect(receptionHopCount({ hopStart: null, hopLimit: null, hopCount: 12 })).toBe(12);
  });
});

describe('hopDisplay (#5366)', () => {
  it('renders direct, singular, and plural', () => {
    expect(hopDisplay({ hopStart: 3, hopLimit: 3 }, t)).toBe('unified.messages.hop_direct');
    expect(hopDisplay({ hopStart: 3, hopLimit: 2 }, t)).toBe('unified.messages.hop_count_one:{"count":1}');
    expect(hopDisplay({ hopStart: 3, hopLimit: 0 }, t)).toBe('unified.messages.hop_count_other:{"count":3}');
  });

  it('renders MeshCore hop counts', () => {
    expect(hopDisplay({ hopStart: null, hopLimit: null, hopCount: 2 }, t)).toBe(
      'unified.messages.hop_count_other:{"count":2}',
    );
  });

  it('falls back to partial fields, then a dash', () => {
    expect(hopDisplay({ hopStart: 3, hopLimit: null }, t)).toBe('unified.messages.hop_start_only:{"value":3}');
    expect(hopDisplay({ hopStart: null, hopLimit: 2 }, t)).toBe('unified.messages.hop_limit_only:{"value":2}');
    expect(hopDisplay({ hopStart: null, hopLimit: null }, t)).toBe('—');
    expect(hopDisplay({ hopStart: 1, hopLimit: 3 }, t)).toBe('—');
  });
});
