/**
 * Timeline playback over a tracked asset's trail (#5354 Phase 3).
 *
 * Pure helpers only, so the playback bar can stay a thin shell around them and
 * the maths is testable without Leaflet or a DOM. Every function expects the
 * fixes in chronological order (the order the map already holds them in) and
 * uses a binary search on `timestamp`, so a 2,000-point trail costs ~11
 * comparisons per lookup, which matters at 60 lookups a second.
 *
 * Gaps come from Phase 2: the first fix after a gap of more than 30 min carries
 * `segmentStart: true` (see `flattenAssetTrack`). Playback never interpolates
 * across one, because a straight line between two drives would invent a route
 * the asset never took.
 */

/** Minimal fix shape the playback helpers need. */
export interface PlaybackFix {
  latitude: number;
  longitude: number;
  /** Milliseconds since the epoch. */
  timestamp: number;
  segmentStart?: boolean;
}

/** Where the playback marker sits at a given time. */
export interface PlaybackPosition {
  lat: number;
  lon: number;
  /** Index of the fix at or before the time (clamped to the track). */
  index: number;
  /** True while the time falls inside a gap; the marker is held and dimmed. */
  inGap: boolean;
}

/** A shaded region of the timeline: the time between two gap-separated fixes. */
export interface TimelineGap {
  start: number;
  end: number;
}

/**
 * Index of the last fix whose timestamp is at or before `t`, or -1 when `t` is
 * before the first fix. With duplicate timestamps, the LAST of the run wins, so
 * stepping forward from it always moves time on.
 */
export function indexAtOrBefore(fixes: readonly PlaybackFix[], t: number): number {
  let lo = 0;
  let hi = fixes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid].timestamp <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Marker position at time `t`.
 *
 * - Before the first fix: the first fix. After the last: the last.
 * - Between two fixes of one segment: linear interpolation by time.
 * - Inside a gap: held at the last fix before it, with `inGap` set.
 *
 * Returns null for an empty track.
 */
export function positionAt(fixes: readonly PlaybackFix[], t: number): PlaybackPosition | null {
  if (fixes.length === 0) return null;
  const lastIndex = fixes.length - 1;
  if (t <= fixes[0].timestamp) {
    return { lat: fixes[0].latitude, lon: fixes[0].longitude, index: 0, inGap: false };
  }
  if (t >= fixes[lastIndex].timestamp) {
    const last = fixes[lastIndex];
    return { lat: last.latitude, lon: last.longitude, index: lastIndex, inGap: false };
  }

  const index = indexAtOrBefore(fixes, t);
  const from = fixes[index];
  const to = fixes[index + 1];
  if (from.timestamp === t) {
    return { lat: from.latitude, lon: from.longitude, index, inGap: false };
  }
  if (to.segmentStart) {
    return { lat: from.latitude, lon: from.longitude, index, inGap: true };
  }
  const span = to.timestamp - from.timestamp;
  // `to` is strictly after `t` and `from` at or before it, so span > 0; the
  // guard only keeps a malformed (unsorted) input from producing NaN.
  const f = span > 0 ? (t - from.timestamp) / span : 0;
  return {
    lat: from.latitude + (to.latitude - from.latitude) * f,
    lon: from.longitude + (to.longitude - from.longitude) * f,
    index,
    inGap: false,
  };
}

/**
 * Time ranges the timeline shades as gaps: from the last fix of one segment to
 * the first fix of the next. A `segmentStart` on the very first fix (possible
 * once the hours filter has cut the track) marks a gap before the timeline
 * starts, so it is skipped.
 */
export function timelineGaps(fixes: readonly PlaybackFix[]): TimelineGap[] {
  const gaps: TimelineGap[] = [];
  for (let i = 1; i < fixes.length; i++) {
    if (fixes[i].segmentStart) {
      gaps.push({ start: fixes[i - 1].timestamp, end: fixes[i].timestamp });
    }
  }
  return gaps;
}

/**
 * Fixes drawn while "trail up to cursor" is on: those at or before `t`.
 * Returns the input unchanged when `t` is null.
 */
