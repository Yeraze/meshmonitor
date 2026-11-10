/**
 * MeshCore region adapter and ranking (#6335).
 */
import { describe, it, expect } from 'vitest';
import {
  ACTIVE_WINDOW_MS,
  createMeshcoreRegionAdapter,
  meshcoreRegionAdapter,
  rankRegions,
} from './meshcoreRegionAdapter.js';
import { FLOOD_CAP } from './ladder.js';

const KEY = 'AB'.repeat(32);
const NOW = Date.parse('2026-11-10T12:00:00Z');
const adapter = createMeshcoreRegionAdapter(() => NOW);
const topic = (region = 'MCO', key = KEY, leaf = 'status') => `meshcore/${region}/${key}/${leaf}`;
const body = (over: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      status: 'online',
      timestamp: new Date(NOW - 60_000).toISOString(),
      origin: 'obs',
      origin_id: KEY,
      ...over,
    }),
  );
const retained = { retained: true };
const live = { retained: false };

describe('meshcoreRegionAdapter filters', () => {
  it('subscribes to exactly one status filter and never #', () => {
    expect(meshcoreRegionAdapter.filters('meshcore')).toEqual(['meshcore/+/+/status']);
    expect(meshcoreRegionAdapter.filters('meshcore').some((f) => f.includes('#'))).toBe(false);
    expect(meshcoreRegionAdapter.cappedFilter('meshcore')).toBeNull();
  });
});

describe('meshcoreRegionAdapter classify', () => {
  it('a fresh online status is an active observer', () => {
    expect(adapter.classify(topic(), body(), retained)).toEqual({ root: 'MCO', stream: 'status', nodeKey: KEY });
  });

  it('an offline status counts as a message but not an observer', () => {
    expect(adapter.classify(topic(), body({ status: 'offline' }), live)).toEqual({ root: 'MCO', stream: 'status' });
  });

  it('a stale retained online status is not active', () => {
    const old = new Date(NOW - ACTIVE_WINDOW_MS - 1000).toISOString();
    expect(adapter.classify(topic(), body({ timestamp: old }), retained)).toEqual({ root: 'MCO', stream: 'status' });
  });

  it('a missing or unparseable timestamp on a retained status is stale', () => {
    expect(adapter.classify(topic(), body({ timestamp: undefined }), retained)?.nodeKey).toBeUndefined();
    expect(adapter.classify(topic(), body({ timestamp: 'yesterday-ish' }), retained)?.nodeKey).toBeUndefined();
    expect(adapter.classify(topic(), body({ timestamp: 1234 }), retained)?.nodeKey).toBeUndefined();
    // No meta at all is treated as retained.
    expect(adapter.classify(topic(), body({ timestamp: undefined }))?.nodeKey).toBeUndefined();
  });

  it('an online status that arrives live is active whatever its timestamp', () => {
    expect(adapter.classify(topic(), body({ timestamp: undefined }), live)?.nodeKey).toBe(KEY);
    expect(adapter.classify(topic(), body({ timestamp: '2001-01-01T00:00:00Z' }), live)?.nodeKey).toBe(KEY);
  });

  it('a timestamp far in the future is not fresh', () => {
    const future = new Date(NOW + ACTIVE_WINDOW_MS + 60_000).toISOString();
    expect(adapter.classify(topic(), body({ timestamp: future }), retained)?.nodeKey).toBeUndefined();
  });

  it('rejects a topic/body key mismatch', () => {
    expect(adapter.classify(topic('MCO', 'CD'.repeat(32)), body(), live)).toBeNull();
  });

  it('rejects the packets stream, lower-case regions and wrong topic shapes', () => {
    expect(adapter.classify(topic('MCO', KEY, 'packets'), body(), live)).toBeNull();
    expect(adapter.classify(topic('mco'), body(), live)).toBeNull();
    expect(adapter.classify(`meshcore/MCO/status`, body(), live)).toBeNull();
    expect(adapter.classify(`meshcore/MCO/${KEY}/status/x`, body(), live)).toBeNull();
    expect(adapter.classify(`other/MCO/${KEY}/status`, body(), live)).toBeNull();
    expect(adapter.classify(topic('TOO-LONG-REGION-CODE'), body(), live)).toBeNull();
  });

  it('rejects bad JSON and packet bodies', () => {
    expect(adapter.classify(topic(), Buffer.from('{nope'), live)).toBeNull();
    expect(adapter.classify(topic(), body({ type: 'PACKET' }), live)).toBeNull();
    expect(adapter.classify(topic(), Buffer.from('[]'), live)).toBeNull();
  });
});

describe('rankRegions', () => {
  it('sorts by observers, then messages, then code, with no distance', () => {
    const ranked = rankRegions([
      { root: 'TPA', nodes: 1, messages: 9, retainedOnly: true },
      { root: 'MCO', nodes: 3, messages: 2, retainedOnly: true },
      { root: 'JAX', nodes: 1, messages: 9, retainedOnly: false },
      { root: 'ORL', nodes: 1, messages: 20, retainedOnly: false },
    ]);
    expect(ranked.map((r) => r.root)).toEqual(['MCO', 'ORL', 'JAX', 'TPA']);
    for (const r of ranked) {
      expect(r.nearestKm).toBeUndefined();
      expect(r).toMatchObject({ depth: 1, tier: 3 });
    }
  });

  it('marks a floor at the flood cap', () => {
    const [a, b] = rankRegions([
      { root: 'A', nodes: 2, messages: FLOOD_CAP, retainedOnly: false },
      { root: 'B', nodes: 1, messages: FLOOD_CAP - 1, retainedOnly: false },
    ]);
    expect(a.floor).toBe(true);
    expect(b.floor).toBe(false);
  });
});
