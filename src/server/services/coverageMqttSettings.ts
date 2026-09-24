/**
 * Per-source TTL cache for the `coverage_mqtt_enabled` flag (#5277 P2, §2.1).
 *
 * The MQTT recording hook (`coverageMqtt.ts`) checks this on every POSITION
 * packet that reaches it, for every MQTT source — most of which have the
 * flag off. Reading `databaseService.settings.getSettingForSource` on every
 * packet would be one settings-table read per position on a busy broker, so
 * the result is cached for `CACHE_TTL_MS` per source and invalidated
 * explicitly the moment a save changes it (`settingsRoutes.ts`, next to
 * `meshcoreReceiveOnly`), so a save takes effect immediately rather than
 * waiting out the TTL.
 *
 * **Always reads via `getSettingForSource(sourceId, key)` — never the bare
 * key** (`databaseService.getSettingAsync`). A global, unscoped
 * `coverage_mqtt_enabled` row must have zero effect on any source (#5080).
 *
 * Fail-closed: a read error caches `false` for the TTL and logs at debug.
 * Recording nothing is always the safe side of a settings-read failure.
 */

import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { COVERAGE_MQTT_ENABLED_SETTING, isCoverageMqttFlagOn } from '../../utils/coverage.js';

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: boolean;
  expires: number;
}

// One entry per MQTT source — small and bounded by the number of registered
// MQTT sources, so this needs no LRU eviction.
const cache = new Map<string, CacheEntry>();

/**
 * Whether Coverage Report MQTT gateway-reception recording is turned on for
 * `sourceId`. Default off (no row → `false`). Cached for `CACHE_TTL_MS`.
 */
export async function isCoverageMqttEnabled(sourceId: string): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(sourceId);
  if (cached && now < cached.expires) {
    return cached.value;
  }

  try {
    const raw = await databaseService.settings.getSettingForSource(sourceId, COVERAGE_MQTT_ENABLED_SETTING);
    const value = isCoverageMqttFlagOn(raw);
    cache.set(sourceId, { value, expires: now + CACHE_TTL_MS });
    return value;
  } catch (err) {
    logger.debug(`Coverage MQTT recording flag read failed for source ${sourceId} (non-fatal, treated as off): ${err}`);
    cache.set(sourceId, { value: false, expires: now + CACHE_TTL_MS });
    return false;
  }
}

/**
 * Force the next {@link isCoverageMqttEnabled} read for `sourceId` to go
 * back to the settings table, bypassing the TTL. Called from
 * `settingsRoutes.ts` the moment a per-source save touches this key, so a
 * toggle takes effect immediately instead of waiting out the cache. Omit
 * `sourceId` to clear every cached source (test seam / bulk invalidation).
 */
export function invalidateCoverageMqttEnabled(sourceId?: string): void {
  if (sourceId === undefined) {
    cache.clear();
  } else {
    cache.delete(sourceId);
  }
}

/** Test seam — clears the cache between cases. */
export function __resetCoverageMqttCacheForTest(): void {
  cache.clear();
}
