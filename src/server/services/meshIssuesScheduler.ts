/**
 * Mesh Issues Analysis Scheduler (global singleton — #4964, Phase 1 WP3)
 *
 * Runs the global, batch mesh-issues analyzer (meshIssuesAnalysisService) on
 * a simple fixed interval — "every N hours" — a structural clone of
 * positionEstimationScheduler.ts: 60s tick, pure exported `isRunDue`,
 * settings-backed last-run so a process restart is never mistaken for a
 * trigger (mesh-impact checklist §3, restart safety).
 *
 * Settings (see src/server/constants/settings.ts):
 *   - mesh_issues_enabled           (default true)
 *   - mesh_issues_frequency_hours   (default 24)
 *   - mesh_issues_lookback_hours    (default 168 = 7 days)
 *   - mesh_issues_pair_bucket_hours (default 6)
 *
 * The analysis service sends zero packets and emits zero dataEventEmitter
 * events (see its own header) — this scheduler only decides WHEN to re-run a
 * passive read; it arms nothing mesh-facing.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { meshIssuesAnalysisService, type MeshIssuesRunResult } from './meshIssuesAnalysisService.js';
import {
  resolveThresholds,
  MESH_ISSUE_THRESHOLD_SETTINGS_KEYS,
  type ResolvedMeshIssueThresholds,
} from './meshIssues/thresholds.js';

const LAST_RUN_KEY = 'mesh_issues_last_run';
/** Compact summary of the last successful run, persisted so the coverage
 *  preface survives a restart (#4964 Phase 3 WP1, spec §2.4/P3-D1). Written
 *  on SUCCESS ONLY — a failed run must never overwrite the last good summary. */
const LAST_RUN_SUMMARY_KEY = 'mesh_issues_last_run_summary';

export const DEFAULT_FREQUENCY_HOURS = 24;
export const DEFAULT_LOOKBACK_HOURS = 168; // 7 days
export const DEFAULT_PAIR_BUCKET_HOURS = 6;
const MIN_FREQUENCY_HOURS = 1;
const MIN_LOOKBACK_HOURS = 24;
const MAX_LOOKBACK_HOURS = 720;
const MIN_PAIR_BUCKET_HOURS = 1;
const MAX_PAIR_BUCKET_HOURS = 24;
const CHECK_INTERVAL_MS = 60_000;

/**
 * Pure due-check: a run is due if it has never run, or if at least
 * frequencyHours have elapsed since the last run. Identical semantics to
 * positionEstimationScheduler.isRunDue.
 */
export function isRunDue(lastRunMs: number | null, frequencyHours: number, nowMs: number): boolean {
  if (lastRunMs === null) return true;
  return nowMs - lastRunMs >= frequencyHours * 60 * 60 * 1000;
}

/** Accepts both a raw settings string and a plain number (tests call the clamps directly). */
function parseNumeric(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return parseFloat(raw);
  return NaN;
}

/**
 * Pure clamp, exported so unit tests can hit it directly. Unparseable input
 * falls back to the default; a numeric value outside [MIN_LOOKBACK_HOURS,
 * MAX_LOOKBACK_HOURS] clamps UP/DOWN to the nearer bound (an operator's
 * too-small or too-large value still runs a bounded analysis rather than
 * silently reverting to the default).
 */
export function clampLookbackHours(raw: unknown): number {
  const value = parseNumeric(raw);
  if (!Number.isFinite(value)) return DEFAULT_LOOKBACK_HOURS;
  return Math.min(MAX_LOOKBACK_HOURS, Math.max(MIN_LOOKBACK_HOURS, value));
}

/** Same clamp-to-range shape as {@link clampLookbackHours}; see its JSDoc. */
export function clampPairBucketHours(raw: unknown): number {
  const value = parseNumeric(raw);
  if (!Number.isFinite(value)) return DEFAULT_PAIR_BUCKET_HOURS;
  return Math.min(MAX_PAIR_BUCKET_HOURS, Math.max(MIN_PAIR_BUCKET_HOURS, value));
}

/**
 * Frequency has no upper bound (a weekly run is a legitimate choice) and,
 * unlike the other two clamps, falls back to the DEFAULT — not the minimum —
 * when the value is unparseable or below MIN_FREQUENCY_HOURS. Mirrors
 * positionEstimationScheduler's getFrequencyHours exactly.
 */
