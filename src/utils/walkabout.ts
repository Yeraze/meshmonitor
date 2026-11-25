/**
 * Walkabout Coverage constants and pure helpers (#5891, Phases 1 and 2).
 *
 * Frontend-safe: no `src/server` imports, and NEVER `h3-js` (WalkaboutReport
 * imports this statically; the library must stay in the lazy hex-map chunk).
 * Spec: WALKABOUT_P1_SPEC.md §2.1, WALKABOUT_P2_SPEC.md §2.6.
 */
import type { WalkaboutH3Res } from '../types/walkabout.js';

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
/** Source types a walkabout can run on (their radio hears the walker). */
export const WALKABOUT_SOURCE_TYPES: ReadonlySet<string> = new Set(['meshtastic_tcp', 'meshcore']);
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

// --- Phase 2: map (WALKABOUT_P2_SPEC.md §2.6) ---
export const WALKABOUT_H3_BASE_RES = 9;
export const WALKABOUT_MAP_WINDOWS_MS = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '14d': 14 * 86_400_000,
  '30d': 30 * 86_400_000,
} as const;
export const WALKABOUT_MAX_RANGE_MS = 31 * 86_400_000; // since/until span cap
export const WALKABOUT_MAX_RX_ROWS = 100_000;
export const WALKABOUT_MAX_SAMPLE_ROWS = 100_000;
export const WALKABOUT_MAX_CELLS = 5_000;
export const WALKABOUT_MAX_CELL_NODES = 200;
export const WALKABOUT_MAX_TRACK_POINTS = 2_000; // 2 h / 5 s = 1 440, plus slack
export const WALKABOUT_MAX_RANGE_SESSIONS = 500;
/** Epic defaults, dB. A value equal to a bound belongs to the band above it. */
export const WALKABOUT_SNR_STRONG_DB = 0; // strong: snr >= 0
export const WALKABOUT_SNR_MEDIUM_DB = -5; // medium: -5 <= snr < 0
export const WALKABOUT_SNR_WEAK_DB = -10; // weak: -10 <= snr < -5; none: snr < -10

export type WalkaboutBucket = 'strong' | 'medium' | 'weak' | 'none' | 'unknown';

/** receptionCount 0 (walked here, heard nothing) -> 'none'.
 *  Receptions but every SNR null -> 'unknown'. */
export function walkaboutBucket(c: { bestSnr: number | null; receptionCount: number }): WalkaboutBucket {
  if (c.receptionCount <= 0) return 'none';
  if (c.bestSnr == null) return 'unknown';
  if (c.bestSnr >= WALKABOUT_SNR_STRONG_DB) return 'strong';
  if (c.bestSnr >= WALKABOUT_SNR_MEDIUM_DB) return 'medium';
  if (c.bestSnr >= WALKABOUT_SNR_WEAK_DB) return 'weak';
  return 'none';
}

/** zoom >= 14 -> 9; 12..13 -> 8; <= 11 -> 7. */
export function walkaboutResForZoom(zoom: number): WalkaboutH3Res {
  if (zoom >= 14) return 9;
  if (zoom >= 12) return 8;
  return 7;
}
