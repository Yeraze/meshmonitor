import { describe, it, expect } from 'vitest';
import {
  isStaleReplayRxTime,
  resolveLastHeardSec,
  MIN_PLAUSIBLE_UNIX_SEC,
  STALE_REPLAY_THRESHOLD_SEC,
} from './replayGuard.js';

// A fixed "now" well after the 2020 floor: 2026-06-19T00:00:00Z.
const NOW_SEC = 1_781_913_600;
const NOW_MS = NOW_SEC * 1000;

describe('isStaleReplayRxTime', () => {
  it('flags a packet whose rx_time is weeks in the past (the reported replay)', () => {
    // ~20-day-old frozen telemetry, as seen in the field report.
    const rxTime = NOW_SEC - 20 * 24 * 60 * 60;
    expect(isStaleReplayRxTime(rxTime, NOW_SEC)).toBe(true);
  });

  it('does not flag a live packet received roughly now', () => {
    expect(isStaleReplayRxTime(NOW_SEC, NOW_SEC)).toBe(false);
    expect(isStaleReplayRxTime(NOW_SEC - 5, NOW_SEC)).toBe(false);
  });

  it('tolerates ordinary clock skew / delivery jitter below the threshold', () => {
    const justUnder = NOW_SEC - (STALE_REPLAY_THRESHOLD_SEC - 60);
    expect(isStaleReplayRxTime(justUnder, NOW_SEC)).toBe(false);
  });

  it('flags exactly past the threshold boundary', () => {
    const justOver = NOW_SEC - (STALE_REPLAY_THRESHOLD_SEC + 1);
    expect(isStaleReplayRxTime(justOver, NOW_SEC)).toBe(true);
    // Exactly at the threshold is not yet stale (strict greater-than).
    const atBoundary = NOW_SEC - STALE_REPLAY_THRESHOLD_SEC;
    expect(isStaleReplayRxTime(atBoundary, NOW_SEC)).toBe(false);
  });

  it('ignores unset / boot-relative clocks (rx_time below the 2020 floor)', () => {
    expect(isStaleReplayRxTime(0, NOW_SEC)).toBe(false);
    expect(isStaleReplayRxTime(244027, NOW_SEC)).toBe(false); // looks like uptime, not unix time
    expect(isStaleReplayRxTime(MIN_PLAUSIBLE_UNIX_SEC - 1, NOW_SEC)).toBe(false);
  });

  it('treats absent or non-finite rx_time as not-stale (stamp now)', () => {
    expect(isStaleReplayRxTime(undefined, NOW_SEC)).toBe(false);
    expect(isStaleReplayRxTime(null, NOW_SEC)).toBe(false);
    expect(isStaleReplayRxTime(NaN, NOW_SEC)).toBe(false);
  });

  it('never flags a future-dated rx_time as stale', () => {
    expect(isStaleReplayRxTime(NOW_SEC + 10_000, NOW_SEC)).toBe(false);
  });
});

describe('resolveLastHeardSec', () => {
  it('returns now (seconds) for a live packet', () => {
    expect(resolveLastHeardSec(NOW_SEC, NOW_MS)).toBe(NOW_SEC);
  });

  it('returns undefined for a stale replay so the upsert preserves existing lastHeard', () => {
    const rxTime = NOW_SEC - 20 * 24 * 60 * 60;
    expect(resolveLastHeardSec(rxTime, NOW_MS)).toBeUndefined();
  });

  it('returns now when rx_time is absent', () => {
    expect(resolveLastHeardSec(undefined, NOW_MS)).toBe(NOW_SEC);
  });
});
