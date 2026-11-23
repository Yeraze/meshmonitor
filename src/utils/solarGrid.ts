/**
 * Open-Meteo solar grid / refresh options and call-budget math (#6523).
 *
 * Shared by the server scheduler (openMeteoSolarService) and the Settings UI,
 * so it must stay browser-safe: no Node imports, no Buffer.
 */

/** Grid sizes offered in Settings, in degrees (0.1° ≈ 11 km). */
export const SOLAR_GRID_SIZES = [0.05, 0.1, 0.25, 0.5, 1] as const;
export const DEFAULT_SOLAR_GRID_SIZE = 0.1;
/** Refresh intervals offered in Settings, in hours. */
export const SOLAR_REFRESH_HOURS = [1, 2, 3, 6, 12, 24] as const;
export const DEFAULT_SOLAR_REFRESH_HOURS = 3;
/** Free tier allows < 10,000 calls/day; keep a margin for manual use. */
export const FREE_DAILY_BUDGET = 9000;

/** Open-Meteo calls per day for `cells` refreshed every `refreshHours`. */
export function callsPerDay(cells: number, refreshHours: number): number {
  return Math.ceil((cells * 24) / refreshHours);
}

/** Most cells the free tier can refresh every `refreshHours`. */
export function freeTierCellCap(refreshHours: number): number {
  return Math.floor((FREE_DAILY_BUDGET * refreshHours) / 24);
}

/** Tooltip text for one sunlight overlay value, e.g. "420 W/m²". */
export function formatSunlight(value: unknown): string {
  return typeof value === 'number' ? `${Math.round(value)} W/m²` : '';
}

/** A stored grid/refresh setting as an option value; unknown values read as `fallback`. */
export function pickSolarOption(raw: unknown, allowed: readonly number[], fallback: number): string {
  const n = Number(raw);
  return String(typeof raw === 'string' && raw.trim() !== '' && allowed.includes(n) ? n : fallback);
}
