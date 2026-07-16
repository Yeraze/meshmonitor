/**
 * Generic in-memory LRU (least-recently-used) cache, backed by a `Map`.
 * Introduced for the elevation backend (#4111 Phase 1) to bound memory for
 * terrarium tile / DEM sample caching, but deliberately generic/dependency-free
 * so it can be reused elsewhere.
 *
 * `Map` preserves insertion order, which this class exploits directly:
 * - `get()` on a hit deletes+re-inserts the key so it becomes the
 *   most-recently-used (last) entry.
 * - `set()` inserts/overwrites, then evicts from the front (oldest / least
 *   recently used) while the map exceeds `maxEntries`.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxEntries: number) {}

  /** Returns the cached value for `key`, promoting it to most-recently-used, or undefined on a miss. */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // Promote: re-insert so this key becomes the newest entry.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Inserts/overwrites `key`, then evicts the least-recently-used entries beyond `maxEntries`. */
  set(key: K, value: V): void {
    // Re-inserting an existing key first so it moves to most-recently-used position.
    this.map.delete(key);
    this.map.set(key, value);

    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  /** True if `key` is present. Does not affect recency ordering. */
  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Current number of cached entries. */
  get size(): number {
    return this.map.size;
  }

  /** Removes all cached entries. */
  clear(): void {
    this.map.clear();
  }
}