export function fixesUpTo<T extends PlaybackFix>(fixes: T[], t: number | null): T[] {
  if (t === null) return fixes;
  return fixes.slice(0, indexAtOrBefore(fixes, t) + 1);
}

/** Time of the next fix strictly after `t`, or the track end. */
export function nextFixTime(fixes: readonly PlaybackFix[], t: number): number {
  if (fixes.length === 0) return t;
  const next = fixes[indexAtOrBefore(fixes, t) + 1];
  return next ? next.timestamp : fixes[fixes.length - 1].timestamp;
}

/** Time of the last fix strictly before `t`, or the track start. */
export function previousFixTime(fixes: readonly PlaybackFix[], t: number): number {
  if (fixes.length === 0) return t;
  // The cursor can be fractional mid-playback, so walk back past any fix AT t
  // rather than searching for t - 1.
  let index = indexAtOrBefore(fixes, t);
  while (index >= 0 && fixes[index].timestamp >= t) index--;
  return index >= 0 ? fixes[index].timestamp : fixes[0].timestamp;
}

/** Index of the fix nearest in time to `t` (for the readout's speed). */
export function nearestFixIndex(fixes: readonly PlaybackFix[], t: number): number {
  if (fixes.length === 0) return -1;
  const before = indexAtOrBefore(fixes, t);
  if (before < 0) return 0;
  const after = before + 1;
  if (after >= fixes.length) return before;
  return t - fixes[before].timestamp <= fixes[after].timestamp - t ? before : after;
}

/**
 * Playback speeds (#5354 D2): 1 min, 10 min or 1 h of track per second.
 */
export const PLAYBACK_SPEEDS = [60, 600, 3600] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];
export const DEFAULT_PLAYBACK_SPEED: PlaybackSpeed = 600;
export const PLAYBACK_SPEED_STORAGE_KEY = 'mm-asset-playback-speed';

/** The remembered speed, or the default when storage is empty, bad, or blocked. */
export function readStoredPlaybackSpeed(): PlaybackSpeed {
  try {
    const raw = Number(localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY));
    return (PLAYBACK_SPEEDS as readonly number[]).includes(raw) ? (raw as PlaybackSpeed) : DEFAULT_PLAYBACK_SPEED;
  } catch {
    return DEFAULT_PLAYBACK_SPEED;
  }
}

/** Remember the speed; a blocked storage is not an error worth surfacing. */
export function writeStoredPlaybackSpeed(speed: PlaybackSpeed): void {
  try {
    localStorage.setItem(PLAYBACK_SPEED_STORAGE_KEY, String(speed));
  } catch {
    // Private window or blocked site data: the speed just isn't remembered.
  }
}

/**
 * Whether a container point lies outside the central `fraction` of a view
 * (#5354 follow mode pans only then, so the map doesn't jitter every frame).
 */
export function isOutsideCentralRegion(
  point: { x: number; y: number },
  size: { x: number; y: number },
  fraction = 0.7,
): boolean {
  const marginX = (size.x * (1 - fraction)) / 2;
  const marginY = (size.y * (1 - fraction)) / 2;
  return point.x < marginX || point.x > size.x - marginX || point.y < marginY || point.y > size.y - marginY;
}

/** Minimum time between two follow pans. */
export const FOLLOW_PAN_INTERVAL_MS = 500;
/** Interval between React state commits during playback (~5 Hz). */
export const PLAYBACK_COMMIT_INTERVAL_MS = 200;

/**
 * Whether the Nodes map shows the playback bar (#5354 D1): the selected node is
 * an asset, its own server track is loaded (not a previous node's), Show
 * Position History is on, and more than one fix survives the hours filter.
 */
export function shouldShowAssetPlayback(opts: {
  isAsset: boolean;
  assetTrackLoaded: boolean;
  showPositionHistory: boolean;
  fixCount: number;
}): boolean {
  return opts.isAsset && opts.assetTrackLoaded && opts.showPositionHistory && opts.fixCount > 1;
}
