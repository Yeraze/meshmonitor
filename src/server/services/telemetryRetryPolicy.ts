/**
 * Shared scheduled-telemetry retry-burst / cooldown policy (#6033).
 *
 * After a missed / timed-out scheduled telemetry pull, a node becomes
 * eligible again after a short retry delay (far sooner than its full
 * interval), up to a consecutive-miss cap; once the cap is hit it backs off
 * for a cooldown and then rejoins the normal cadence. These knobs are three
 * per-source settings whose DEFAULTS are the user-approved 90s / 5 / 30m.
 *
 * This module is intentionally dependency-free so both the MeshCore
 * remote-telemetry scheduler and the Meshtastic remote-LocalStats scheduler
 * can import it without risking an import cycle through the managers.
 */

export const DEFAULT_RETRY_DELAY_SECONDS = 90;
export const DEFAULT_RETRY_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY_COOLDOWN_MINUTES = 30;

/** Per-source setting keys for the retry policy (shared by both schedulers). */
export const RETRY_DELAY_SETTING_KEY = 'telemetryRetryDelaySeconds';
export const RETRY_MAX_ATTEMPTS_SETTING_KEY = 'telemetryRetryMaxAttempts';
export const RETRY_COOLDOWN_SETTING_KEY = 'telemetryRetryCooldownMinutes';

export interface TelemetryRetryConfig {
  /** Delay (ms) before a missed node becomes eligible again. */
  retryDelayMs: number;
  /** Consecutive-miss cap before the cooldown kicks in. */
  maxAttempts: number;
  /** Cooldown (ms) applied once the attempt cap is hit. */
  cooldownMs: number;
}

export const DEFAULT_RETRY_CONFIG: TelemetryRetryConfig = {
  retryDelayMs: DEFAULT_RETRY_DELAY_SECONDS * 1000,
  maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
  cooldownMs: DEFAULT_RETRY_COOLDOWN_MINUTES * 60_000,
};

/**
 * Parse the three per-source retry settings into a clamped config, falling
 * back to the approved defaults on absent / invalid values.
 */
export function resolveRetryConfig(raw: {
  delaySeconds?: string | null;
  maxAttempts?: string | null;
  cooldownMinutes?: string | null;
}): TelemetryRetryConfig {
  const parsePositive = (v: string | null | undefined, fallback: number): number => {
    if (v === null || v === undefined || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
  };
  return {
    retryDelayMs: Math.round(parsePositive(raw.delaySeconds, DEFAULT_RETRY_DELAY_SECONDS) * 1000),
    maxAttempts: Math.max(1, Math.round(parsePositive(raw.maxAttempts, DEFAULT_RETRY_MAX_ATTEMPTS))),
    cooldownMs: Math.round(parsePositive(raw.cooldownMinutes, DEFAULT_RETRY_COOLDOWN_MINUTES) * 60_000),
  };
}

/** The persisted miss / cooldown fields a scheduler keeps per node. */
export interface RetryStateFields {
  missCount: number;
  cooldownUntil: number | null;
}

/**
 * Fold one poll outcome into the retry state. Pure and shared by both
 * schedulers so the burst→cooldown arithmetic is defined once:
 *   - success → counter reset, any cooldown lifted.
 *   - miss    → counter +1; once it reaches `maxAttempts`, convert the burst
 *               into a cooldown (`now + cooldownMs`) and reset the counter so
 *               the node rejoins the normal cadence afterwards.
 */
export function nextRetryState(
  current: { missCount?: number | null },
  outcome: 'success' | 'miss',
  now: number,
  config: TelemetryRetryConfig,
): RetryStateFields {
  if (outcome === 'success') {
    return { missCount: 0, cooldownUntil: null };
  }
  const nextMiss = (current.missCount ?? 0) + 1;
  if (nextMiss >= config.maxAttempts) {
    return { missCount: 0, cooldownUntil: now + config.cooldownMs };
  }
  return { missCount: nextMiss, cooldownUntil: null };
}
