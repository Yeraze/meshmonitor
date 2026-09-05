/**
 * Telemetry retention helpers (issue #5080).
 *
 * `telemetryFavorites` and `favoriteTelemetryStorageDays` are BOTH per-source
 * settings. The Dashboard and the Settings "Telemetry" section always render
 * inside a `<SourceProvider>`, so every save they make carries `?sourceId=<id>`
 * and lands under the `source:<id>:` key prefix. The hourly retention purge used
 * to read only the un-namespaced global keys, found nothing, and therefore
 * deleted every favorited chart's history past the 7-day non-favorite window —
 * silently destroying the history the setting exists to preserve.
 *
 * This module turns one `getAllSettings()` snapshot (which contains BOTH
 * namespaces) into the per-entry retention list the purge needs. Kept
 * dependency-free so it can be unit-tested without a database.
 */

import type { TelemetryFavorite } from '../db/repositories/telemetry.js';
import { logger } from './logger.js';

/** Prefix used for per-source setting keys: `source:<sourceId>:<key>`. */
const SOURCE_KEY_PREFIX = 'source:';

const FAVORITES_KEY = 'telemetryFavorites';
const STORAGE_DAYS_KEY = 'favoriteTelemetryStorageDays';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bounds enforced by the Settings UI input (`min=7 max=90`). Applied again here
 * because a hand-edited settings row is not validated by the UI, and a bogus
 * value would otherwise become an unbounded retention window (or an instant
 * purge of every favorite).
 */
export const FAVORITE_STORAGE_DAYS_MIN = 7;
export const FAVORITE_STORAGE_DAYS_MAX = 90;

/** Fallback when nothing valid is configured anywhere. */
export const FAVORITE_STORAGE_DAYS_DEFAULT = 7;

function clampStorageDays(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(FAVORITE_STORAGE_DAYS_MAX, Math.max(FAVORITE_STORAGE_DAYS_MIN, parsed));
}

/**
 * Parse a stored `telemetryFavorites` JSON blob into (nodeId, telemetryType)
 * pairs. Anything malformed yields an empty list — the purge must never widen
 * or narrow retention because a settings row was corrupt.
 */
function parseFavorites(raw: string | undefined, label: string): Array<{ nodeId: string; telemetryType: string }> {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.error(`Failed to parse ${FAVORITES_KEY} from settings (${label})`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as unknown[]).filter(
    (f): f is { nodeId: string; telemetryType: string } => {
      if (!f || typeof f !== 'object') return false;
      const candidate = f as Record<string, unknown>;
      return typeof candidate.nodeId === 'string' && typeof candidate.telemetryType === 'string';
    }
  );
}

/**
 * Extract the sourceId from a per-source settings key, or null if the key is
 * not `source:<id>:<bareKey>` for the given bare key.
 *
 * Split from the END, never with `split(':')` — a sourceId is free to contain
 * a colon and splitting on the first one would corrupt it.
 */
export function sourceIdFromSettingKey(key: string, bareKey: string): string | null {
  const suffix = `:${bareKey}`;
  if (!key.startsWith(SOURCE_KEY_PREFIX) || !key.endsWith(suffix)) return null;
  const id = key.slice(SOURCE_KEY_PREFIX.length, key.length - suffix.length);
  return id.length > 0 ? id : null;
}

/**
 * Build the per-entry favorite retention list the telemetry purge needs, from a
 * full settings snapshot (global keys AND `source:<id>:` keys).
 *
 * Resolution order for a source's retention window:
 *   `source:<id>:favoriteTelemetryStorageDays` → global `favoriteTelemetryStorageDays`
 *   → `defaultDays` argument → {@link FAVORITE_STORAGE_DAYS_DEFAULT}.
 *
 * @param allSettings - snapshot from `SettingsRepository.getAllSettings()`.
 * @param now - epoch ms the cutoffs are measured back from.
 * @param defaultDays - fallback retention when neither namespace configures one.
 */
export function buildFavoriteRetentions(
  allSettings: Record<string, string>,
  now: number,
  defaultDays: number = FAVORITE_STORAGE_DAYS_DEFAULT
): TelemetryFavorite[] {
  const fallbackDays = clampStorageDays(undefined, defaultDays);
  const globalDays = clampStorageDays(allSettings[STORAGE_DAYS_KEY], fallbackDays);

  const retentions: TelemetryFavorite[] = [];

  // Legacy / pre-4.x global favorites list. Carries no sourceId, so it protects
  // the matching (nodeId, telemetryType) rows on every source.
  for (const f of parseFavorites(allSettings[FAVORITES_KEY], 'global')) {
    retentions.push({
      nodeId: f.nodeId,
      telemetryType: f.telemetryType,
      cutoffTimestamp: now - globalDays * DAY_MS,
    });
  }

  // Per-source favorites (#5080) — where every 4.x Dashboard actually writes.
  for (const [key, value] of Object.entries(allSettings)) {
    const sourceId = sourceIdFromSettingKey(key, FAVORITES_KEY);
    if (!sourceId) continue;
    const days = clampStorageDays(
      allSettings[`${SOURCE_KEY_PREFIX}${sourceId}:${STORAGE_DAYS_KEY}`],
      globalDays
    );
    for (const f of parseFavorites(value, `source ${sourceId}`)) {
      retentions.push({
        sourceId,
        nodeId: f.nodeId,
        telemetryType: f.telemetryType,
        cutoffTimestamp: now - days * DAY_MS,
      });
    }
  }

  return retentions;
}
