/**
 * Asset Tracking constants and pure helpers (#5354).
 *
 * Shared by the server (routes, purge, payload overlay) and the client (Node
 * Details section). No I/O here, so it stays trivially testable.
 */

/** Days of telemetry kept for a newly flagged asset. */
export const ASSET_RETENTION_DAYS_DEFAULT = 90;

/** Inclusive bounds for an asset's retention, in days. */
export const ASSET_RETENTION_DAYS_RANGE = { min: 1, max: 365 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Strictly parse a retention value from untrusted input (a request body).
 * Returns the integer when it is a whole number inside the range, else null.
 * Numeric strings are accepted ("30"); fractions, blanks and junk are not.
 */
export function parseAssetRetentionDays(raw: unknown): number | null {
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) {
    n = Number(raw.trim());
  } else {
    return null;
  }
  if (!Number.isInteger(n)) return null;
  if (n < ASSET_RETENTION_DAYS_RANGE.min || n > ASSET_RETENTION_DAYS_RANGE.max) return null;
  return n;
}

/**
 * Forgiving clamp for UI input and stored values: rounds, then pins into the
 * range. Non-numeric input falls back to the default.
 */
export function clampAssetRetentionDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return ASSET_RETENTION_DAYS_DEFAULT;
  const rounded = Math.round(n);
  return Math.min(ASSET_RETENTION_DAYS_RANGE.max, Math.max(ASSET_RETENTION_DAYS_RANGE.min, rounded));
}

/** Epoch-ms cutoff for an asset's telemetry: rows older than this are purged. */
export function assetRetentionCutoff(retentionDays: number, now: number = Date.now()): number {
  return now - clampAssetRetentionDays(retentionDays) * DAY_MS;
}

/**
 * The effective mobility shown to clients: the heuristic `mobile` column OR
 * the asset flag. A computed overlay only — it is never written back to the
 * `mobile` column and never drives the `becameMobile` trigger.
 */
export function effectiveIsMobile(mobile: unknown, asset: unknown): boolean {
  return mobile === 1 || mobile === true || !!asset;
}

/**
 * Estimated rows an asset keeps: the node's telemetry rows over the last
 * 24 hours times its retention days. Null when there is no recent data, so the
 * UI can say "unknown" rather than "0".
 */
export function estimateAssetRows(rowsLast24h: number, retentionDays: number): number | null {
  if (!Number.isFinite(rowsLast24h) || rowsLast24h <= 0) return null;
  return Math.round(rowsLast24h * clampAssetRetentionDays(retentionDays));
}
