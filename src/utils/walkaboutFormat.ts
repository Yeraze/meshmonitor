/** Display helpers for the Walkabout card (#5891 P1). */

/** `1:05:09` or `5:09` from milliseconds. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Whole minutes, at least 1, for the "GPS paused" banner. */
export function pausedMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}