export function clampFrequencyHours(raw: unknown): number {
  const value = parseNumeric(raw);
  if (!Number.isFinite(value) || value < MIN_FREQUENCY_HOURS) return DEFAULT_FREQUENCY_HOURS;
  return value;
}

export interface MeshIssuesStatus {
  running: boolean;
  inProgress: boolean;
  enabled: boolean;
  frequencyHours: number;
  lookbackHours: number;
  pairBucketHours: number;
  lastRunTime: number | null;
  lastRunResult: MeshIssuesRunResult | null;
  /** Resolved + clamped thresholds actually in force for the next run. */
  thresholds: ResolvedMeshIssueThresholds;
  /** True when `lastRunResult` was recovered from settings (a process
   *  restart cleared the in-memory cache) rather than served from memory. */
  lastRunResultFromStorage: boolean;
}

/** Shape persisted at `LAST_RUN_SUMMARY_KEY` — validated defensively on read
 *  since the key is user-POSTable (it is in VALID_SETTINGS_KEYS so the
 *  settings-allowlist round-trip test passes). */
interface StoredRunSummary {
  at: number;
  result: MeshIssuesRunResult;
}

/** Narrow, non-throwing validation of a parsed `LAST_RUN_SUMMARY_KEY` value:
 *  a non-array object whose `result` is itself a non-array object with a
 *  numeric `durationMs`. Anything else (including a JSON parse failure, which
 *  the caller catches) degrades to `null` rather than throwing — the key is
 *  user-POSTable, so a malformed value must never break `getStatus()`. */
function isValidStoredRunSummary(value: unknown): value is StoredRunSummary {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = (value as { result?: unknown }).result;
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return false;
  const durationMs = (result as { durationMs?: unknown }).durationMs;
  return typeof durationMs === 'number';
}

class MeshIssuesScheduler {
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private inProgress = false;
  private runLock: Promise<MeshIssuesRunResult> | null = null;
  private lastRunTime: number | null = null;
  private lastRunResult: MeshIssuesRunResult | null = null;

  initialize(): void {
    this.start();
    logger.info('✅ Mesh issues analysis scheduler initialized');
  }

  start(): void {
    if (this.isRunning) {
      logger.warn('⚠️ Mesh issues analysis scheduler is already running');
      return;
    }
    this.isRunning = true;
    this.schedulerInterval = setInterval(() => {
      this.checkAndRun().catch((error) => {
        logger.error('❌ Error in mesh issues analysis scheduler check:', error);
      });
    }, CHECK_INTERVAL_MS);
    logger.debug('▶️ Mesh issues analysis scheduler started (checks every minute)');
  }

  stop(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    this.isRunning = false;
    logger.info('⏹️ Mesh issues analysis scheduler stopped');
  }

  private async getEnabled(): Promise<boolean> {
    // Default ON: only disabled when explicitly set to 'false'.
    const value = await databaseService.settings.getSetting('mesh_issues_enabled');
    return value !== 'false';
  }

  private async getFrequencyHours(): Promise<number> {
    const raw = await databaseService.settings.getSetting('mesh_issues_frequency_hours');
    return clampFrequencyHours(raw);
  }

  private async getLookbackHours(): Promise<number> {
    const raw = await databaseService.settings.getSetting('mesh_issues_lookback_hours');
    return clampLookbackHours(raw);
  }

  private async getPairBucketHours(): Promise<number> {
    const raw = await databaseService.settings.getSetting('mesh_issues_pair_bucket_hours');
    return clampPairBucketHours(raw);
  }

  /** Resolved + clamped thresholds currently in force. Reads the same nine
   *  keys `meshIssuesAnalysisService.runAnalysis()` resolves per-run, so
   *  `GET /status` can show "what would apply to the next run" without
   *  actually running analysis (#4964 Phase 3 WP1). */
  private async getThresholds(): Promise<ResolvedMeshIssueThresholds> {
    const values = await Promise.all(
      MESH_ISSUE_THRESHOLD_SETTINGS_KEYS.map((key) => databaseService.settings.getSetting(key)),
    );
    const raw: Record<string, unknown> = {};
    MESH_ISSUE_THRESHOLD_SETTINGS_KEYS.forEach((key, i) => {
      raw[key] = values[i];
    });
    return resolveThresholds(raw);
  }

