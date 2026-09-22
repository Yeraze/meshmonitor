/**
 * Auto-Enrichment scheduler (issue #5287) — runs the NodeInfo Enrichment
 * "Fix All" on a schedule instead of only from the Analysis report.
 *
 * GLOBAL, like the Position Estimation scheduler it is modeled on: one
 * scheduler covers every source, because enrichment is inherently
 * cross-source (a node's blank fields on one source are filled from another).
 *
 * ## Mesh impact (CLAUDE.md checklist)
 *
 * Filling the database costs no airtime — it copies blank fields between rows.
 * The radio cost is the optional push: for every node it fills, Fix All sends
 * an over-the-air NodeInfo request with want_response (~8 transmissions on a
 * 3-hop mesh, request plus reply), and nothing throttled it. A scheduled run
 * that filled 100 nodes would have sent ~800 transmissions back-to-back, every
 * run. So a scheduled run fills the DB in one pass and pushes separately:
 *
 *   - at most PUSH_CAP_PER_RUN (25) requests per run,
 *   - PUSH_SPACING_MS (30 s) apart,
 *   - the remainder kept in a persisted queue for the next run, bounded at
 *     PENDING_PUSH_CAP so it cannot grow without limit,
 *   - a failed push is dropped, never retried — a retry loop is a flood.
 *
 * Schedules are floored at one hour: an interval is clamped to
 * [MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES], and a cron expression that
 * fires more often than hourly is rejected (at save, and again here).
 *
 * ## Timer safety
 *
 * A once-a-minute tick checks whether a run is due against a PERSISTED
 * last-run time, so neither a restart nor a settings save counts as a run and
 * nothing is re-armed by saving. On first enable there is no last run, so the
 * enable moment is persisted as the reference and the first scheduled run
 * lands one full period later; "Run now" is the way to run immediately.
 */
import { Cron } from 'croner';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { validateCron } from '../utils/cronScheduler.js';
import { analyzeEnrichment, applyEnrichment, type EnrichmentApplyItem } from './nodeInfoEnrichmentService.js';
import { pushNodeInfoRequestForNode } from './nodeInfoCopyService.js';

// ---------------------------------------------------------------------------
// Settings keys
// ---------------------------------------------------------------------------

/** User-editable, saved through POST /api/settings (VALID_SETTINGS_KEYS). */
export const AUTO_ENRICHMENT_SETTINGS = {
  enabled: 'autoEnrichmentEnabled',
  scheduleType: 'autoEnrichmentScheduleType',
  intervalMinutes: 'autoEnrichmentIntervalMinutes',
  cron: 'autoEnrichmentCron',
  pushToNodeDb: 'autoEnrichmentPushToNodeDb',
} as const;

/** Server-owned state, written with setSetting directly; not user-postable. */
const STATE_KEYS = {
  lastRunAt: 'autoEnrichmentLastRunAt',
  armedAt: 'autoEnrichmentArmedAt',
  lastRunSummary: 'autoEnrichmentLastRunSummary',
  pendingPushes: 'autoEnrichmentPendingPushes',
} as const;

// ---------------------------------------------------------------------------
// Limits — the user's call per the mesh-impact checklist; see file header.
// ---------------------------------------------------------------------------

export const MIN_INTERVAL_MINUTES = 60;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_INTERVAL_MINUTES = 6 * 60;
export const PUSH_CAP_PER_RUN = 25;
export const PUSH_SPACING_MS = 30_000;
export const PENDING_PUSH_CAP = 1000;

const CHECK_INTERVAL_MS = 60_000;
/** How many upcoming cron fires to sample when checking the hourly floor. */
const CRON_SAMPLE_SIZE = 48;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests and for save-time validation)
// ---------------------------------------------------------------------------

export type AutoEnrichmentScheduleType = 'interval' | 'cron';

/** Clamp a stored interval into the allowed range; junk falls back to the default. */
export function clampIntervalMinutes(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(n)));
}

/**
 * True when `expression` is a valid cron that never fires twice within an
 * hour. Checked over the next CRON_SAMPLE_SIZE fires, which catches both
 * `* * * * *` and subtler shapes like `0,30 * * * *`.
 */
