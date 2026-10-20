/**
 * Telemetry chart time-range presets, shared by the per-node graphs and the
 * cross-source Telemetry Dashboard (#5896).
 */

/** Server-side telemetry retention window (see TELEMETRY_RETENTION_HOURS). */
export const TELEMETRY_RETENTION_HOURS = 168;

/**
 * Selectable telemetry windows, shortest to longest. Capped at the retention
 * window so no button can request data that has already been purged. Hours are
 * fractional where needed (0.25h = 15 minutes); the backend parses with
 * parseFloat and averages each window down to a manageable point count.
 */
export const TELEMETRY_RANGE_PRESETS: { label: string; hours: number }[] = [
  { label: '15m', hours: 0.25 },
  { label: '1h', hours: 1 },
  { label: '3h', hours: 3 },
  { label: '6h', hours: 6 },
  { label: '12h', hours: 12 },
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
].filter(p => p.hours <= TELEMETRY_RETENTION_HOURS);
