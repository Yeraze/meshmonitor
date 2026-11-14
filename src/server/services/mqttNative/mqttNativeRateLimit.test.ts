import { describe, it, expect } from 'vitest';
import { decideRateLimit, parseSendTimes } from './mqttNativeRateLimit.js';
import { clampHopLimit, clampMaxPerHour, clampMaxPerMinute, parseMqttNativeConfig, truncateUtf8 } from './mqttNativeConfig.js';

const NOW = 1_800_000_000_000;
const HARD = { maxPerMinute: 6, maxPerHour: 60 };

describe('decideRateLimit (#4305)', () => {
  it('allows up to 6 in a minute and refuses the 7th', () => {
    let times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const d = decideRateLimit(times, NOW + i, HARD);
      expect(d.allowed).toBe(true);
      times = d.times;
    }
    const d = decideRateLimit(times, NOW + 10, HARD);
    expect(d.allowed).toBe(false);
    expect(d.window).toBe('minute');
    expect(d.retryAfterSeconds).toBe(60);
  });

  it('refuses the 61st in an hour even when spread out', () => {
    // 60 sends between ~58 and ~4 minutes ago: none in the last minute.
    const full = Array.from({ length: 60 }, (_, i) => NOW - 3_500_000 + i * 55_000);
    expect(decideRateLimit(full.slice(1), NOW, HARD).allowed).toBe(true);
    const refused = decideRateLimit(full, NOW, HARD);
    expect(refused.allowed).toBe(false);
    expect(refused.window).toBe('hour');
    // Allowed again once the oldest send is an hour old.
    expect(refused.retryAfterSeconds).toBe(100);
  });

  it('drops sends older than an hour', () => {
    const d = decideRateLimit([NOW - 3_600_001, NOW - 3_700_000], NOW, HARD);
    expect(d.allowed).toBe(true);
    expect(d.times).toEqual([NOW]);
  });

  it('clamps caps above the hard limit back to it (lower-only)', () => {
    const times = Array.from({ length: 6 }, (_, i) => NOW - i);
    expect(decideRateLimit(times, NOW, { maxPerMinute: 100, maxPerHour: 1000 }).allowed).toBe(false);
    expect(decideRateLimit(times.slice(0, 2), NOW, { maxPerMinute: 2, maxPerHour: 60 }).allowed).toBe(false);
  });

  it('keeps near-future stamps (clock stepped back) but drops far-future ones', () => {
    const near = Array.from({ length: 6 }, () => NOW + 30_000);
    expect(decideRateLimit(near, NOW, HARD).allowed).toBe(false);
    const far = Array.from({ length: 6 }, () => NOW + 5 * 3_600_000);
    expect(decideRateLimit(far, NOW, HARD).allowed).toBe(true);
  });

  it('parses persisted lists defensively', () => {
    expect(parseSendTimes(null)).toEqual([]);
    expect(parseSendTimes('nope')).toEqual([]);
    expect(parseSendTimes('{"a":1}')).toEqual([]);
    expect(parseSendTimes('[1,"x",2]')).toEqual([1, 2]);
  });
});

describe('MQTT-native config clamps', () => {
  it('hop limit defaults to 3 and clamps to 0-7', () => {
    expect(clampHopLimit(undefined)).toBe(3);
    expect(clampHopLimit('')).toBe(3);
    expect(clampHopLimit('0')).toBe(0);
    expect(clampHopLimit('9')).toBe(7);
    expect(clampHopLimit('-2')).toBe(0);
    expect(clampHopLimit('abc')).toBe(3);
  });

  it('send caps default to and never exceed 6/min and 60/h', () => {
    expect(clampMaxPerMinute(undefined)).toBe(6);
    expect(clampMaxPerMinute('2')).toBe(2);
    expect(clampMaxPerMinute('50')).toBe(6);
    expect(clampMaxPerMinute('0')).toBe(1);
    expect(clampMaxPerHour(undefined)).toBe(60);
    expect(clampMaxPerHour('10')).toBe(10);
    expect(clampMaxPerHour('600')).toBe(60);
  });

  it('is off by default', () => {
    const cfg = parseMqttNativeConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.hopLimit).toBe(3);
    expect(cfg.rootTopic).toBeNull();
    expect(cfg.announceChannelId).toBeNull();
  });

  it('truncates names on a UTF-8 boundary', () => {
    expect(truncateUtf8('abcdef', 4)).toBe('abcd');
    expect(truncateUtf8('abéé', 4)).toBe('abé');
  });
});
