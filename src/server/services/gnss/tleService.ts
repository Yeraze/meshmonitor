/**
 * GNSS TLE service (#4729, backend foundation).
 *
 * Fetches two-line element (TLE) sets for GNSS constellations from CelesTrak
 * and caches them in memory. Design goals (modeled on `versionCheckService`
 * and `elevationProvider`):
 *
 *  - **Lazy, not scheduled.** Nothing fetches at boot. The first `getTles()`
 *    for a constellation triggers the fetch; subsequent calls within the TTL
 *    are cheap cache reads. We deliberately avoid a startup scheduler so a
 *    fresh install generates no unsolicited outbound traffic until a user
 *    actually opens the (future) GNSS view.
 *  - **Last-good on failure.** A failed refetch NEVER caches the failure or
 *    discards the previous good data — it returns the stale-but-valid cache if
 *    one exists, and only throws when there is nothing to fall back on.
 *  - **SSRF-guarded outbound.** All fetches go through `safeFetch`, never raw
 *    `fetch`, matching every other outbound-HTTP service in the codebase.
 *
 * Only GPS is fetched in v1; the group map is structured so GLONASS/Galileo/
 * BeiDou drop in later without touching the fetch/cache/parse machinery.
 */

import { logger } from '../../../utils/logger.js';
import { safeFetch, SsrfBlockedError } from '../../utils/ssrfGuard.js';
import type { Tle } from './skyView.js';

/** Supported GNSS constellations. v1 fetches `gps`; the rest are ready to enable. */
export type Constellation = 'gps' | 'glonass' | 'galileo' | 'beidou';

/** All constellations known to the service (order is display order). */
export const ALL_CONSTELLATIONS: readonly Constellation[] = [
  'gps',
  'glonass',
  'galileo',
  'beidou',
];

/** Constellations actually enabled in v1 (GPS only — the others are scaffolded). */
export const ENABLED_CONSTELLATIONS: readonly Constellation[] = ['gps'];

/** Maps a constellation to its CelesTrak GROUP query value. */
export const CELESTRAK_GROUPS: Record<Constellation, string> = {
  gps: 'gps-ops',
  glonass: 'glonass-ops',
  galileo: 'galileo',
  beidou: 'beidou',
};

const CELESTRAK_BASE_URL = 'https://celestrak.org/NORAD/elements/gp.php';

/** Cache TTL — CelesTrak refreshes element sets roughly daily. */
export const TLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Builds the CelesTrak GP TLE URL for a constellation group. */
export function celestrakUrl(constellation: Constellation): string {
  const group = CELESTRAK_GROUPS[constellation];
  return `${CELESTRAK_BASE_URL}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
}

/**
 * Parse CelesTrak's 3-line TLE text (name, line1, line2 per satellite) into
 * structured records. Tolerant of blank lines and trailing whitespace; a
 * trailing partial record (missing line2) is dropped rather than throwing.
 */
export function parseTleText(text: string): Tle[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  const tles: Tle[] = [];
  // #4797(2): resync on a misaligned triple instead of stopping. CelesTrak's
  // 3-line format is `name / "1 …" / "2 …"`, but a stray header/comment line
  // (or a blank the trim didn't catch) would shift every subsequent triple by
  // one and, under the old `break`, silently drop the entire rest of the set.
  // Here a line that isn't the start of a valid `1 …`/`2 …` pair is skipped and
  // scanning resumes, so one stray line costs at most one satellite, not all of
  // them.
  let i = 0;
  while (i + 2 < lines.length) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
      tles.push({ name: name.trim(), line1, line2 });
      i += 3;
    } else {
      // Not a well-formed triple at this offset — drop the stray line at `i`
      // and re-test from the next one.
      i += 1;
    }
  }
  return tles;
}

interface CacheEntry {
  tles: Tle[];
  fetchedAt: number;
}

class TleService {
  private cache = new Map<Constellation, CacheEntry>();
  /** Per-constellation in-flight fetch dedup so concurrent callers share one request. */
  private inFlight = new Map<Constellation, Promise<Tle[]>>();

  /** True when a cache entry exists and is within the TTL. */
  private isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
    return !!entry && Date.now() - entry.fetchedAt < TLE_CACHE_TTL_MS;
  }

  /**
   * Return TLEs for one constellation, fetching lazily. Serves a fresh cache
   * without any network I/O; otherwise refetches. On a failed refetch, returns
   * the last-good cache if present, and only throws when there is nothing
   * cached to fall back on.
   */
  async getTles(constellation: Constellation): Promise<Tle[]> {
    const entry = this.cache.get(constellation);
    if (this.isFresh(entry)) return entry.tles;

    const existing = this.inFlight.get(constellation);
    if (existing) return existing;

    const promise = this.fetchAndCache(constellation).finally(() => {
      this.inFlight.delete(constellation);
    });
    this.inFlight.set(constellation, promise);
    return promise;
  }

  /**
   * Return the concatenated TLEs for several constellations. Each is fetched
   * (or cache-served) independently; a constellation that fails AND has no
   * last-good cache is skipped with a warning rather than failing the whole
   * request, so one unreachable group never blanks the others.
   */
  async getTlesForConstellations(constellations: Constellation[]): Promise<Tle[]> {
    const unique = Array.from(new Set(constellations));
    const results = await Promise.all(
      unique.map(async (c) => {
        try {
          return await this.getTles(c);
        } catch (err) {
          logger.warn(`[GNSS] No TLE data available for constellation "${c}": ${String(err)}`);
          return [] as Tle[];
        }
      })
    );
    return results.flat();
  }

  private async fetchAndCache(constellation: Constellation): Promise<Tle[]> {
    const url = celestrakUrl(constellation);
    const stale = this.cache.get(constellation);

    try {
      const response = await safeFetch(url);
      if (!response.ok) {
        logger.warn(`[GNSS] CelesTrak returned ${response.status} for ${constellation}`);
        return this.fallbackOrThrow(constellation, stale, `HTTP ${response.status}`);
      }
      const text = await response.text();
      const tles = parseTleText(text);
      if (tles.length === 0) {
        // An empty/garbled body is a transient failure, not new "no sats" truth.
        logger.warn(`[GNSS] CelesTrak returned no parseable TLEs for ${constellation}`);
        return this.fallbackOrThrow(constellation, stale, 'empty response');
      }
      this.cache.set(constellation, { tles, fetchedAt: Date.now() });
      logger.debug(`[GNSS] Cached ${tles.length} TLEs for ${constellation}`);
      return tles;
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        logger.warn(`[GNSS] TLE fetch blocked by SSRF guard for ${constellation}: ${err.message}`);
      } else {
        logger.warn(`[GNSS] TLE fetch failed for ${constellation}:`, err);
      }
      return this.fallbackOrThrow(constellation, stale, String(err));
    }
  }

  /** Serve last-good cache on failure; throw only when there is nothing cached. */
  private fallbackOrThrow(
    constellation: Constellation,
    stale: CacheEntry | undefined,
    reason: string
  ): Tle[] {
    if (stale) {
      logger.info(
        `[GNSS] Serving stale TLE cache for ${constellation} after fetch failure (${reason})`
      );
      return stale.tles;
    }
    throw new Error(`Unable to fetch TLEs for ${constellation}: ${reason}`);
  }

  /** Test-only: clear all in-memory cache + in-flight state. */
  __resetForTests(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

export const tleService = new TleService();
