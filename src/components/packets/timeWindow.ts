/** Time-window keys and the `since` (epoch ms) each maps to (#6262). */
const HOUR_MS = 3_600_000;

export const TIME_WINDOWS = [
  { key: '1h', ms: HOUR_MS },
  { key: '6h', ms: 6 * HOUR_MS },
  { key: '24h', ms: 24 * HOUR_MS },
  { key: '7d', ms: 168 * HOUR_MS },
] as const;

export type TimeWindowKey = (typeof TIME_WINDOWS)[number]['key'] | 'all';

export function windowToSince(key: TimeWindowKey, now: number = Date.now()): number | undefined {
  const w = TIME_WINDOWS.find(t => t.key === key);
  return w ? now - w.ms : undefined;
}
