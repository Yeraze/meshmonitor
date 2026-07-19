import { describe, it, expect } from 'vitest';
import { canonicalMessageTime, messageReceivedAt, plausibleRxTime } from './messageTime.js';

describe('plausibleRxTime', () => {
  it('returns a plausible rxTime unchanged', () => {
    expect(plausibleRxTime(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('returns null for 0, a boot-uptime value, negative, null, or undefined', () => {
    expect(plausibleRxTime(0)).toBeNull();
    expect(plausibleRxTime(114_571_000)).toBeNull();
    expect(plausibleRxTime(-5)).toBeNull();
    expect(plausibleRxTime(null)).toBeNull();
    expect(plausibleRxTime(undefined)).toBeNull();
  });
});

describe('canonicalMessageTime', () => {
  it('prefers a positive rxTime over timestamp', () => {
    expect(canonicalMessageTime({ rxTime: 1_700_000_000_000, timestamp: 1 })).toBe(1_700_000_000_000);
  });

  it('falls back to timestamp when rxTime is 0 (MQTT unset gateway time)', () => {
    // Regression for the "December 31, 1969" MQTT bug: rxTime === 0 must not
    // win over the real server timestamp.
    expect(canonicalMessageTime({ rxTime: 0, timestamp: 1_700_000_000_000 })).toBe(1_700_000_000_000);
  });

  it('falls back to timestamp when rxTime is null or undefined', () => {
    expect(canonicalMessageTime({ rxTime: null, timestamp: 42 })).toBe(42);
    expect(canonicalMessageTime({ timestamp: 42 })).toBe(42);
  });

  it('treats a negative rxTime as missing', () => {
    expect(canonicalMessageTime({ rxTime: -5, timestamp: 99 })).toBe(99);
  });

  it('falls back to timestamp when rxTime is a small nonzero boot-uptime value (unsynced RTC, #4206)', () => {
    // Regression: a node without a valid RTC reports rxTime as seconds-since-boot
    // (e.g. 114571s -> 114571000ms, ~1970-01-02), which is nonzero and would pass
    // a naive `rxTime > 0` check. Must fall back to the server timestamp instead
    // of rendering an early-1970 date.
    expect(canonicalMessageTime({ rxTime: 114_571_000, timestamp: 1_700_000_000_000 })).toBe(1_700_000_000_000);
  });

  it('accepts a plausible rxTime just above the floor', () => {
    expect(canonicalMessageTime({ rxTime: 1_577_836_800_001, timestamp: 1 })).toBe(1_577_836_800_001);
  });
});

describe('messageReceivedAt', () => {
  it('prefers a positive createdAt', () => {
    expect(messageReceivedAt({ createdAt: 500, rxTime: 0, timestamp: 1000 })).toBe(500);
  });

  it('falls back through the chain without leaking a 0 rxTime', () => {
    // createdAt missing AND rxTime 0 → must land on timestamp, not epoch.
    expect(messageReceivedAt({ createdAt: null, rxTime: 0, timestamp: 1000 })).toBe(1000);
    expect(messageReceivedAt({ rxTime: 0, timestamp: 1000 })).toBe(1000);
  });

  it('falls back through the chain without leaking a boot-uptime rxTime (#4206)', () => {
    expect(
      messageReceivedAt({ createdAt: null, rxTime: 114_571_000, timestamp: 1_700_000_000_000 })
    ).toBe(1_700_000_000_000);
  });
});
