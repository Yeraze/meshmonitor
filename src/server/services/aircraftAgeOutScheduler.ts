/**
 * Aircraft age-out scheduler (#5364/#5365 Phase 2) — global singleton.
 *
 * One 1 h interval (first tick 5 min after boot) walks every registered,
 * non-MeshCore/Reticulum source and runs `aircraftAgeOutService.runSweep`
 * when at least 55 min have passed since that source's persisted
 * `aircraftAgeOutLastRunAt` (or it has never run).
 *
 * The due check reads the DB value, never an instance field, so a restart
 * does not count as a run and does not trigger an early one. Settings saves
 * do not touch this scheduler at all. A per-source re-entry guard stops a
 * slow sweep from overlapping the next tick.
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { aircraftAgeOutService, LAST_RUN_AT_KEY } from './aircraftAgeOutService.js';
import { AIRCRAFT_EXCLUDED_SOURCE_TYPES } from './aircraftClassificationService.js';

export const TICK_INTERVAL_MS = 60 * 60_000;
export const FIRST_TICK_DELAY_MS = 5 * 60_000;
export const MIN_RUN_GAP_MS = 55 * 60_000;

export interface AircraftAgeOutSchedulerDeps {
  listSources(): Array<{ sourceId: string; sourceType: string }>;
  getLastRunAt(sourceId: string): Promise<string | null>;
  runSweep(sourceId: string, now: number): Promise<unknown>;
  now(): number;
}

/** Pure due check: never run, unparseable, or ≥ 55 min ago. */
export function isSweepDue(lastRunAtRaw: string | null, nowMs: number): boolean {
  if (lastRunAtRaw == null || lastRunAtRaw === '') return true;
  const last = Number(lastRunAtRaw);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= MIN_RUN_GAP_MS;
}

function defaultDeps(): AircraftAgeOutSchedulerDeps {
  return {
    listSources: () =>
      sourceManagerRegistry.getAllManagers().map((m) => ({ sourceId: m.sourceId, sourceType: m.sourceType })),
    getLastRunAt: (sourceId) => databaseService.settings.getSettingForSource(sourceId, LAST_RUN_AT_KEY),
    runSweep: (sourceId, now) => aircraftAgeOutService.runSweep(sourceId, now),
    now: () => Date.now(),
  };
}

export class AircraftAgeOutScheduler {
  private readonly deps: AircraftAgeOutSchedulerDeps;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();

  constructor(deps?: Partial<AircraftAgeOutSchedulerDeps>) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  initialize(): void {
    if (this.firstTimer || this.interval) return;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      void this.tick();
      this.interval = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
      this.interval.unref?.();
    }, FIRST_TICK_DELAY_MS);
    this.firstTimer.unref?.();
    logger.debug('Aircraft age-out scheduler initialized (first tick in 5 min, then hourly)');
  }

  shutdown(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.interval) clearInterval(this.interval);
    this.firstTimer = null;
    this.interval = null;
  }

  /** One pass over every eligible source. Exposed for tests. */
  async tick(): Promise<void> {
    let sources: Array<{ sourceId: string; sourceType: string }>;
    try {
      sources = this.deps.listSources();
    } catch (err) {
      logger.debug(`Aircraft age-out tick: failed to list sources: ${err}`);
      return;
    }
    for (const { sourceId, sourceType } of sources) {
      if (AIRCRAFT_EXCLUDED_SOURCE_TYPES.has(sourceType)) continue;
      if (this.running.has(sourceId)) continue;
      this.running.add(sourceId);
      try {
        const now = this.deps.now();
        const last = await this.deps.getLastRunAt(sourceId);
        if (!isSweepDue(last, now)) continue;
        await this.deps.runSweep(sourceId, now);
      } catch (err) {
        logger.warn(`Aircraft age-out sweep failed for source ${sourceId}:`, err);
      } finally {
        this.running.delete(sourceId);
      }
    }
  }
}

export const aircraftAgeOutScheduler = new AircraftAgeOutScheduler();
