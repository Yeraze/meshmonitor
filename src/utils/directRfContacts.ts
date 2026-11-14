/**
 * Direct RF Contacts (#6210): shared constants for the server and the UI.
 */

/** Global setting key: days of `direct_rf_contacts` history to keep. */
export const DIRECT_RF_RETENTION_SETTING = 'direct_rf_contacts_retention_days';
export const DIRECT_RF_RETENTION_DEFAULT_DAYS = 30;
export const DIRECT_RF_RETENTION_MIN_DAYS = 1;
export const DIRECT_RF_RETENTION_MAX_DAYS = 365;

/**
 * Parse a stored retention value, clamped to
 * `[DIRECT_RF_RETENTION_MIN_DAYS, DIRECT_RF_RETENTION_MAX_DAYS]`. Missing or
 * junk input gives the 30-day default.
 */
export function clampDirectRfRetentionDays(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return DIRECT_RF_RETENTION_DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DIRECT_RF_RETENTION_DEFAULT_DAYS;
  return Math.max(DIRECT_RF_RETENTION_MIN_DAYS, Math.min(Math.trunc(n), DIRECT_RF_RETENTION_MAX_DAYS));
}
