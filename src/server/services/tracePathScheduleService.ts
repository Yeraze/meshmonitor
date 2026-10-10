/**
 * Due-time and hourly-cap bookkeeping for scheduled MeshCore traces (#5723).
 *
 * `action.tracePathSchedule` holds N paths, each with its own interval. Every
 * run of the automation asks, per path and source: is it due, and is the
 * source under its hourly cap? {@link TracePathScheduleService.claim} answers
 * and stamps in one serialised step.
 *
 * Mesh impact (CLAUDE.md checklist):
 * - State is persisted per source in settings (`tracePathScheduleState`), so
 *   neither a restart nor saving the automation resets a path's last run or
 *   the hourly count. A restart is not a trigger: a path that ran 3 minutes
 *   before the restart still waits out its interval.
 * - A path that is new (no recorded run) is due on the next run.
 * - The stamp is written BEFORE the trace is sent, so a failed or unanswered
 *   trace still counts; nothing retries.
 */
import databaseService from '../../services/database.js';
import { TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR, TRACE_SCHEDULE_MIN_INTERVAL_MINUTES } from '../../types/tracePathSchedule.js';

export const SETTING_TRACE_SCHEDULE_STATE = 'tracePathScheduleState';
const HOUR_MS = 60 * 60_000;
/** Forget a path's last-run stamp after this long without a run. */
const STALE_AFTER_MS = 30 * 24 * HOUR_MS;

export interface TraceScheduleState {
  /** `${automationId}:${nodeId}:${publicKey}` → last run, ms. */
  last: Record<string, number>;
  /** Run times inside the last hour, ms. */
  runs: number[];
  /** When a capped path was last reported in the run log, ms. */
  capNotedAt?: number;
}

export type TraceClaim =
  | { due: true }
  | { due: false; reason: 'not_due'; nextDueAt: number }
  /** `quiet`: the cap was already reported within the last hour, so this skip need not be logged again. */
  | { due: false; reason: 'hourly_cap'; quiet: boolean };

export interface TraceScheduleDeps {
  getSourceSetting(sourceId: string, key: string): Promise<string | null>;
  setSourceSetting(sourceId: string, key: string, value: string): Promise<void>;
  now(): number;
}

function defaultDeps(): TraceScheduleDeps {
  return {
    getSourceSetting: (sourceId, key) => databaseService.settings.getSettingForSource(sourceId, key),
    setSourceSetting: (sourceId, key, value) => databaseService.settings.setSourceSetting(sourceId, key, value),
    now: () => Date.now(),
  };
}

export function parseTraceScheduleState(raw: string | null, now: number): TraceScheduleState {
  const empty: TraceScheduleState = { last: {}, runs: [] };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<TraceScheduleState> | null;
    if (!parsed || typeof parsed !== 'object') return empty;
    const last: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed.last ?? {})) {
      const t = Number(v);
      if (Number.isFinite(t) && t > now - STALE_AFTER_MS && t <= now) last[k] = t;
    }
    const runs = Array.isArray(parsed.runs)
      ? parsed.runs.map(Number).filter((t) => Number.isFinite(t) && t > now - HOUR_MS && t <= now)
      : [];
    const noted = Number(parsed.capNotedAt);
    const capNotedAt = Number.isFinite(noted) && noted > now - HOUR_MS && noted <= now ? noted : undefined;
    return { last, runs, ...(capNotedAt !== undefined ? { capNotedAt } : {}) };
  } catch {
    return empty;
  }
}

export class TracePathScheduleService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly deps: TraceScheduleDeps = defaultDeps()) {}

  /**
   * Decide whether one path may run now on one source, and if so record it.
   * Serialised per source, so concurrent runs cannot exceed the cap.
   */
  async claim(a: { sourceId: string; pathKey: string; intervalMinutes: number }): Promise<TraceClaim> {
    const previous = this.locks.get(a.sourceId) ?? Promise.resolve();
    let result: TraceClaim = { due: false, reason: 'hourly_cap', quiet: false };
    const run = previous.then(async () => {
      const now = this.deps.now();
      const state = parseTraceScheduleState(await this.deps.getSourceSetting(a.sourceId, SETTING_TRACE_SCHEDULE_STATE), now);
      // The floor holds even for a config edited by hand below it.
      const intervalMs = Math.max(TRACE_SCHEDULE_MIN_INTERVAL_MINUTES, a.intervalMinutes) * 60_000;
      const lastRun = state.last[a.pathKey];
      if (lastRun !== undefined && now - lastRun < intervalMs) {
        result = { due: false, reason: 'not_due', nextDueAt: lastRun + intervalMs };
        return;
      }
      if (state.runs.length >= TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR) {
        // Report the cap in the run log once an hour, not on every tick.
        const quiet = state.capNotedAt !== undefined && now - state.capNotedAt < HOUR_MS;
        if (!quiet) {
          state.capNotedAt = now;
          await this.deps.setSourceSetting(a.sourceId, SETTING_TRACE_SCHEDULE_STATE, JSON.stringify(state));
        }
        result = { due: false, reason: 'hourly_cap', quiet };
        return;
      }
      state.last[a.pathKey] = now;
      state.runs.push(now);
      await this.deps.setSourceSetting(a.sourceId, SETTING_TRACE_SCHEDULE_STATE, JSON.stringify(state));
      result = { due: true };
    });
    this.locks.set(a.sourceId, run.catch(() => undefined));
    await run;
    return result;
  }
}

export const tracePathScheduleService = new TracePathScheduleService();
