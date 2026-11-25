/**
 * Walkabout Coverage constants and pure helpers (#5891, Phase 1).
 *
 * Frontend-safe: no `src/server` imports. Spec: WALKABOUT_P1_SPEC.md §2.1.
 */
export const WALKABOUT_MAX_DURATION_MS = 2 * 3_600_000; // hard cap
export const WALKABOUT_MAX_ACCURACY_M = 100; // drop above
export const WALKABOUT_WARN_ACCURACY_M = 30; // warn above
export const WALKABOUT_MIN_SAMPLE_SPACING_MS = 5_000; // exact, on device fix timestamps, both sides
export const WALKABOUT_SAMPLE_FRESH_MS = 25_000; // §2.10
export const WALKABOUT_MAX_SAMPLE_AGE_MS = 30_000; // a fix older than this on arrival is dropped
export const WALKABOUT_POST_INTERVAL_MS = 10_000; // client post cadence (§2.8)
export const WALKABOUT_MAX_SAMPLES_PER_POST = 4; // 2 normal + catch-up after a failed post
export const WALKABOUT_HEARTBEAT_MS = 5_000; // client forces a fix after this much silence
export const WALKABOUT_CLOCK_RESET_MS = 60_000; // device timestamp this far backwards = phone clock reset
export const WALKABOUT_NAME_MAX = 120;
export const WALKABOUT_LIST_LIMIT = 200;

/** Per-source grants (Q1). Routes and UI both read these. */
export const WALKABOUT_WRITE_GRANT = { resource: 'nodes', action: 'write' } as const;
export const WALKABOUT_READ_GRANT = { resource: 'nodes', action: 'read' } as const;

export type WalkaboutEndReason = 'user' | 'cap';

interface WalkaboutWindow {
  startedAt: number;
  endedAt: number | null;
}

/** startedAt + cap while open; else endedAt. */
export function walkaboutEndsAt(s: WalkaboutWindow): number {
  return s.endedAt ?? s.startedAt + WALKABOUT_MAX_DURATION_MS;
}

/** Open and not past its cap. The cap is computed here, never held in a timer. */
export function isWalkaboutLive(s: WalkaboutWindow, nowMs: number): boolean {
  return s.endedAt == null && nowMs < s.startedAt + WALKABOUT_MAX_DURATION_MS;
}
