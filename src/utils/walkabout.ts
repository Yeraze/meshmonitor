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

// --- #6571: per-source band edges ---
/** Per-source setting key. Value: "strong,medium,weak" in dB, e.g. "0,-5,-10".
 *  Blank or missing = the defaults below. */
export const WALKABOUT_SNR_BANDS_SETTING = 'walkaboutSnrBands';
/** Sane range for any edge, dB. */
export const WALKABOUT_SNR_BAND_RANGE = { min: -30, max: 20 } as const;

/** Lower edge of each band, dB. strong > medium > weak. */
export interface WalkaboutSnrBands {
  strong: number;
  medium: number;
  weak: number;
}

export const WALKABOUT_DEFAULT_SNR_BANDS: Readonly<WalkaboutSnrBands> = Object.freeze({
  strong: WALKABOUT_SNR_STRONG_DB,
  medium: WALKABOUT_SNR_MEDIUM_DB,
  weak: WALKABOUT_SNR_WEAK_DB,
});

export type WalkaboutSnrBandsError = 'not_number' | 'out_of_range' | 'not_descending';

/** null when valid. Edges must be finite, in range, and strictly descending. */
export function validateWalkaboutSnrBands(b: WalkaboutSnrBands): WalkaboutSnrBandsError | null {
  const edges = [b.strong, b.medium, b.weak];
  if (edges.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return 'not_number';
  const { min, max } = WALKABOUT_SNR_BAND_RANGE;
  if (edges.some((v) => v < min || v > max)) return 'out_of_range';
  if (!(b.strong > b.medium && b.medium > b.weak)) return 'not_descending';
  return null;
}

/** "0,-5,-10" -> bands; null when the text is malformed (not three numbers). */
export function parseWalkaboutSnrBandsText(raw: string): WalkaboutSnrBands | null {
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => p === '')) return null;
  const [strong, medium, weak] = parts.map(Number);
  return { strong, medium, weak };
}

/** Stored value -> bands. Missing, blank or invalid falls back to the defaults,
 *  so a bad row can never break the map. */
export function parseWalkaboutSnrBands(raw: string | null | undefined): WalkaboutSnrBands {
  if (raw == null || raw.trim() === '') return { ...WALKABOUT_DEFAULT_SNR_BANDS };
  const b = parseWalkaboutSnrBandsText(raw);
  return b && validateWalkaboutSnrBands(b) == null ? b : { ...WALKABOUT_DEFAULT_SNR_BANDS };
}

export function formatWalkaboutSnrBands(b: WalkaboutSnrBands): string {
  return `${b.strong},${b.medium},${b.weak}`;
}

/** receptionCount 0 (walked here, heard nothing) -> 'none'.
 *  Receptions but every SNR null -> 'unknown'. */
export function walkaboutBucket(
  c: { bestSnr: number | null; receptionCount: number },
  bands: WalkaboutSnrBands = WALKABOUT_DEFAULT_SNR_BANDS,
): WalkaboutBucket {
  if (c.receptionCount <= 0) return 'none';
  if (c.bestSnr == null) return 'unknown';
  if (c.bestSnr >= bands.strong) return 'strong';
  if (c.bestSnr >= bands.medium) return 'medium';
  if (c.bestSnr >= bands.weak) return 'weak';
  return 'none';
}

/** zoom >= 14 -> 9; 12..13 -> 8; <= 11 -> 7. */
export function walkaboutResForZoom(zoom: number): WalkaboutH3Res {
  if (zoom >= 14) return 9;
  if (zoom >= 12) return 8;
  return 7;
}

// --- Export / import (#6573) ---
export const WALKABOUT_EXPORT_FORMAT = 'meshmonitor-walkabout' as const;
export const WALKABOUT_EXPORT_VERSION = 1;
/** Sessions per import file. */
export const WALKABOUT_IMPORT_MAX_SESSIONS = 50;
