import { describe, it, expect } from 'vitest';
import { LruCache } from './lruCache';

describe('LruCache', () => {
  it('round-trips a set/get', () => {
    const cache = new LruCache<string, number>(3);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('returns undefined on a miss', () => {
    const cache = new LruCache<string, number>(3);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry once over capacity', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // 'a' was least-recently-used -> evicted

    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('promotes an entry on get so it survives a later eviction', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // promote 'a' to most-recently-used; 'b' is now oldest
    cache.set('c', 3); // should evict 'b', not 'a'

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('overwriting an existing key updates its value and recency without growing size', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 99); // update + promote 'a'
    cache.set('c', 3); // should evict 'b' (now oldest), not 'a'

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(99);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('reports size accurately as entries are added', () => {
    const cache = new LruCache<string, number>(5);
    expect(cache.size).toBe(0);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size).toBe(2);
  });

  it('clear() empties the cache', () => {
    const cache = new LruCache<string, number>(5);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
    expect(cache.get('a')).toBeUndefined();
  });

  it('has() does not affect recency ordering', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.has('a'); // should NOT promote 'a'
    cache.set('c', 3); // 'a' is still oldest -> evicted

    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });
});
