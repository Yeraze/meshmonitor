/**
 * A timer that splits long messages can send up to 3 parts per channel per
 * fire, so it must not fire more often than every 5 minutes (#6316, Q4).
 * Shared by MeshCore timers (interval or cron) and Meshtastic timers (cron
 * only, no `scheduleType`) (#6330).
 */
import { Cron } from 'croner';
import { SPLIT_TIMER_MIN_INTERVAL_MINUTES } from '../../utils/messageSplitLimits.js';

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
