/**
 * Sliding-window cap for MQTT-native user sends (#4305): at most
 * `maxPerMinute` in any 60 s and `maxPerHour` in any 3600 s, per source.
 *
 * Pure: the caller loads the timestamps from the source's identity row,
 * asks here, and writes the returned list back BEFORE publishing, so a
 * restart sees every send of the last hour and cannot reopen the window.
 */
import {
  MQTT_NATIVE_HARD_MAX_PER_HOUR,
  MQTT_NATIVE_HARD_MAX_PER_MINUTE,
} from './mqttNativeConfig.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface RateLimitDecision {
  allowed: boolean;
  /** Timestamps to persist: the last hour's sends, plus `now` when allowed. */
  times: number[];
  /** Seconds until a send would be allowed (only when refused). */
  retryAfterSeconds?: number;
  /** Which window refused it. */
  window?: 'minute' | 'hour';
}

/** Parse the persisted JSON list; anything malformed reads as empty. */
export function parseSendTimes(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  } catch {
    return [];
  }
}

export function decideRateLimit(
  previous: readonly number[],
  now: number,
  caps: { maxPerMinute: number; maxPerHour: number },
): RateLimitDecision {
  // Caps can only be lowered: whatever arrives is clamped to the hard limits.
  const perMinute = Math.max(1, Math.min(MQTT_NATIVE_HARD_MAX_PER_MINUTE, Math.trunc(caps.maxPerMinute)));
  const perHour = Math.max(1, Math.min(MQTT_NATIVE_HARD_MAX_PER_HOUR, Math.trunc(caps.maxPerHour)));

  // A timestamp up to an hour in the future (clock stepped back) still counts,
  // so a small clock change cannot clear the window; one further out than that
  // is dropped so a large step cannot block sends for days.
  const lastHour = previous.filter((t) => now - t < HOUR_MS && t - now < HOUR_MS).sort((a, b) => a - b);
  const lastMinute = lastHour.filter((t) => now - t < MINUTE_MS);

  if (lastMinute.length >= perMinute) {
    const oldest = lastMinute[lastMinute.length - perMinute];
    return {
      allowed: false,
      times: lastHour,
      window: 'minute',
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + MINUTE_MS - now) / 1000)),
    };
  }
  if (lastHour.length >= perHour) {
    const oldest = lastHour[lastHour.length - perHour];
    return {
      allowed: false,
      times: lastHour,
      window: 'hour',
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)),
    };
  }
  return { allowed: true, times: [...lastHour, now] };
}
