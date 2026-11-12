/**
 * A timer that splits long messages can send up to 3 parts per channel per
 * fire, so it must not fire more often than every 5 minutes (#6316, Q4).
 * Shared by MeshCore timers (interval or cron) and Meshtastic timers (cron
 * only, no `scheduleType`) (#6330).
 */
import { Cron } from 'croner';
import { SPLIT_TIMER_MIN_INTERVAL_MINUTES, MESHCORE_TIMER_MAX_CHANNELS } from '../../utils/messageSplitLimits.js';

interface TimerLike {
  id?: unknown;
  multiline?: unknown;
  scheduleType?: unknown;
  intervalMinutes?: unknown;
  cronExpression?: unknown;
  responseType?: unknown;
}

/** Smallest gap, in minutes, between the next few fires of a timer. null = unknown. */
export function timerMinGapMinutes(t: TimerLike): number | null {
  if (t.scheduleType === 'interval') {
    const n = Number(t.intervalMinutes);
    return Number.isFinite(n) ? n : null;
  }
  // Meshtastic timers carry no scheduleType: they are always cron.
  const isCron = t.scheduleType === 'cron' || (t.scheduleType === undefined && typeof t.cronExpression === 'string');
  if (isCron && typeof t.cronExpression === 'string') {
    try {
      const runs = new Cron(t.cronExpression, { paused: true }).nextRuns(12);
      if (runs.length < 2) return null;
      let min = Infinity;
      for (let i = 1; i < runs.length; i++) min = Math.min(min, (runs[i].getTime() - runs[i - 1].getTime()) / 60000);
      return min;
    } catch {
      return null;
    }
  }
  return null;
}

/** First split-enabled text/script timer that fires faster than the minimum, or undefined. */
export function findSplitTimerTooFrequent(triggers: unknown[]): { id: string; minutes: number } | undefined {
  for (const raw of triggers) {
    const t = raw as TimerLike | null;
    if (!t || t.multiline !== true || t.responseType === 'advert') continue;
    const gap = timerMinGapMinutes(t);
    if (gap !== null && gap < SPLIT_TIMER_MIN_INTERVAL_MINUTES) {
      return { id: String(t.id ?? ''), minutes: gap };
    }
  }
  return undefined;
}

/**
 * First MeshCore timer that targets more than MESHCORE_TIMER_MAX_CHANNELS
 * distinct channels, or undefined (4.17.3 review M5). Only channel timers
 * count; a DM timer's leftover channel list is never sent to.
 */
export function findTimerTooManyChannels(triggers: unknown[]): { id: string; channels: number } | undefined {
  for (const raw of triggers) {
    const t = raw as { id?: unknown; destination?: unknown; channelIndexes?: unknown } | null;
    if (!t || t.destination === 'dm' || !Array.isArray(t.channelIndexes)) continue;
    const distinct = new Set(t.channelIndexes).size;
    if (distinct > MESHCORE_TIMER_MAX_CHANNELS) return { id: String(t.id ?? ''), channels: distinct };
  }
  return undefined;
}