export function cronFiresAtMostHourly(expression: string, from: Date = new Date()): boolean {
  if (!expression || !validateCron(expression)) return false;
  try {
    const job = new Cron(expression, { paused: true }, () => {});
    const runs = job.nextRuns(CRON_SAMPLE_SIZE, from);
    job.stop();
    for (let i = 1; i < runs.length; i++) {
      if (runs[i].getTime() - runs[i - 1].getTime() < MIN_INTERVAL_MINUTES * 60_000) return false;
    }
    return runs.length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether a run is due. `referenceMs` is the last run, or — before the first
 * run — the moment the schedule was armed, so enabling never fires at once.
 */
export function isAutoEnrichmentDue(
  schedule: { type: AutoEnrichmentScheduleType; intervalMinutes: number; cron: string },
  referenceMs: number,
  nowMs: number,
): boolean {
  if (schedule.type === 'cron') {
    if (!cronFiresAtMostHourly(schedule.cron)) return false;
    const job = new Cron(schedule.cron, { paused: true }, () => {});
    const next = job.nextRun(new Date(referenceMs));
    job.stop();
    return next !== null && next.getTime() <= nowMs;
  }
  return nowMs - referenceMs >= schedule.intervalMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface PendingPush {
  nodeNum: number;
  targetSourceId: string;
}

export interface AutoEnrichmentRunSummary {
  startedAt: number;
  finishedAt: number;
  nodesFilled: number;
  fieldsCopied: number;
  pushesSent: number;
  pushesFailed: number;
  pushesPending: number;
  trigger: 'schedule' | 'manual';
}

export interface AutoEnrichmentStatus {
  enabled: boolean;
  scheduleType: AutoEnrichmentScheduleType;
  intervalMinutes: number;
  cron: string;
  cronValid: boolean;
  pushToNodeDb: boolean;
  inProgress: boolean;
  lastRunAt: number | null;
  lastRunSummary: AutoEnrichmentRunSummary | null;
  pendingPushes: number;
  limits: {
    minIntervalMinutes: number;
    maxIntervalMinutes: number;
    pushCapPerRun: number;
    pushSpacingMs: number;
  };
}

type Sleep = (ms: number, signal: { cancelled: boolean }) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class AutoEnrichmentScheduler {
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private runLock: Promise<AutoEnrichmentRunSummary> | null = null;
  /** Set by stop() so an in-flight push phase ends at its next gap. */
  private cancel = { cancelled: false };

  constructor(private readonly sleep: Sleep = realSleep) {}

  initialize(): void {
    this.start();
    logger.info('✅ Auto-enrichment scheduler initialized');
  }

  start(): void {
    if (this.tickHandle) return;
    this.cancel = { cancelled: false };
    this.tickHandle = setInterval(() => {
      this.checkAndRun().catch(error => logger.error('❌ Auto-enrichment tick failed:', error));
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.cancel.cancelled = true;
  }

  get inProgress(): boolean {
    return this.runLock !== null;
  }

  // -- settings --------------------------------------------------------------

  private async readConfig() {
    const s = databaseService.settings;
    const [enabled, type, interval, cron, push] = await Promise.all([
      s.getSetting(AUTO_ENRICHMENT_SETTINGS.enabled),
      s.getSetting(AUTO_ENRICHMENT_SETTINGS.scheduleType),
      s.getSetting(AUTO_ENRICHMENT_SETTINGS.intervalMinutes),
      s.getSetting(AUTO_ENRICHMENT_SETTINGS.cron),
      s.getSetting(AUTO_ENRICHMENT_SETTINGS.pushToNodeDb),
    ]);
    return {
      // Default OFF: this is opt-in, and it can transmit.
      enabled: enabled === 'true',
      type: (type === 'cron' ? 'cron' : 'interval') as AutoEnrichmentScheduleType,
      intervalMinutes: clampIntervalMinutes(interval ?? DEFAULT_INTERVAL_MINUTES),
      cron: cron ?? '',
      pushToNodeDb: push === 'true',
    };
  }

  private async readNumber(key: string): Promise<number | null> {
    const raw = await databaseService.settings.getSetting(key);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }

  private async readPending(): Promise<PendingPush[]> {
    const raw = await databaseService.settings.getSetting(STATE_KEYS.pendingPushes);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((p): p is PendingPush =>
          p && typeof p.nodeNum === 'number' && typeof p.targetSourceId === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private async writePending(pending: PendingPush[]): Promise<void> {
    await databaseService.settings.setSetting(STATE_KEYS.pendingPushes, JSON.stringify(pending));
  }

  // -- scheduling ------------------------------------------------------------

  /** Tick: run if enabled and due. Never fires on the tick that first arms it. */
  async checkAndRun(nowMs: number = Date.now()): Promise<void> {
    const config = await this.readConfig();
    if (!config.enabled || this.runLock) return;

    let reference = await this.readNumber(STATE_KEYS.lastRunAt);
    if (reference === null) {
      reference = await this.readNumber(STATE_KEYS.armedAt);
      if (reference === null) {
        // First tick after enabling: record the reference, do not run.
        await databaseService.settings.setSetting(STATE_KEYS.armedAt, String(nowMs));
        return;
      }
    }

    if (!isAutoEnrichmentDue(
      { type: config.type, intervalMinutes: config.intervalMinutes, cron: config.cron },
      reference,
      nowMs,
    )) return;

    await this.runNow('schedule');
  }

  /**
   * Run now (scheduled or manual). Resolves once the database pass is done;
   * the capped, spaced push phase continues in the background under the same
   * lock, so a manual trigger does not hold an HTTP request open for minutes
   * and the next tick cannot start a second run on top of it.
   */
  async runNow(trigger: 'schedule' | 'manual' = 'manual'): Promise<AutoEnrichmentRunSummary> {
    if (this.runLock) throw new Error('Auto-enrichment already in progress');

    let resolveDbPhase!: (summary: AutoEnrichmentRunSummary) => void;
    let rejectDbPhase!: (error: unknown) => void;
    const dbPhase = new Promise<AutoEnrichmentRunSummary>((resolve, reject) => {
      resolveDbPhase = resolve;
      rejectDbPhase = reject;
    });

    this.runLock = this.execute(trigger, resolveDbPhase, rejectDbPhase)
      .finally(() => { this.runLock = null; });
    // Keep the background promise from surfacing as unhandled; execute() logs.
    this.runLock.catch(() => {});

    return dbPhase;
  }

  private async execute(
    trigger: 'schedule' | 'manual',
    onDbPhaseDone: (summary: AutoEnrichmentRunSummary) => void,
    onDbPhaseFailed: (error: unknown) => void,
  ): Promise<AutoEnrichmentRunSummary> {
    const startedAt = Date.now();
    const config = await this.readConfig();
    const summary: AutoEnrichmentRunSummary = {
      startedAt,
      finishedAt: startedAt,
      nodesFilled: 0,
      fieldsCopied: 0,
      pushesSent: 0,
      pushesFailed: 0,
      pushesPending: 0,
      trigger,
    };

    try {
      // Phase 1 — database only. No sourceId restriction: this is the server
      // acting for the install, the same scope an admin's Fix All has.
      const analysis = await analyzeEnrichment(undefined);
      const items: EnrichmentApplyItem[] = analysis.nodes.flatMap(node =>
        node.targets.map(target => ({
          nodeNum: node.nodeNum,
          targetSourceId: target.targetSourceId,
          donorSourceId: target.donorSourceId,
        })));

      const result = items.length > 0
        ? await applyEnrichment(items, { pushToNodeDb: false })
        : { applied: [], totalFieldsCopied: 0 };

      const filled = result.applied.filter(a => a.copiedFields.length > 0);
      summary.nodesFilled = new Set(filled.map(a => a.nodeNum)).size;
      summary.fieldsCopied = result.totalFieldsCopied;

      // Queue pushes for what was actually filled. A disabled push clears the
      // queue, so re-enabling later does not release a stale backlog at once.
      let pending = config.pushToNodeDb ? await this.readPending() : [];
      if (config.pushToNodeDb) {
        const seen = new Set(pending.map(p => `${p.nodeNum}|${p.targetSourceId}`));
        for (const a of filled) {
          const key = `${a.nodeNum}|${a.targetSourceId}`;
          if (!seen.has(key)) {
            seen.add(key);
            pending.push({ nodeNum: Number(a.nodeNum), targetSourceId: a.targetSourceId });
          }
        }
        // Bound the queue; the oldest entries go first.
        if (pending.length > PENDING_PUSH_CAP) pending = pending.slice(pending.length - PENDING_PUSH_CAP);
      }
      await this.writePending(pending);
      summary.pushesPending = pending.length;

      // The run counts from here: a crash during the push phase must not make
      // the next tick think the run never happened.
      await databaseService.settings.setSetting(STATE_KEYS.lastRunAt, String(startedAt));
      onDbPhaseDone({ ...summary });

      // Phase 2 — capped, spaced pushes.
      if (config.pushToNodeDb && pending.length > 0) {
        const batch = pending.slice(0, PUSH_CAP_PER_RUN);
        const rest = pending.slice(batch.length);
        const cancel = this.cancel;
        for (let i = 0; i < batch.length; i++) {
          if (cancel.cancelled) {
            // Put back what was not attempted.
            rest.unshift(...batch.slice(i));
            break;
          }
          if (i > 0) await this.sleep(PUSH_SPACING_MS, cancel);
          if (cancel.cancelled) {
            rest.unshift(...batch.slice(i));
            break;
          }
          // Dropped on failure either way — never retried (see header).
          const ok = await pushNodeInfoRequestForNode(batch[i].nodeNum, batch[i].targetSourceId);
          if (ok) summary.pushesSent++; else summary.pushesFailed++;
        }
        await this.writePending(rest);
        summary.pushesPending = rest.length;
      }

      summary.finishedAt = Date.now();
      await databaseService.settings.setSetting(STATE_KEYS.lastRunSummary, JSON.stringify(summary));
      logger.info(
        `🧩 Auto-enrichment (${trigger}): filled ${summary.nodesFilled} node(s), ` +
        `${summary.fieldsCopied} field(s); pushed ${summary.pushesSent}, ` +
        `failed ${summary.pushesFailed}, pending ${summary.pushesPending}`,
      );
      return summary;
    } catch (error) {
      logger.error('❌ Auto-enrichment run failed:', error);
      // Record the attempt so a persistent failure is not retried every minute.
      try {
        await databaseService.settings.setSetting(STATE_KEYS.lastRunAt, String(startedAt));
      } catch { /* already logging the primary failure */ }
      onDbPhaseFailed(error);
      throw error;
    }
  }

  async getStatus(): Promise<AutoEnrichmentStatus> {
    const config = await this.readConfig();
    const [lastRunAt, summaryRaw, pending] = await Promise.all([
      this.readNumber(STATE_KEYS.lastRunAt),
      databaseService.settings.getSetting(STATE_KEYS.lastRunSummary),
      this.readPending(),
    ]);
    let lastRunSummary: AutoEnrichmentRunSummary | null;
    try { lastRunSummary = summaryRaw ? JSON.parse(summaryRaw) : null; } catch { lastRunSummary = null; }

    return {
      enabled: config.enabled,
      scheduleType: config.type,
      intervalMinutes: config.intervalMinutes,
      cron: config.cron,
      cronValid: config.cron ? cronFiresAtMostHourly(config.cron) : false,
      pushToNodeDb: config.pushToNodeDb,
      inProgress: this.inProgress,
      lastRunAt,
      lastRunSummary,
      pendingPushes: pending.length,
      limits: {
        minIntervalMinutes: MIN_INTERVAL_MINUTES,
        maxIntervalMinutes: MAX_INTERVAL_MINUTES,
        pushCapPerRun: PUSH_CAP_PER_RUN,
        pushSpacingMs: PUSH_SPACING_MS,
      },
    };
  }
}

export const autoEnrichmentScheduler = new AutoEnrichmentScheduler();
