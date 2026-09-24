import { describe, it, expect } from 'vitest';
import {
  isStaleReplayRxTime,
  resolveLastHeardSec,
  isLiveReception,
  MIN_PLAUSIBLE_UNIX_SEC,
  STALE_REPLAY_THRESHOLD_SEC,
  LIVE_RECEPTION_WINDOW_SEC,
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

describe('isLiveReception (#5101 P3 counter fix)', () => {
  it('treats absent rx_time as live (node has no clock, cannot be a replay)', () => {
    expect(isLiveReception(undefined, NOW_MS)).toBe(true);
    expect(isLiveReception(null, NOW_MS)).toBe(true);
    expect(isLiveReception(NaN, NOW_MS)).toBe(true);
  });

  it('treats an implausible (boot-relative) rx_time as live', () => {
    expect(isLiveReception(0, NOW_MS)).toBe(true);
    expect(isLiveReception(244027, NOW_MS)).toBe(true);
    expect(isLiveReception(MIN_PLAUSIBLE_UNIX_SEC - 1, NOW_MS)).toBe(true);
  });

  it('treats a packet received roughly now as live', () => {
    expect(isLiveReception(NOW_SEC, NOW_MS)).toBe(true);
    expect(isLiveReception(NOW_SEC - 5, NOW_MS)).toBe(true);
  });

  it('tolerates ordinary delivery jitter just under the window', () => {
    const justUnder = NOW_SEC - (LIVE_RECEPTION_WINDOW_SEC - 1);
    expect(isLiveReception(justUnder, NOW_MS)).toBe(true);
  });

  it('is not live exactly past the window boundary', () => {
    const atBoundary = NOW_SEC - LIVE_RECEPTION_WINDOW_SEC;
    expect(isLiveReception(atBoundary, NOW_MS)).toBe(true); // <=, inclusive
    const justOver = NOW_SEC - (LIVE_RECEPTION_WINDOW_SEC + 1);
    expect(isLiveReception(justOver, NOW_MS)).toBe(false);
  });

  it('rejects a #5034-shaped replay: rx_time frozen 30 minutes in the past', () => {
    const rxTime = NOW_SEC - 30 * 60;
    expect(isLiveReception(rxTime, NOW_MS)).toBe(false);
    // The same packet is still NOT flagged as a stale replay for lastHeard
    // purposes — well under STALE_REPLAY_THRESHOLD_SEC (6h) — confirming
    // this is a stricter, separate gate from resolveLastHeardSec/#4192.
    expect(isStaleReplayRxTime(rxTime, NOW_SEC)).toBe(false);
  });

  it('rejects a multi-day/week-old replay (the original #4192 field report)', () => {
    const rxTime = NOW_SEC - 20 * 24 * 60 * 60;
    expect(isLiveReception(rxTime, NOW_MS)).toBe(false);
  });

  it('accepts small future skew (receiving node clock slightly ahead)', () => {
    expect(isLiveReception(NOW_SEC + 5, NOW_MS)).toBe(true);
    expect(isLiveReception(NOW_SEC + 60, NOW_MS)).toBe(true);
  });
});
