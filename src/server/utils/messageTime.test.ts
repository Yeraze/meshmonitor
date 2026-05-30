import { describe, it, expect } from 'vitest';
import { canonicalMessageTime, messageReceivedAt } from './messageTime.js';

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
});
