/**
 * Pure rules for `trigger.clockOutOfSync` (#6273). Shared by the engine and the
 * tests; no server or React imports.
 *
 * Offsets are receipt time minus the node's own time, in seconds, so a positive
 * offset means the node is behind (same sign as `securityClock.ts`).
 */
import { isClockNotSet, formatCompactSpan } from './securityClock.js';

/** Default alert threshold (seconds). */
export const CLOCK_OUT_OF_SYNC_DEFAULT_SECONDS = 300;
/** The floor covers flood relay delay plus a Repeater clock's 60 s resolution. */
export const CLOCK_OUT_OF_SYNC_MIN_SECONDS = 120;
export const CLOCK_OUT_OF_SYNC_MAX_SECONDS = 86400;

/** The threshold from trigger params, or null when it is missing or out of range. */
export function parseClockThresholdSeconds(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (n < CLOCK_OUT_OF_SYNC_MIN_SECONDS || n > CLOCK_OUT_OF_SYNC_MAX_SECONDS) return null;
  return n;
}

/**
 * True when this sample starts an out-of-sync episode: the current and the
 * previous sample are both past the threshold and the one before that was not.
 * A missing sample counts as in sync, so a node needs two consecutive bad
 * samples, and it fires once per episode.
 */
export function isClockOutOfSyncEdge(
  offsetSeconds: number,
  previousOffsets: readonly number[],
  thresholdSeconds: number,
): boolean {
  const out = (v: number | undefined) => v !== undefined && Number.isFinite(v) && Math.abs(v) > thresholdSeconds;
  return out(offsetSeconds) && out(previousOffsets[0]) && !out(previousOffsets[1]);
}

export type ClockDirection = 'behind' | 'ahead' | 'notSet';

export function clockDirection(offsetSeconds: number): ClockDirection {
  if (isClockNotSet(offsetSeconds)) return 'notSet';
  return offsetSeconds >= 0 ? 'behind' : 'ahead';
}

/** "2h 14m behind", "5m ahead" or "Clock not set". */
export function clockOffsetText(offsetSeconds: number): string {
  const dir = clockDirection(offsetSeconds);
  if (dir === 'notSet') return 'Clock not set';
  return `${formatCompactSpan(offsetSeconds)} ${dir}`;
}