  /** Recovers the last successful run's summary from settings — the restart
   *  path: `lastRunResult` is only ever written on success (see `execute()`),
   *  and malformed/missing JSON degrades to `null` rather than throwing. */
  private async getLastRunResultFromStorage(): Promise<MeshIssuesRunResult | null> {
    const raw = await databaseService.settings.getSetting(LAST_RUN_SUMMARY_KEY);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isValidStoredRunSummary(parsed)) return null;
    return parsed.result;
  }

  /**
   * Prefers the in-memory cache; otherwise reads `mesh_issues_last_run` from
   * settings with an EMPTY in-memory cache — this is the restart-safety path
   * (mesh-impact checklist §3): the timer survives a process restart because
   * the timestamp lives in the database, not an instance field.
   */
  private async getLastRun(): Promise<number | null> {
    if (this.lastRunTime !== null) return this.lastRunTime;
    const stored = await databaseService.settings.getSetting(LAST_RUN_KEY);
    if (!stored) return null;
    const parsed = parseInt(stored, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Tick handler: run analysis if enabled and due. */
  private async checkAndRun(): Promise<void> {
    if (!(await this.getEnabled())) return;
    if (this.inProgress) return;

    const frequencyHours = await this.getFrequencyHours();
    const lastRun = await this.getLastRun();
    if (!isRunDue(lastRun, frequencyHours, Date.now())) return;

    await this.runNow();
  }

  /**
   * Run analysis now (manual trigger or scheduler tick). Uses a promise lock
   * to prevent overlapping runs — a concurrent call throws immediately
   * rather than queuing.
   */
  async runNow(): Promise<MeshIssuesRunResult> {
    if (this.runLock) {
      throw new Error('Mesh issues analysis already in progress');
    }
    this.runLock = this.execute();
    try {
      return await this.runLock;
    } finally {
      this.runLock = null;
    }
  }

  /**
   * Records the run time in a `finally` — on success AND on failure — so a
   * failing run cannot become a retry storm and the last-run timestamp is
   * always durable to a restart. The run SUMMARY, by contrast, is written
   * only when `result` is non-null (success) — a failed run must not
   * overwrite the last good summary (#4964 Phase 3 WP1, spec §2.4).
   */
  private async execute(): Promise<MeshIssuesRunResult> {
    this.inProgress = true;
    let result: MeshIssuesRunResult | null = null;
    try {
      const [lookbackHours, pairBucketHours] = await Promise.all([
        this.getLookbackHours(),
        this.getPairBucketHours(),
      ]);
      result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours, pairBucketHours });
      this.lastRunResult = result;
      return result;
    } finally {
      this.inProgress = false;
      this.lastRunTime = Date.now();
      try {
        await databaseService.settings.setSetting(LAST_RUN_KEY, String(this.lastRunTime));
      } catch (error) {
        logger.error('❌ Failed to record mesh_issues_last_run:', error);
      }
      if (result !== null) {
        try {
          const summary: StoredRunSummary = { at: this.lastRunTime, result };
          await databaseService.settings.setSetting(LAST_RUN_SUMMARY_KEY, JSON.stringify(summary));
        } catch (error) {
          logger.error('❌ Failed to record mesh_issues_last_run_summary:', error);
        }
      }
    }
  }

  async getStatus(): Promise<MeshIssuesStatus> {
    const [enabled, frequencyHours, lookbackHours, pairBucketHours, lastRun, thresholds] = await Promise.all([
      this.getEnabled(),
      this.getFrequencyHours(),
      this.getLookbackHours(),
      this.getPairBucketHours(),
      this.getLastRun(),
      this.getThresholds(),
    ]);

    // Prefer the in-memory result (this process actually ran it); otherwise
    // recover the last successful run's summary from settings — the restart
    // path (mesh-impact checklist §3): the coverage preface must not go
    // blank for a full frequency period just because the process restarted.
    let lastRunResult = this.lastRunResult;
    let lastRunResultFromStorage = false;
    if (lastRunResult === null) {
      const stored = await this.getLastRunResultFromStorage();
      if (stored !== null) {
        lastRunResult = stored;
        lastRunResultFromStorage = true;
      }
    }

    return {
      running: this.isRunning,
      inProgress: this.inProgress,
      enabled,
      frequencyHours,
      lookbackHours,
      pairBucketHours,
      lastRunTime: lastRun,
      lastRunResult,
      thresholds,
      lastRunResultFromStorage,
    };
  }
}

export const meshIssuesScheduler = new MeshIssuesScheduler();
