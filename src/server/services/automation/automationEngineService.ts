/**
 * Automation Engine service (#3653, §4) — the runtime orchestrator.
 *
 * Loads enabled automations, indexes them by trigger type, and on each mesh event
 * builds the trigger context, fast-fails on the trigger pre-filter, enforces the
 * trigger's cooldown at its configured scope (automation / node / source+node),
 * evaluates the graph (condition routing / collapse / fanout / actions / setVar),
 * and writes a run-log row.
 *
 * Phase 1a is synchronous: every run completes to `completed`/`failed`; the
 * `waiting` status and flow.delay arrive in 1b. Mesh IO is injected via ActionDeps
 * so the whole pipeline is testable without a live node.
 */
import { logger } from '../../../utils/logger.js';
import type { DbMessage } from '../../../services/database.js';
import type { AutomationsRepository, AutomationRecord } from '../../../db/repositories/automations.js';
import type { AutomationHomeAnchorsRepository } from '../../../db/repositories/automationHomeAnchors.js';
import { isMqttSourceType } from '../../../db/repositories/sources.js';
import {
  validateAutomationGraph,
  categoryOf,
  parseCooldownScope,
  parseRateLimit,
  type AutomationGraph,
  type AutomationNode,
  type TriggerType,
  type CooldownScope,
} from '../../../types/automation.js';
import { VariableResolver } from './variableResolver.js';
import {
  buildMessageContext,
  buildMeshCoreMessageContext,
  buildReticulumMessageContext,
  buildNodeContext,
  buildTelemetryContext,
  buildMeshBeaconContext,
  buildSystemContext,
  buildGeofenceContext,
  buildBecameMobileContext,
  buildLeftHomeContext,
  buildNodeStaleContext,
  buildNodeOnlineContext,
  buildNodeRebootedContext,
  buildNodePowerChangedContext,
  buildBatteryTrendContext,
  buildScheduleContext,
  messageMatchesFilter,
  meshCoreMessageMatchesFilter,
  reticulumMessageMatchesFilter,
  describeMessageFilterMiss,
  describeMeshCoreFilterMiss,
  describeReticulumFilterMiss,
  parseMeshCoreChannelIdx,
  type TriggerContext,
  type SystemEvent,
} from './triggerContext.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';
import type { ReticulumMessageRow } from '../../../db/repositories/reticulum.js';
import { scheduleCron, validateCron } from '../../utils/cronScheduler.js';
import { haversineKm, geofenceFires, pointInShape, geofenceCenter, normalizeGeofenceParams, normalizeGeofenceAnchor, shapeFromWaypoint, type GeofenceMode, type GeofenceShape } from './geo.js';
import { evaluateGraph, type EvaluatorHooks } from './graphEvaluator.js';
import { automationTraceBus } from './automationTraceBus.js';
import { evaluateCondition } from './conditionEvaluator.js';
import { executeAction, type ActionDeps } from './actionExecutor.js';
import {
  type EngineEvalContext,
  type NodeDataProvider,
  type StaleCandidate,
  varContextFromTrigger,
  resolveOperand,
  cooldownKeyFor,
} from './engineContext.js';

interface LoadedAutomation {
  id: string;
  name: string;
  graph: AutomationGraph;
  triggerNode: AutomationNode;
  triggerType: TriggerType;
  cooldownSeconds: number;
  cooldownScope: CooldownScope;
  /** Per-automation flood ceiling (#4577 Phase 2, RATE-LIMIT). Absent = no cap. */
  rateLimit?: { maxActions: number; windowSeconds: number };
}

/**
 * Per-automation cooldown-key bounds (#4340 Phase 2). Under 'automation' scope
 * an automation holds exactly ONE key, as before. Under 'node'/'sourceNode' it
 * holds one per distinct subject — on a large mesh with MQTT sources that is
 * thousands, so it must be bounded.
 *
 * Shape copied from meshtasticManager's autoAckProcessedPackets high-water trim
 * (`> 1000 → keep last 500`, :9992): prune only when a high watermark is passed,
 * and always bring the size well under it, so pruning is amortised O(1) per fire.
 *
 * Refined with an EXACT first pass: unlike a packet-dedup set, a cooldown entry
 * has a provable expiry — once `now - ts >= cooldownSeconds*1000` it can never
 * suppress anything, so deleting it is behaviour-neutral. The hard trim below is
 * only a backstop for the pathological case of >TRIM_TO distinct subjects firing
 * inside a single cooldown window.
 *
 * Was NOT modelled on meshtasticManager's autoAckCooldowns (Map<nodeNum, ms>,
 * :825): that map went unevicted for a long time and got away with it because
 * it is per-manager and bounded in practice by one radio's NodeDB, whereas the
 * engine's map is per (automation × node) across EVERY source including MQTT
 * firehoses, so the same laxness would be a real leak here. (#4399 has since
 * bounded autoAckCooldowns too, with this same exact-expiry-then-trim shape.)
 */
const COOLDOWN_KEYS_MAX = 4096;
const COOLDOWN_KEYS_TRIM_TO = 2048;

/**
 * Per-automation geofence-state bounds (#4399). Unlike a cooldown timestamp,
 * a geofenceState entry's boolean IS the enter/exit baseline — deleting it is
 * NOT behaviour-neutral. The next check reads as "first sighting", sets a
 * fresh baseline, and does not fire, so a real `enter`/`exit` transition can
 * be silently missed on the evicted node. There is no exact-expiry test here
 * the way there is for cooldowns (§ above): every entry is "live" in the
 * sense that we can't prove it will never matter again.
 *
 * Decision (#4399): cap per automation and evict the least-recently-TOUCHED
 * node, logging what was dropped — same high-water shape as
 * COOLDOWN_KEYS_MAX/TRIM_TO, but with no exact-expiry pass first, since none
 * exists. "Least recently touched" means the node hasn't had a position
 * update routed through checkGeofences in the longest time, i.e. it is the
 * node LEAST likely to be actively crossing the fence right now — so an
 * evicted node re-establishing its baseline (and missing one transition) is a
 * rare, low-value miss, not a routine one. Leaving per-node growth completely
 * unbounded was rejected: an MQTT-fed mesh can accumulate one permanent entry
 * per node a geofence automation has EVER seen, which is exactly the leak
 * this issue is about. Deleted/disabled automations are still pruned
 * separately and exactly (see `load()`) — that part IS safe, the same way the
 * cooldown map's load()-time prune is.
 */
const GEOFENCE_STATE_MAX = 4096;
const GEOFENCE_STATE_TRIM_TO = 2048;

/**
 * How often the staleness ticker evaluates node ages (#4558 Phase A). Staleness
 * is packet ABSENCE, so it cannot be event-driven — the tick is the only signal.
 * It sends NO mesh packets (airtime cost is zero); it only does DB reads and may
 * fire automations whose notification spam is bounded by the same
 * cooldownSeconds/cooldownScope/rateLimit every trigger already has. 60s matches
 * inactiveNodeNotificationService's tick and means detection lags a "silent for
 * N minutes" threshold by at most ~1 minute — negligible at minute granularity.
 */
const STALE_TICK_INTERVAL_MS = 60_000;

/**
 * Per-automation staleness-state bounds (#4558 Phase A). Unlike geofenceState,
 * evicting a stale entry is behaviour-SAFE: a first sighting only ESTABLISHES a
 * baseline and never fires, so an evicted node simply re-baselines on the next
 * tick (a still-stale node re-seeds as stale — no spurious "heartbeat lost"; a
 * fresh node re-seeds fresh). Bounded anyway because an MQTT-fed mesh churns
 * nodeNums and would otherwise strand one dead entry per node ever seen. Higher
 * cap than geofence because this watches EVERY node, not only the ones that move.
 */
const STALE_STATE_MAX = 8192;
const STALE_STATE_TRIM_TO = 4096;

/**
 * Per-(automation, node) staleness baseline (#4558 Phase A). `stale` is whether
 * the node is currently past its threshold; `lastHeardMs` is the node's last-heard
 * epoch-ms captured at the last write, used to compute the recovery
 * offlineDuration; `ts` is when the entry was last touched (eviction ordering).
 */
interface StaleEntry {
  stale: boolean;
  lastHeardMs: number | null;
  ts: number;
}

/**
 * How often the battery-trend ticker recomputes decline (#4558 Phase E). Battery
 * decline is a SLOW phenomenon that unfolds over hours, so unlike the 60s stale
 * tick this runs every 15 minutes: the added detection lag is negligible against
 * a multi-hour window, and the tick is materially cheaper — each pass does one
 * battery-history DB read PER Meshtastic node (O(n) reads), where the stale tick
 * reads all last-heard times in a single query. It sends NO mesh packets (airtime
 * cost is zero); notification spam is bounded by the same cooldownSeconds /
 * cooldownScope / rateLimit every trigger already has.
 */
const BATTERY_TREND_TICK_INTERVAL_MS = 15 * 60_000;

/**
 * Per-automation battery-trend-state bounds (#4558 Phase E). Same reasoning as
 * STALE_STATE_MAX: evicting an entry is behaviour-SAFE because a first sighting
 * only ESTABLISHES a baseline and never fires, so an evicted node simply
 * re-baselines on the next tick (a still-declining node re-seeds as alarmed — no
 * spurious refire; a recovered node re-seeds calm). Bounded anyway so an MQTT-fed
 * mesh churning nodeNums cannot strand one dead entry per node ever seen.
 */
const BATTERY_TREND_STATE_MAX = 8192;
const BATTERY_TREND_STATE_TRIM_TO = 4096;

/**
 * Per-(automation, node) battery-trend baseline (#4558 Phase E). `alarmed` is
 * whether the node was declining past the threshold at the last tick — the
 * fire-once + re-arm latch; `ts` is when the entry was last touched (eviction
 * ordering). The decline itself is recomputed from durable DB history every tick,
 * so this latch only prevents repeat-firing; it holds no derived measurement.
 */
interface BatteryTrendEntry {
  alarmed: boolean;
  ts: number;
}

/** Compact result of evaluating one automation — persisted run-log shape is unchanged;
 *  this is the subset the live trace ("view logs") streams to the browser. */
interface FireResult {
  status: 'completed' | 'failed';
  conditionResults: Record<string, boolean>;
  actions: Array<{ nodeId: string; ok: boolean; error?: string }>;
  // Looser than EvaluationStep[] so the synthetic engine-error step (outcome
  // 'engine:error', not a StepOutcome) fits; the UI handles unknown outcomes.
  steps: Array<{ nodeId: string; type: string; outcome: string; error?: string }>;
}

/**
 * Verdict of a manual "Run Now" fire (#4827). `ran` is true only when the
 * automation's actions actually dispatched; a `reason` explains a no-op (the
 * rule was suppressed by its own cooldown / rate-limit guard, or could not be
 * loaded). `status`/`actions`/`steps` mirror the real run when it fired.
 */
export interface RunNowResult {
  ran: boolean;
  reason?: 'not_found' | 'invalid' | 'cooldown' | 'ratelimited';
  detail?: string;
  status?: 'completed' | 'failed';
  actions?: Array<{ nodeId: string; ok: boolean; error?: string }>;
  steps?: Array<{ nodeId: string; type: string; outcome: string; error?: string }>;
}

/** Shallow copy of a trigger's fields with long text truncated, for trace payloads. */
function compactEventFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  return out;
}

/** Pluggable cron backing for `trigger.schedule` — real croner in prod, a fake in tests. */
export interface CronScheduler {
  schedule(expression: string, callback: () => void): { stop: () => void };
  validate(expression: string): boolean;
}

const REAL_CRON_SCHEDULER: CronScheduler = {
  schedule: (expr, cb) => scheduleCron(expr, cb),
  validate: validateCron,
};

export interface EngineServiceOptions {
  automationsRepo: AutomationsRepository;
  varResolver: VariableResolver;
  deps: ActionDeps;
  /** Hydrates the subject node + telemetry for conditions. */
  data: NodeDataProvider;
  /** Persists left-home anchors. Optional in unit tests that don't cover leftHome. */
  homeAnchorsRepo?: AutomationHomeAnchorsRepository | null;
  /**
   * Optional: estimate a home lat/lon from stored position history (median +
   * inlier mean). Used on first establish / reset so a glitched first packet
   * does not become the anchor when history exists. Injected for testability.
   */
  estimateHomeFromHistory?: (
    nodeNum: number,
    thresholdMeters: number,
  ) => Promise<{ latitude: number; longitude: number } | null>;
  /** Injectable clock (cooldown + flag TTL). Defaults to Date.now. */
  now?: () => number;
  /** Per-run action cap (loop/spam guard). Default 50. */
  maxActions?: number;
  /** Cron backing for schedule triggers. Defaults to real croner. */
  cron?: CronScheduler;
}

export class AutomationEngineService {
  private readonly automationsRepo: AutomationsRepository;
  private readonly vars: VariableResolver;
  private readonly deps: ActionDeps;
  private readonly data: NodeDataProvider;
  private readonly homeAnchorsRepo: AutomationHomeAnchorsRepository | null;
  private readonly estimateHomeFromHistory: EngineServiceOptions['estimateHomeFromHistory'];
  private readonly now: () => number;
  private readonly maxActions: number;
  private readonly cron: CronScheduler;

  /** triggerType → loaded automations. */
  private index = new Map<TriggerType, LoadedAutomation[]>();
  /** automationId → cooldown key → last fired ms. Inner key shape: cooldownKeyFor(). */
  private lastFired = new Map<string, Map<string, number>>();
  /** automationId → fire timestamps (ms) within the current rate-limit window (#4577 Phase 2). */
  private rateLimitEvents = new Map<string, number[]>();
  /** automationId → nodeNum → { inside: was the node in the geofence at last check; ts: when last checked (eviction, #4399) }. */
  private geofenceState = new Map<string, Map<number, { inside: boolean; ts: number }>>();
  /** automationId → nodeNum → alarmed (beyond threshold) for left-home re-arm. */
  private leftHomeAlarmed = new Map<string, Map<number, boolean>>();
  /** automationId → live cron job, for `trigger.schedule` automations. */
  private cronJobs = new Map<string, { stop: () => void }>();
  /** automationId → "sourceId:nodeKey" → staleness baseline (#4558 Phase A). */
  private staleState = new Map<string, Map<string, StaleEntry>>();
  /** The periodic staleness ticker, or null when not running (#4558 Phase A). */
  private staleTimer: NodeJS.Timeout | null = null;
  /** automationId → "sourceId:nodeNum" → battery-trend baseline (#4558 Phase E). */
  private batteryTrendState = new Map<string, Map<string, BatteryTrendEntry>>();
  /** The periodic battery-trend ticker, or null when not running (#4558 Phase E). */
  private batteryTrendTimer: NodeJS.Timeout | null = null;

  constructor(opts: EngineServiceOptions) {
    this.automationsRepo = opts.automationsRepo;
    this.vars = opts.varResolver;
    this.deps = opts.deps;
    this.data = opts.data;
    this.homeAnchorsRepo = opts.homeAnchorsRepo ?? null;
    this.estimateHomeFromHistory = opts.estimateHomeFromHistory;
    this.now = opts.now ?? (() => Date.now());
    this.maxActions = opts.maxActions ?? 50;
    this.cron = opts.cron ?? REAL_CRON_SCHEDULER;
  }

  /** (Re)load enabled automations and rebuild the trigger index. */
  /**
   * Parse + validate one automation row into a {@link LoadedAutomation}, or null
   * if its config is unparseable / invalid / has no trigger node. Shared by
   * {@link load} (which builds the enabled-trigger index) and {@link runNow} (a
   * manual one-off fire that must work even for a disabled automation not in the
   * running index).
   */
  private buildEntry(row: Pick<AutomationRecord, 'id' | 'name' | 'config'>): LoadedAutomation | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.config);
    } catch {
      logger.warn(`[AutomationEngine] automation "${row.name}" has unparseable config; skipping`);
      return null;
    }
    const result = validateAutomationGraph(parsed);
    if (!result.valid || !result.graph) {
      logger.warn(`[AutomationEngine] automation "${row.name}" is invalid; skipping: ${result.errors.join('; ')}`);
      return null;
    }
    const triggerNode = result.graph.nodes.find((n) => categoryOf(n.type) === 'trigger');
    if (!triggerNode) return null;
    const triggerType = triggerNode.type as TriggerType;
    const cooldownSeconds = Number((triggerNode.params as any)?.cooldownSeconds ?? 0) || 0;
    // No `as any` needed: params is Record<string, unknown> and parseCooldownScope
    // takes unknown. (The cooldownSeconds line above predates the lint ratchet.)
    const cooldownScope = parseCooldownScope(triggerNode.params?.cooldownScope);
    // No `as any` needed: params is Record<string, unknown> and parseRateLimit
    // takes unknown (same reasoning as the parseCooldownScope line above).
    const rateLimit = parseRateLimit(triggerNode.params?.rateLimit);
    return {
      id: row.id, name: row.name, graph: result.graph, triggerNode, triggerType, cooldownSeconds, cooldownScope, rateLimit,
    };
  }

  async load(): Promise<void> {
    const rows = await this.automationsRepo.listEnabledAutomations();
    const index = new Map<TriggerType, LoadedAutomation[]>();
    for (const row of rows) {
      const entry = this.buildEntry(row);
      if (!entry) continue;
      if (!index.has(entry.triggerType)) index.set(entry.triggerType, []);
      index.get(entry.triggerType)!.push(entry);
    }
    this.index = index;
    // Drop cooldown state for automations that are no longer loaded (deleted or
    // disabled). They are unreachable — runTrigger/onSchedule/checkGeofences only
    // iterate `this.index` — so this is unobservable while they stay out of the
    // index. One observable edge, accepted: disabling and re-enabling a rule inside
    // its own cooldown window now lets it fire immediately instead of waiting out
    // the remainder. Erring toward firing is the safe direction, and without this a
    // deleted node-scoped automation would strand up to COOLDOWN_KEYS_MAX entries
    // forever.
    const liveIds = new Set<string>();
    for (const list of index.values()) for (const a of list) liveIds.add(a.id);
    for (const id of this.lastFired.keys()) if (!liveIds.has(id)) this.lastFired.delete(id);
    // Same prune for rate-limit event history (#4577 Phase 2): unreachable once
    // out of the index, so dropping it is unobservable — identical reasoning to
    // the lastFired prune immediately above.
    for (const id of this.rateLimitEvents.keys()) if (!liveIds.has(id)) this.rateLimitEvents.delete(id);
    // Same prune for geofence baselines (#4399): a deleted/disabled automation's
    // entries are unreachable (checkGeofences only iterates `this.index`), so
    // dropping them is unobservable — unlike evicting a *live* automation's
    // per-node entries, which is the risky case GEOFENCE_STATE_MAX guards.
    for (const id of this.geofenceState.keys()) if (!liveIds.has(id)) this.geofenceState.delete(id);
    for (const id of this.leftHomeAlarmed.keys()) if (!liveIds.has(id)) this.leftHomeAlarmed.delete(id);
    // Same prune for staleness baselines (#4558): a deleted/disabled automation's
    // entries are unreachable (runStaleCheck/checkNodeOnline only iterate
    // `this.index`), so dropping them is unobservable. A still-present automation
    // keeps its baseline across a reload — so saving OTHER automations never
    // re-arms a nodeStale timer, and editing this one (same id) never re-fires
    // "heartbeat lost" for already-stale nodes.
    for (const id of this.staleState.keys()) if (!liveIds.has(id)) this.staleState.delete(id);
    // Same prune for battery-trend baselines (#4558 Phase E): a deleted/disabled
    // automation's entries are unreachable (runBatteryTrendCheck only iterates
    // `this.index`), so dropping them is unobservable. A still-present automation
    // keeps its baseline across a reload — so saving OTHER automations never
    // re-arms its ticker, and editing this one (same id) never re-fires for a
    // node already flagged declining.
    for (const id of this.batteryTrendState.keys()) if (!liveIds.has(id)) this.batteryTrendState.delete(id);
    this.rescheduleCron();
    logger.info(`[AutomationEngine] loaded ${rows.length} enabled automation(s)`);
  }

  /**
   * (Re)arm cron jobs for every enabled `trigger.schedule` automation. Stops all
   * prior jobs first, so a reload after CRUD never leaves a stale or duplicate
   * job. An automation with a missing/invalid cron is logged and skipped.
   */
  private rescheduleCron(): void {
    for (const job of this.cronJobs.values()) job.stop();
    this.cronJobs.clear();
    for (const a of this.index.get('trigger.schedule') ?? []) {
      const cron = String((a.triggerNode.params as Record<string, unknown>)?.cron ?? '').trim();
      if (!cron || !this.cron.validate(cron)) {
        logger.warn(`[AutomationEngine] automation "${a.name}" has an invalid/missing cron ("${cron}"); not scheduled`);
        continue;
      }
      const job = this.cron.schedule(cron, () => {
        this.onSchedule(a.id).catch((e) => logger.error(`[AutomationEngine] schedule trigger error: ${e?.message}`));
      });
      this.cronJobs.set(a.id, job);
    }
  }

  /** Stop all cron jobs + the staleness/battery-trend tickers (clean shutdown / test teardown). */
  stop(): void {
    for (const job of this.cronJobs.values()) job.stop();
    this.cronJobs.clear();
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    if (this.batteryTrendTimer) {
      clearInterval(this.batteryTrendTimer);
      this.batteryTrendTimer = null;
    }
  }

  /**
   * Start the periodic staleness ticker (#4558 Phase A). Idempotent; {@link stop}
   * clears it. Not started in the constructor so unit tests drive
   * {@link runStaleCheck} directly against the injected clock without a real timer.
   */
  startStaleTicker(intervalMs = STALE_TICK_INTERVAL_MS): void {
    if (this.staleTimer) return;
    this.staleTimer = setInterval(() => {
      this.runStaleCheck().catch((e) => logger.error(`[AutomationEngine] stale check error: ${e?.message}`));
    }, intervalMs);
    // Never hold the process open solely for this background timer.
    if (typeof this.staleTimer.unref === 'function') this.staleTimer.unref();
  }

  /**
   * Start the periodic battery-trend ticker (#4558 Phase E). Idempotent;
   * {@link stop} clears it. Not started in the constructor so unit tests drive
   * {@link runBatteryTrendCheck} directly against the injected clock without a
   * real timer.
   */
  startBatteryTrendTicker(intervalMs = BATTERY_TREND_TICK_INTERVAL_MS): void {
    if (this.batteryTrendTimer) return;
    this.batteryTrendTimer = setInterval(() => {
      this.runBatteryTrendCheck().catch((e) => logger.error(`[AutomationEngine] battery-trend check error: ${e?.message}`));
    }, intervalMs);
    // Never hold the process open solely for this background timer.
    if (typeof this.batteryTrendTimer.unref === 'function') this.batteryTrendTimer.unref();
  }

  /**
   * Fire a single `trigger.schedule` automation by id (called from its cron job).
   * Honors the per-automation cooldown. Returns 1 if it fired, else 0.
   */
  async onSchedule(automationId: string): Promise<number> {
    const a = (this.index.get('trigger.schedule') ?? []).find((x) => x.id === automationId);
    if (!a) return 0;
    const now = this.now();
    const ctx = buildScheduleContext(null, now);
    const traced = automationTraceBus.activeCount() > 0 && automationTraceBus.isTracing(a.id, now);
    const gate = this.cooldownGate(a, ctx, now);
    if (!gate.ok) {
      if (traced) this.emitTrace(a, ctx, now, { outcome: 'cooldown', reason: gate.reason });
      return 0;
    }
    const rateGate = this.rateLimitGate(a, now);
    if (!rateGate.ok) {
      if (traced) this.emitTrace(a, ctx, now, { outcome: 'ratelimited', reason: rateGate.reason });
      return 0;
    }
    this.markFired(a, gate.key, now);
    this.markRateLimited(a, now);
    const fr = await this.fireAutomation(a, ctx, now);
    if (traced) this.emitTrace(a, ctx, now, { outcome: 'fired', status: fr.status, conditionResults: fr.conditionResults, actions: fr.actions, steps: fr.steps });
    return 1;
  }

  /**
   * Manually fire an automation's actions FOR REAL right now (#4827, the "Run
   * Now" button), bypassing its trigger (schedule / message / …) so a user can
   * verify a scheduled rule end-to-end without waiting for its cron.
   *
   * Reuses the exact real dispatch path the scheduler uses ({@link fireAutomation}
   * plus the {@link cooldownGate} / {@link rateLimitGate} checks), so the
   * per-automation cooldown, rate-limit and self-origin guards all still apply —
   * a manual fire counts against those windows exactly like a real one. The
   * synthetic schedule context carries no originating node, so the self-origin
   * guard (#3914) has nothing to drop.
   *
   * Does NOT disturb the cron cadence: croner computes each next fire from the
   * wall clock, and this method never touches the cron jobs nor persists any
   * last-fire timestamp (the cooldown map is in-memory). Loads the row directly
   * rather than the enabled index, so it works for disabled automations too.
   */
  async runNow(automationId: string): Promise<RunNowResult> {
    const row = await this.automationsRepo.getAutomation(automationId);
    if (!row) return { ran: false, reason: 'not_found' };
    const a = this.buildEntry(row);
    if (!a) return { ran: false, reason: 'invalid' };
    const now = this.now();
    const ctx = buildScheduleContext(null, now);
    const gate = this.cooldownGate(a, ctx, now);
    if (!gate.ok) return { ran: false, reason: 'cooldown', detail: gate.reason };
    const rateGate = this.rateLimitGate(a, now);
    if (!rateGate.ok) return { ran: false, reason: 'ratelimited', detail: rateGate.reason };
    this.markFired(a, gate.key, now);
    this.markRateLimited(a, now);
    const fr = await this.fireAutomation(a, ctx, now);
    return { ran: true, status: fr.status, actions: fr.actions, steps: fr.steps };
  }

  /** Number of loaded automations for a trigger type (test/introspection aid). */
  countFor(type: TriggerType): number {
    return this.index.get(type)?.length ?? 0;
  }

  private hooks(): EvaluatorHooks<EngineEvalContext> {
    return {
      evaluateCondition: (node, ctx) => evaluateCondition(node, ctx),
      executeAction: (node, ctx) => executeAction(node, ctx, this.deps),
      applySetVar: (node, ctx) => this.applySetVar(node, ctx),
    };
  }

  /** flow.setVar handling: set / clear / flag / increment a user variable. */
  private async applySetVar(node: AutomationNode, ctx: EngineEvalContext): Promise<void> {
    const p = (node.params ?? {}) as Record<string, unknown>;
    const name = String(p.variable ?? '');
    if (!name) return;
    const op = String(p.op ?? 'set');
    if (op === 'clear') { await this.vars.clearFlag(name, ctx.varCtx); return; }
    if (op === 'flag') { await this.vars.setFlag(name, ctx.varCtx, ctx.now); return; }
    if (op === 'increment') {
      const delta = Number(await resolveOperand(ctx, p.value ?? 1)) || 1;
      await this.vars.increment(name, delta, ctx.varCtx, ctx.now);
      return;
    }
    const value = await resolveOperand(ctx, p.value);
    const r = await this.vars.setValue(name, value, ctx.varCtx, ctx.now);
    if (!r.ok) throw new Error(r.error);
  }

  /**
   * Cooldown verdict for one automation against one event. Returns the key to
   * stamp on success, or the trace reason on suppression.
   *
   * This is the ONLY place the cooldown window is evaluated. The three call sites
   * (message/node/telemetry/system dispatch, schedule dispatch, geofence) must all
   * route through it — a scope fix applied to only one of them is the exact bug
   * this phase exists to prevent.
   */
  private cooldownGate(
    a: LoadedAutomation,
    ctx: TriggerContext,
    now: number,
  ): { ok: true; key: string } | { ok: false; reason: string } {
    if (a.cooldownSeconds <= 0) return { ok: true, key: '' };
    const { key, label } = cooldownKeyFor(a.cooldownScope, ctx);
    const last = this.lastFired.get(a.id)?.get(key);
    const windowMs = a.cooldownSeconds * 1000;
    if (last == null || now - last >= windowMs) return { ok: true, key };
    const remainingMs = Math.max(0, windowMs - (now - last));
    return { ok: false, reason: `cooldown active — ${Math.ceil(remainingMs / 1000)}s remaining (${label})` };
  }

  /** Stamp a fire against its cooldown key, bounding the per-automation key set. */
  private markFired(a: LoadedAutomation, key: string, now: number): void {
    // No cooldown ⇒ nothing can ever be suppressed ⇒ never grow the map. (Today
    // the timestamp is written unconditionally, but it is only ever READ inside
    // the `cooldownSeconds > 0` branch, so skipping it is unobservable and keeps
    // memory at zero for the overwhelmingly common cooldown-less automation.)
    if (a.cooldownSeconds <= 0) return;
    let inner = this.lastFired.get(a.id);
    if (!inner) { inner = new Map(); this.lastFired.set(a.id, inner); }
    inner.set(key, now);
    if (inner.size > COOLDOWN_KEYS_MAX) this.pruneCooldownKeys(a, inner, now);
  }

  private pruneCooldownKeys(a: LoadedAutomation, inner: Map<string, number>, now: number): void {
    const windowMs = a.cooldownSeconds * 1000;
    // Exact pass: an entry older than the window can no longer suppress anything.
    for (const [k, ts] of inner) if (now - ts >= windowMs) inner.delete(k);
    if (inner.size <= COOLDOWN_KEYS_TRIM_TO) return;
    // Backstop: more than COOLDOWN_KEYS_TRIM_TO distinct subjects fired inside one
    // window. Drop the oldest — they expire soonest — accepting that those few
    // subjects may fire once early rather than growing without bound.
    const byAge = [...inner.entries()].sort((x, y) => x[1] - y[1]);
    for (let i = 0; i < byAge.length - COOLDOWN_KEYS_TRIM_TO; i++) inner.delete(byAge[i][0]);
    logger.debug(`[AutomationEngine] "${a.name}" cooldown keys trimmed to ${inner.size} (scope=${a.cooldownScope})`);
  }

  /**
   * Rate-limit verdict for one automation (#4577 Phase 2, RATE-LIMIT). Distinct
   * from {@link cooldownGate}: keyed by automation id ONLY (never per-subject),
   * so it bounds total fires of the whole rule inside a rolling window rather
   * than debouncing a single subject. No `a.rateLimit` ⇒ always ok (pre-Phase-2
   * behaviour). Precedence with cooldownGate is enforced by call order at each
   * dispatch site: cooldown is checked first, and a cooldown-suppressed event
   * never reaches this gate, so it never consumes rate budget.
   */
  private rateLimitGate(a: LoadedAutomation, now: number): { ok: true } | { ok: false; reason: string } {
    if (!a.rateLimit) return { ok: true };
    const { maxActions, windowSeconds } = a.rateLimit;
    const windowMs = windowSeconds * 1000;
    const prior = this.rateLimitEvents.get(a.id) ?? [];
    const events = prior.filter((ts) => now - ts < windowMs);
    this.rateLimitEvents.set(a.id, events);
    if (events.length >= maxActions) {
      return { ok: false, reason: `rate limit reached — ${maxActions}/${windowSeconds}s (flood guard)` };
    }
    return { ok: true };
  }

  /** Stamp a fire against its rate-limit window (#4577 Phase 2). No-op if the automation has no rateLimit. */
  private markRateLimited(a: LoadedAutomation, now: number): void {
    if (!a.rateLimit) return;
    const events = this.rateLimitEvents.get(a.id) ?? [];
    events.push(now);
    this.rateLimitEvents.set(a.id, events);
  }

  /** Prior inside/outside geofence state for (automation, node), or undefined on first sighting. */
  private getGeofenceBaseline(a: LoadedAutomation, nodeNum: number): boolean | undefined {
    return this.geofenceState.get(a.id)?.get(nodeNum)?.inside;
  }

  /** Stamp the new inside/outside baseline, touching its last-checked time and bounding the per-automation node set. */
  private setGeofenceBaseline(a: LoadedAutomation, nodeNum: number, inside: boolean, now: number): void {
    let inner = this.geofenceState.get(a.id);
    if (!inner) { inner = new Map(); this.geofenceState.set(a.id, inner); }
    inner.set(nodeNum, { inside, ts: now });
    if (inner.size > GEOFENCE_STATE_MAX) this.pruneGeofenceState(a, inner);
  }

  private pruneGeofenceState(a: LoadedAutomation, inner: Map<number, { inside: boolean; ts: number }>): void {
    if (inner.size <= GEOFENCE_STATE_TRIM_TO) return;
    // No exact-expiry pass is possible here — see GEOFENCE_STATE_MAX's doc
    // comment for why. Drop the least-recently-touched nodes down to the trim
    // target; their next position update re-establishes a baseline instead of
    // firing on that first check.
    const byAge = [...inner.entries()].sort((x, y) => x[1].ts - y[1].ts);
    const dropCount = byAge.length - GEOFENCE_STATE_TRIM_TO;
    const dropped: number[] = [];
    for (let i = 0; i < dropCount; i++) {
      dropped.push(byAge[i][0]);
      inner.delete(byAge[i][0]);
    }
    logger.warn(
      `[AutomationEngine] "${a.name}" geofence state trimmed to ${inner.size} node(s); ${dropCount} dropped ` +
      `(their next check re-baselines instead of firing): ${dropped.slice(0, 20).join(', ')}${dropped.length > 20 ? ', …' : ''}`,
    );
  }

  /**
   * Run a single trigger context against the automations registered for its type.
   * Returns the number of automations that fired (passed pre-filter + cooldown).
   *
   * `describeMiss` is the live-trace ("view logs") explainer: called ONLY when a
   * rule is being traced AND its pre-filter rejected the event, to report why.
   */
  private async runTrigger(
    ctx: TriggerContext,
    prefilter?: (a: LoadedAutomation) => boolean,
    describeMiss?: (a: LoadedAutomation) => string | undefined,
  ): Promise<number> {
    const entries = this.index.get(ctx.triggerType);
    if (!entries || entries.length === 0) return 0;
    const now = this.now();
    const tracingAny = automationTraceBus.activeCount() > 0;
    let fired = 0;
    for (const a of entries) {
      const traced = tracingAny && automationTraceBus.isTracing(a.id, now);
      if (prefilter && !prefilter(a)) {
        if (traced) this.emitTrace(a, ctx, now, { outcome: 'prefiltered', reason: describeMiss?.(a) ?? 'did not match the trigger filter' });
        continue;
      }
      const gate = this.cooldownGate(a, ctx, now);
      if (!gate.ok) {
        if (traced) this.emitTrace(a, ctx, now, { outcome: 'cooldown', reason: gate.reason });
        continue;
      }
      const rateGate = this.rateLimitGate(a, now);
      if (!rateGate.ok) {
        if (traced) this.emitTrace(a, ctx, now, { outcome: 'ratelimited', reason: rateGate.reason });
        continue;
      }
      this.markFired(a, gate.key, now);
      this.markRateLimited(a, now);
      fired++;
      const fr = await this.fireAutomation(a, ctx, now);
      if (traced) this.emitTrace(a, ctx, now, { outcome: 'fired', status: fr.status, conditionResults: fr.conditionResults, actions: fr.actions, steps: fr.steps });
    }
    return fired;
  }

  /** Emit one live-trace verdict for a rule to any browser tracing it (#view-logs). */
  private emitTrace(a: LoadedAutomation, ctx: TriggerContext, now: number, verdict: Record<string, unknown>): void {
    automationTraceBus.emit(a.id, {
      ts: now,
      automationId: a.id,
      automationName: a.name,
      triggerType: ctx.triggerType,
      sourceId: ctx.sourceId,
      event: compactEventFields(ctx.fields),
      ...verdict,
    }, now);
  }

  /**
   * Evaluate one automation's graph against a trigger context and write a run-log
   * row. Returns a compact result the live trace reuses (the persisted run-log
   * shape is unchanged).
   */
  private async fireAutomation(a: LoadedAutomation, ctx: TriggerContext, now: number): Promise<FireResult> {
    const evalCtx: EngineEvalContext = {
      trigger: ctx,
      vars: this.vars,
      data: this.data,
      varCtx: varContextFromTrigger(ctx),
      now,
    };
    try {
      const result = await evaluateGraph(a.graph, evalCtx, this.hooks(), { maxActions: this.maxActions });
      const anyFailed = result.actions.some((x) => !x.ok);
      await this.automationsRepo.createRun({
        automationId: a.id,
        sourceId: ctx.sourceId,
        status: anyFailed ? 'failed' : 'completed',
        triggerEvent: JSON.stringify(ctx.fields),
        log: JSON.stringify(result.steps),
      });
      return {
        status: anyFailed ? 'failed' : 'completed',
        conditionResults: result.conditionResults,
        actions: result.actions.map((x) => ({ nodeId: x.nodeId, ok: x.ok, error: x.error })),
        steps: result.steps,
      };
    } catch (e: any) {
      logger.error(`[AutomationEngine] automation "${a.name}" threw: ${e?.message}`);
      await this.automationsRepo.createRun({
        automationId: a.id,
        sourceId: ctx.sourceId,
        status: 'failed',
        triggerEvent: JSON.stringify(ctx.fields),
        log: JSON.stringify([{ outcome: 'engine:error', error: e?.message }]),
      });
      return {
        status: 'failed',
        conditionResults: {},
        actions: [],
        steps: [{ nodeId: a.id, type: 'engine', outcome: 'engine:error', error: e?.message }],
      };
    }
  }

  // ─── self-origin guard (#3914) ──────────────────────────────────────────
  //
  // Drop events that originated from our OWN node so an automation never fires
  // on MeshMonitor's own traffic — most importantly so an `action.sendMessage`
  // reply can't re-trigger the very rule that sent it (an infinite mesh loop),
  // and so our own periodic telemetry / node-info doesn't spuriously fire rules.
  // Mirrors the legacy MeshCore auto-responder guard. Identity is resolved per
  // source via optional data-provider accessors; when they're absent (e.g. a
  // unit test that doesn't wire them) nothing is dropped — existing behavior.

  /**
   * True if `fromNodeNum` is one of MeshMonitor's own nodes.
   *
   * Checks the event's own source first (the #3914 behaviour), then falls back
   * to the cross-source owned-node set. The fallback exists for sources that
   * have no local node of their own — an `mqtt_bridge` re-delivers a message we
   * sent on a Meshtastic source once some third-party gateway uplinks it to the
   * broker, and without the fallback the guard never fires there, so an
   * auto-reply automation re-triggers on its own reply (#4593).
   */
  private async isSelfMeshtastic(sourceId: string | null, fromNodeNum: number | null | undefined): Promise<boolean> {
    if (fromNodeNum == null) return false;
    if (this.data.getLocalNodeNum) {
      const local = await this.data.getLocalNodeNum(sourceId);
      if (local != null && Number(local) === Number(fromNodeNum)) return true;
    }
    if (this.data.isOwnNodeNum) {
      return await this.data.isOwnNodeNum(Number(fromNodeNum));
    }
    return false;
  }

  /**
   * True if `fromPublicKey` is one of MeshMonitor's own MeshCore nodes.
   *
   * Checks the event's own source first (the #3914 behaviour), then falls back
   * to the cross-source owned-pubkey set. The fallback exists for multi-MeshCore
   * -source / bridge setups where the event's source hasn't resolved its own
   * key yet (or the key belongs to a different MeshCore source we also own),
   * mirroring the Meshtastic `isOwnNodeNum` fallback above (#4577 P2).
   */
  private async isSelfMeshCore(sourceId: string | null, fromPublicKey: string | null | undefined): Promise<boolean> {
    if (!fromPublicKey) return false;
    if (this.data.getSelfPublicKey) {
      const key = await this.data.getSelfPublicKey(sourceId);
      if (key != null && key.toLowerCase() === fromPublicKey.toLowerCase()) return true;
    }
    if (this.data.isOwnPublicKey) {
      return await this.data.isOwnPublicKey(fromPublicKey);
    }
    return false;
  }

  /**
   * True when a loaded `trigger.message` automation explicitly opts back into
   * self-originated events (#4694). The #3914 self-origin guard above exists
   * to stop an `action.sendMessage` reply from re-triggering the very rule
   * that sent it, but that same guard silently made the MT↔MC bridge template
   * (`bridge.ts`) blind to messages the operator typed on their OWN connected
   * node — those never crossed to the other protocol at all. The bridge
   * already has its own independent loop guard (the `notContains 'MT@'/'MC@'`
   * tag conditions), so it sets `includeSelf: true` on its trigger to skip
   * this guard rather than needing it disabled globally.
   */
  private includesSelfOrigin(a: LoadedAutomation): boolean {
    return (a.triggerNode.params as Record<string, unknown> | undefined)?.includeSelf === true;
  }

  // ─── event entry points ─────────────────────────────────────────────────

  async onMessage(msg: DbMessage, sourceId: string | null): Promise<number> {
    // #3914: ignore our own sends, UNLESS the matching automation opted back in
    // via `includeSelf` (#4694 — see includesSelfOrigin()'s doc comment).
    const isSelf = await this.isSelfMeshtastic(sourceId, msg.fromNodeNum);
    // Resolve the per-source channel name + sender node name once. We resolve when
    // EITHER a channelName/`channels` filter needs it (#3974) OR the universal
    // channelName/fromName/senderLabel tokens need populating — and since ANY loaded
    // message automation may reference those tokens, "a message automation is loaded"
    // subsumes the filter case, so one lookup serves both. Hot path stays DB-free
    // when no message automation is loaded. The resolved name still feeds
    // messageMatchesFilter, which does #3974's single- and multi-channel matching.
    const hasMessageAutomations = (this.index.get('trigger.message') ?? []).length > 0;
    let channelName: string | null | undefined;
    let fromName: string | undefined;
    // #4594: whether this message came in through an MQTT source, which swaps the
    // hop glyph for #️⃣. Resolved on the same "a message automation is loaded"
    // gate as the labels above so the DB-free hot path is preserved; a provider
    // without the accessor (older/unit-test providers) yields false = today's
    // behaviour.
    let viaMqttSource = false;
    if (hasMessageAutomations) {
      if (this.data.getChannelName) {
        channelName = await this.data.getChannelName(sourceId, Number(msg.channel));
      }
      // Sender display name resolved the same way the UI does (long → short name);
      // the builder falls back to the node id when the node is unknown.
      const node = await this.data.getNode(sourceId, Number(msg.fromNodeNum));
      fromName = node?.longName || node?.shortName || undefined;
      if (this.data.getSourceType) {
        viaMqttSource = isMqttSourceType(await this.data.getSourceType(sourceId));
      }
    }
    const ctx = buildMessageContext(msg, sourceId, this.now(), { channelName, fromName, viaMqttSource });
    return this.runTrigger(
      ctx,
      (a) => (!isSelf || this.includesSelfOrigin(a)) && messageMatchesFilter(msg, a.triggerNode.params ?? {}, channelName),
      (a) => describeMessageFilterMiss(msg, a.triggerNode.params ?? {}, channelName),
    );
  }

  /**
   * MeshCore message entry point (#3833). Mirrors {@link onMessage} but builds a
   * MeshCore-shaped trigger context and uses the MeshCore matcher, so the same
   * `trigger.message` automations fire on MeshCore received messages (which the
   * engine previously ignored entirely).
   */
  async onMeshCoreMessage(msg: MeshCoreMessage, sourceId: string | null): Promise<number> {
    // #3914: ignore our own sends, UNLESS the matching automation opted back in
    // via `includeSelf` (#4694 — see includesSelfOrigin()'s doc comment).
    const isSelf = await this.isSelfMeshCore(sourceId, msg.fromPublicKey);
    // Same reconciliation as onMessage: resolve the channel name when any message
    // automation is loaded (subsumes #3974's channelName/`channels` filter gate),
    // feeding both the universal channelName/senderLabel tokens and the matcher's
    // single-/multi-channel matching. `channel-<idx>` is parsed straight from the
    // sender key so we can resolve BEFORE building the context (to pass it in).
    const hasMessageAutomations = (this.index.get('trigger.message') ?? []).length > 0;
    const channelIdx = parseMeshCoreChannelIdx(msg.fromPublicKey);
    let channelName: string | null | undefined;
    if (hasMessageAutomations && this.data.getChannelName && typeof channelIdx === 'number') {
      channelName = await this.data.getChannelName(sourceId, channelIdx);
    }
    const ctx = buildMeshCoreMessageContext(msg, sourceId, this.now(), { channelName });
    return this.runTrigger(
      ctx,
      (a) => (!isSelf || this.includesSelfOrigin(a)) && meshCoreMessageMatchesFilter(msg, a.triggerNode.params ?? {}, channelName),
      (a) => describeMeshCoreFilterMiss(msg, a.triggerNode.params ?? {}, channelName),
    );
  }

  /**
   * Reticulum LXMF message entry point (#3960 Phase 2 WP3). Mirrors
   * {@link onMessage}/{@link onMeshCoreMessage} but builds a Reticulum-shaped
   * trigger context and uses the LXMF matcher, so the same `trigger.message`
   * automations fire on inbound LXMF messages too.
   *
   * NO self-origin re-check here (unlike {@link onMessage}/{@link onMeshCoreMessage}):
   * `ReticulumManager`'s guard already runs upstream, before `reticulum:message`
   * is ever emitted for a self-addressed row — see `buildReticulumMessageContext`'s
   * doc comment.
   */
  async onReticulumMessage(msg: ReticulumMessageRow, sourceId: string | null): Promise<number> {
    const ctx = buildReticulumMessageContext(msg, sourceId, this.now());
    return this.runTrigger(
      ctx,
      (a) => reticulumMessageMatchesFilter(msg, a.triggerNode.params ?? {}),
      (a) => describeReticulumFilterMiss(msg, a.triggerNode.params ?? {}),
    );
  }

  async onNode(
    kind: 'trigger.nodeDiscovered' | 'trigger.nodeUpdated',
    nodeNum: number,
    changedKeys: string[],
    sourceId: string | null,
  ): Promise<number> {
    if (await this.isSelfMeshtastic(sourceId, nodeNum)) return 0; // #3914: ignore our own node updates
    return this.runTrigger(buildNodeContext(kind, nodeNum, changedKeys, sourceId, this.now()));
  }

  async onTelemetry(
    nodeNum: number,
    telemetryType: string,
    value: number,
    unit: string | undefined,
    sourceId: string | null,
  ): Promise<number> {
    if (await this.isSelfMeshtastic(sourceId, nodeNum)) return 0; // #3914: ignore our own telemetry
    const ctx = buildTelemetryContext(nodeNum, telemetryType, value, unit, sourceId, this.now());
    return this.runTrigger(
      ctx,
      (a) => {
        const want = (a.triggerNode.params as any)?.telemetryType;
        return want == null || want === telemetryType;
      },
      (a) => {
        const want = (a.triggerNode.params as any)?.telemetryType;
        return `telemetry "${telemetryType}" ≠ rule metric "${want}"`;
      },
    );
  }

  /**
   * A node's uptime counter reset — an unexpected reboot (`trigger.nodeRebooted`,
   * Device Health #4558 Phase B). Detection (reading the prior uptime from the
   * DB and comparing) already happened at the telemetry-save seam, so this is a
   * pure event entry point: build the context and fire.
   *
   * No self-origin guard (#3914) here — unlike {@link onTelemetry}. This is a
   * health signal in the same family as {@link runStaleCheck}'s nodeStale/
   * nodeOnline, which also don't drop our own node: knowing your OWN gateway
   * rebooted is useful, and a reboot is not something an automation action can
   * cause, so there is no self-trigger loop to guard against.
   *
   * Meshtastic reboots pass a real `nodeNum` (`publicKey` null); MeshCore reboots
   * (#4558 follow-up) pass `nodeNum: null` plus the pubkey, which becomes the
   * subject identity for `{{ node.* }}`-less pubkey cooldown scoping.
   */
  async onNodeRebooted(
    nodeNum: number | null,
    publicKey: string | null,
    previousUptimeSeconds: number,
    uptimeSeconds: number,
    sourceId: string | null,
  ): Promise<number> {
    const ctx = buildNodeRebootedContext(nodeNum, publicKey, previousUptimeSeconds, uptimeSeconds, sourceId, this.now());
    return this.runTrigger(ctx);
  }

  /**
   * A node's power source flipped between external/USB power and battery
   * (`trigger.nodePowerChanged`, Device Health #4558 Phase C). Detection (reading
   * the prior batteryLevel from the DB and comparing against the firmware's > 100
   * "powered" convention) already happened at the telemetry-save seam, so this is
   * a pure event entry point: build the context and fire the rules whose
   * `direction` param matches this transition.
   *
   * The `direction` param is 'lost' | 'restored' | 'either' (default 'either'):
   * a rule fires only when the actual transition matches, so "external power
   * lost" and its recovery live in one trigger without catalog bloat.
   *
   * No self-origin guard (#3914) here — same family as {@link onNodeRebooted}:
   * a power transition is not something an automation action can cause, so there
   * is no self-trigger loop to guard against, and knowing your OWN gateway lost
   * wall power is useful.
   *
   * Meshtastic passes a real `nodeNum` (`publicKey` null). MeshCore (#4558
   * parity) passes `nodeNum: null` plus the pubkey, which becomes the subject
   * identity — note the MeshCore path is a battery-voltage HEURISTIC and can
   * misfire (see detectMeshCorePowerChange).
   */
  async onNodePowerChanged(
    nodeNum: number | null,
    publicKey: string | null,
    previousPowered: boolean,
    powered: boolean,
    batteryLevel: number,
    sourceId: string | null,
  ): Promise<number> {
    const direction = powered ? 'restored' : 'lost';
    const ctx = buildNodePowerChangedContext(nodeNum, publicKey, previousPowered, powered, batteryLevel, sourceId, this.now());
    return this.runTrigger(
      ctx,
      (a) => {
        const want = a.triggerNode.params?.direction;
        return want == null || want === '' || want === 'either' || want === direction;
      },
      (a) => {
        const want = a.triggerNode.params?.direction ?? 'either';
        return `power transition "${direction}" ≠ rule direction "${String(want)}"`;
      },
    );
  }

  /**
   * A MeshBeacon broadcast was received (firmware 2.8+, #3854).
   *
   * `messageContains` filters on the beacon text; `requireOffer` narrows to
   * beacons that actually advertise a network. A text-only beacon is the common
   * case, so a rule reacting to network offers has to ask for that explicitly.
   */
  async onMeshBeacon(
    nodeNum: number,
    message: string,
    offer: { channelName?: string; region?: number; preset?: number },
    sourceId: string | null,
  ): Promise<number> {
    if (await this.isSelfMeshtastic(sourceId, nodeNum)) return 0; // #3914: ignore our own beacons
    const ctx = buildMeshBeaconContext(nodeNum, message, offer, sourceId, this.now());
    const hasOffer = Boolean(ctx.fields.hasOffer);
    return this.runTrigger(
      ctx,
      (a) => {
        const params = (a.triggerNode.params ?? {}) as { messageContains?: string; requireOffer?: boolean };
        if (params.requireOffer && !hasOffer) return false;
        const want = params.messageContains;
        if (want == null || want === '') return true;
        return message.toLowerCase().includes(String(want).toLowerCase());
      },
      (a) => {
        const params = (a.triggerNode.params ?? {}) as { messageContains?: string; requireOffer?: boolean };
        if (params.requireOffer && !hasOffer) return 'beacon carries no network offer';
        return `beacon text "${message}" does not contain "${params.messageContains}"`;
      },
    );
  }

  async onSystem(
    event: SystemEvent,
    sourceId: string | null,
    nodeNum: number | null,
    reason?: string,
    extra?: Record<string, unknown>,
  ): Promise<number> {
    const ctx = buildSystemContext(event, sourceId, nodeNum, reason, this.now(), extra);
    // Pre-filter on the configured `event` param so a "system start" automation
    // doesn't also fire on "source online" etc. An unset event matches any.
    return this.runTrigger(
      ctx,
      (a) => {
        const want = (a.triggerNode.params as any)?.event;
        return want == null || want === '' || want === event;
      },
      (a) => {
        const want = (a.triggerNode.params as any)?.event;
        return `system event "${event}" ≠ rule event "${want}"`;
      },
    );
  }

  /**
   * Geofence check — call when a node's position changes. For each geofence
   * automation, compute inside/outside vs its region, compare to the node's last
   * state, and fire on the configured enter/exit/dwell transition. The first
   * sighting only establishes a baseline (no fire). Returns the number fired.
   */
  async checkGeofences(nodeNum: number, sourceId: string | null): Promise<number> {
    const entries = this.index.get('trigger.geofence');
    if (!entries || entries.length === 0) return 0;
    const node = await this.data.getNode(sourceId, nodeNum);
    if (!node || node.latitude == null || node.longitude == null) return 0;
    const now = this.now();
    let fired = 0;
    for (const a of entries) {
      const p = (a.triggerNode.params ?? {}) as Record<string, unknown>;
      const mode = (String(p.event ?? 'enter') as GeofenceMode);

      // #4722: a fence may be anchored to a waypoint instead of a drawn region.
      // Resolve it per check so moving the waypoint moves the fence. It fails
      // CLOSED — a deleted waypoint (or a provider without waypoint support)
      // never fires rather than falling back to some other region.
      const anchor = normalizeGeofenceAnchor(p);
      let shape: GeofenceShape | null;
      if (anchor) {
        const position = this.data.getWaypoint
          ? await this.data.getWaypoint(anchor.sourceId, anchor.waypointId).catch(() => null)
          : null;
        if (!position) {
          if (automationTraceBus.activeCount() > 0 && automationTraceBus.isTracing(a.id, now)) {
            this.emitTrace(
              a,
              buildGeofenceContext(nodeNum, mode, node.latitude, node.longitude, 0, sourceId, now),
              now,
              { outcome: 'prefiltered', reason: `waypoint ${anchor.waypointId} not found on source ${anchor.sourceId} — fence cannot be resolved` },
            );
          }
          continue;
        }
        shape = shapeFromWaypoint(anchor, position);
      } else {
        shape = normalizeGeofenceParams(p);
      }
      if (!shape) continue;

      const inside = pointInShape(node.latitude, node.longitude, shape);
      // Distance to the region's reference point (circle center / polygon
      // centroid) so {{ trigger.distanceKm }} stays meaningful for both shapes.
      const center = geofenceCenter(shape);
      const distanceKm = haversineKm(node.latitude, node.longitude, center.lat, center.lng);
      const prev = this.getGeofenceBaseline(a, nodeNum);
      this.setGeofenceBaseline(a, nodeNum, inside, now);

      const traced = automationTraceBus.activeCount() > 0 && automationTraceBus.isTracing(a.id, now);
      const geoCtx = buildGeofenceContext(nodeNum, mode, node.latitude, node.longitude, distanceKm, sourceId, now);

      if (!geofenceFires(prev, inside, mode)) {
        if (traced) this.emitTrace(a, geoCtx, now, { outcome: 'prefiltered', reason: prev === undefined ? 'first sighting — baseline only' : `no ${mode} transition (node ${inside ? 'inside' : 'outside'})` });
        continue;
      }
      const gate = this.cooldownGate(a, geoCtx, now);
      if (!gate.ok) {
        if (traced) this.emitTrace(a, geoCtx, now, { outcome: 'cooldown', reason: gate.reason });
        continue;
      }
      const rateGate = this.rateLimitGate(a, now);
      if (!rateGate.ok) {
        if (traced) this.emitTrace(a, geoCtx, now, { outcome: 'ratelimited', reason: rateGate.reason });
        continue;
      }
      this.markFired(a, gate.key, now);
      this.markRateLimited(a, now);
      fired++;
      const fr = await this.fireAutomation(a, geoCtx, now);
      if (traced) this.emitTrace(a, geoCtx, now, { outcome: 'fired', status: fr.status, conditionResults: fr.conditionResults, actions: fr.actions, steps: fr.steps });
    }
    return fired;
  }

  /**
   * Fire `trigger.becameMobile` automations when a watched node flips 0→1.
   * Called after mobility recompute with the previous+current flags.
   */
  async checkBecameMobile(
    nodeNum: number,
    previousMobile: number,
    currentMobile: number,
    sourceId: string | null,
  ): Promise<number> {
    if (!(previousMobile === 0 && currentMobile === 1)) return 0;
    const entries = this.index.get('trigger.becameMobile');
    if (!entries || entries.length === 0) return 0;

    const node = await this.data.getNode(sourceId, nodeNum);
    const now = this.now();
    let fired = 0;

    for (const a of entries) {
      const p = (a.triggerNode.params ?? {}) as Record<string, unknown>;
      if (!nodeNumsInclude(p.nodeNums, nodeNum)) continue;

      const ctx = buildBecameMobileContext(
        nodeNum,
        node?.latitude,
        node?.longitude,
        previousMobile,
        currentMobile,
        sourceId,
        now,
      );
      const traced = automationTraceBus.activeCount() > 0 && automationTraceBus.isTracing(a.id, now);
      const gate = this.cooldownGate(a, ctx, now);
      if (!gate.ok) {
        if (traced) this.emitTrace(a, ctx, now, { outcome: 'cooldown', reason: gate.reason });
        continue;
      }
      const rateGate = this.rateLimitGate(a, now);
      if (!rateGate.ok) {
        if (traced) this.emitTrace(a, ctx, now, { outcome: 'ratelimited', reason: rateGate.reason });
        continue;
      }
      this.markFired(a, gate.key, now);
      this.markRateLimited(a, now);
      fired++;
      const fr = await this.fireAutomation(a, ctx, now);
      if (traced) this.emitTrace(a, ctx, now, { outcome: 'fired', status: fr.status, conditionResults: fr.conditionResults, actions: fr.actions, steps: fr.steps });
    }
    return fired;
  }

  /**
   * Fire `trigger.leftHome` automations when a watched node exceeds its home
   * distance. First sighting establishes (and persists) home without firing;
   * returning within threshold re-arms after an alert.
   *
   * While the node stays within threshold/2 of home, the anchor is refined with
   * an exponential moving average so a glitched first fix can drift toward the
   * true site without waiting for multi-packet confirmation (sparse ~3h beacons).
   * Fixes beyond threshold/2 never pull home (and beyond threshold may fire).
   */
  async checkLeftHome(nodeNum: number, sourceId: string | null): Promise<number> {
    const entries = this.index.get('trigger.leftHome');
    if (!entries || entries.length === 0) return 0;
    const node = await this.data.getNode(sourceId, nodeNum);
    if (!node || node.latitude == null || node.longitude == null) return 0;

    const now = this.now();
    let fired = 0;

    for (const a of entries) {
      const p = (a.triggerNode.params ?? {}) as Record<string, unknown>;
      if (!nodeNumsInclude(p.nodeNums, nodeNum)) continue;

      const thresholdMeters = Number(p.thresholdMeters ?? 300);
      if (!Number.isFinite(thresholdMeters) || thresholdMeters <= 0) continue;
      const refineRadius = thresholdMeters / 2;

      const home = this.homeAnchorsRepo
        ? await this.homeAnchorsRepo.getAnchor(a.id, nodeNum)
        : null;

      if (!home) {
        // First sighting: prefer a history-derived cluster home when available
        // (drops spider-line outliers), else the live fix.
        let homeLat = node.latitude;
        let homeLon = node.longitude;
        let fromHistory = false;
        if (this.estimateHomeFromHistory) {
          try {
            const est = await this.estimateHomeFromHistory(nodeNum, thresholdMeters);
            if (est) {
              homeLat = est.latitude;
              homeLon = est.longitude;
              fromHistory = true;
            }
          } catch (e) {
            logger.warn(`[AutomationEngine] leftHome history seed failed for node ${nodeNum}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (this.homeAnchorsRepo) {
          await this.homeAnchorsRepo.upsertAnchor(a.id, nodeNum, homeLat, homeLon, now);
        }
        const ctx = buildLeftHomeContext(
          nodeNum, node.latitude, node.longitude,
          homeLat, homeLon, 0, thresholdMeters, sourceId, now,
        );
        const traced = automationTraceBus.activeCount() > 0 && automationTraceBus.isTracing(a.id, now);
        if (traced) {
          this.emitTrace(a, ctx, now, {
            outcome: 'prefiltered',
            reason: fromHistory ? 'first sighting — home seeded from position history' : 'first sighting — home established',
          });
        }
        continue;
      }

      const distanceKm = haversineKm(node.latitude, node.longitude, home.latitude, home.longitude);
      const distanceMeters = distanceKm * 1000;
      const beyond = distanceMeters > thresholdMeters;
      const alarmed = this.leftHomeAlarmed.get(a.id)?.get(nodeNum) === true;

      const ctx = buildLeftHomeContext(
        nodeNum, node.latitude, node.longitude,
        home.latitude, home.longitude, distanceMeters, thresholdMeters, sourceId, now,
      );
      const traced = automationTraceBus.activeCount() > 0 && automationTraceBus.isTracing(a.id, now);

      if (!beyond) {
        // Back within threshold → re-arm.
        if (alarmed) {
          const inner = this.leftHomeAlarmed.get(a.id);
          if (inner) inner.set(nodeNum, false);
        }
        // Soft-refine home while the fix is in the inner half-radius so a
        // glitched first anchor can crawl toward the real cluster. Outside
        // refineRadius we leave home alone (noise / partial move).
        if (distanceMeters <= refineRadius && this.homeAnchorsRepo) {
          const alpha = LEFT_HOME_REFINE_ALPHA;
          const newLat = home.latitude * (1 - alpha) + node.latitude * alpha;
          const newLon = home.longitude * (1 - alpha) + node.longitude * alpha;
          await this.homeAnchorsRepo.upsertAnchor(a.id, nodeNum, newLat, newLon, now);
          if (traced) {
            this.emitTrace(a, ctx, now, {
              outcome: 'prefiltered',
              reason: `within home refine radius — anchor averaged (α=${alpha})`,
            });
          }
        } else if (traced) {
          this.emitTrace(a, ctx, now, { outcome: 'prefiltered', reason: 'within home threshold' });
        }
        continue;
      }

      if (alarmed) {
        if (traced) this.emitTrace(a, ctx, now, { outcome: 'prefiltered', reason: 'already alarmed (awaiting return within threshold)' });
        continue;
      }

      const gate = this.cooldownGate(a, ctx, now);
      if (!gate.ok) {
        if (traced) this.emitTrace(a, ctx, now, { outcome: 'cooldown', reason: gate.reason });
        continue;
      }
      const rateGate = this.rateLimitGate(a, now);
      if (!rateGate.ok) {
        if (traced) this.emitTrace(a, ctx, now, { outcome: 'ratelimited', reason: rateGate.reason });
        continue;
      }

      let inner = this.leftHomeAlarmed.get(a.id);
      if (!inner) { inner = new Map(); this.leftHomeAlarmed.set(a.id, inner); }
      inner.set(nodeNum, true);

      this.markFired(a, gate.key, now);
      this.markRateLimited(a, now);
      fired++;
      const fr = await this.fireAutomation(a, ctx, now);
      if (traced) this.emitTrace(a, ctx, now, { outcome: 'fired', status: fr.status, conditionResults: fr.conditionResults, actions: fr.actions, steps: fr.steps });
    }
    return fired;
  }

  // ─── staleness: trigger.nodeStale / trigger.nodeOnline (#4558 Phase A) ──────

  private getStaleBaseline(a: LoadedAutomation, key: string): StaleEntry | undefined {
    return this.staleState.get(a.id)?.get(key);
  }

  private setStaleBaseline(a: LoadedAutomation, key: string, entry: StaleEntry): void {
    let inner = this.staleState.get(a.id);
    if (!inner) { inner = new Map(); this.staleState.set(a.id, inner); }
    inner.set(key, entry);
    if (inner.size > STALE_STATE_MAX) this.pruneStaleState(a, inner);
  }

  private pruneStaleState(a: LoadedAutomation, inner: Map<string, StaleEntry>): void {
    if (inner.size <= STALE_STATE_TRIM_TO) return;
    // Eviction is behaviour-safe (see STALE_STATE_MAX doc): drop the
    // least-recently-seen entries — those nodes have most likely dropped out of
    // the enumeration (deleted / churned), and any live one just re-baselines.
    const byAge = [...inner.entries()].sort((x, y) => x[1].ts - y[1].ts);
    const dropCount = byAge.length - STALE_STATE_TRIM_TO;
    for (let i = 0; i < dropCount; i++) inner.delete(byAge[i][0]);
    logger.debug(`[AutomationEngine] "${a.name}" stale state trimmed to ${inner.size}`);
  }

  /**
   * Cooldown + rate-limit gate + fire + trace, shared by both staleness
   * transitions. Returns 1 if it dispatched, 0 if a guard suppressed it. The
   * baseline mark is flipped by the CALLER before this runs, so a cooldown that
   * eats one fire does not cause a re-fire on the next tick — the transition is
   * recorded regardless of whether its action was allowed to run.
   */
  private async fireStaleTransition(a: LoadedAutomation, ctx: TriggerContext, now: number): Promise<number> {
    const traced = automationTraceBus.activeCount() > 0 && automationTraceBus.isTracing(a.id, now);
    const gate = this.cooldownGate(a, ctx, now);
    if (!gate.ok) {
      if (traced) this.emitTrace(a, ctx, now, { outcome: 'cooldown', reason: gate.reason });
      return 0;
    }
    const rateGate = this.rateLimitGate(a, now);
    if (!rateGate.ok) {
      if (traced) this.emitTrace(a, ctx, now, { outcome: 'ratelimited', reason: rateGate.reason });
      return 0;
    }
    this.markFired(a, gate.key, now);
    this.markRateLimited(a, now);
    const fr = await this.fireAutomation(a, ctx, now);
    if (traced) this.emitTrace(a, ctx, now, { outcome: 'fired', status: fr.status, conditionResults: fr.conditionResults, actions: fr.actions, steps: fr.steps });
    return 1;
  }

  /**
   * Periodic staleness evaluation (#4558 Phase A) — the packet-ABSENCE driver for
   * `trigger.nodeStale` ("heartbeat lost") and `trigger.nodeOnline` ("recovery").
   *
   * For every enabled nodeStale/nodeOnline automation, compares each tracked
   * node's age (now − lastHeard) against that automation's OWN staleAfterMinutes:
   *  - a node's FIRST sighting only ESTABLISHES a baseline (no fire). This is what
   *    makes a process restart NOT re-fire "heartbeat lost" for nodes that were
   *    already stale before the restart — the real state (lastHeard) lives in the
   *    DB, and the derived baseline is rebuilt silently on the first tick;
   *  - online → stale fires `trigger.nodeStale` once and marks the node stale;
   *  - stale → online fires `trigger.nodeOnline` once and clears the mark (also
   *    reachable faster on a live update via {@link checkNodeOnline}; whichever
   *    flips the mark first wins, so recovery never double-fires).
   *
   * Both triggers maintain the SAME baseline map so recovery is detectable — a
   * nodeStale automation still marks/clears silently on the recovery side, and a
   * nodeOnline automation still marks silently on the going-stale side. Returns
   * the number of automations that dispatched this tick.
   */
  async runStaleCheck(): Promise<number> {
    const autos = [
      ...(this.index.get('trigger.nodeStale') ?? []),
      ...(this.index.get('trigger.nodeOnline') ?? []),
    ];
    if (autos.length === 0) return 0;
    if (!this.data.listNodesForStaleCheck) return 0;

    let candidates: StaleCandidate[];
    try {
      candidates = await this.data.listNodesForStaleCheck();
    } catch (e) {
      logger.error(`[AutomationEngine] stale check node enumeration failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }

    const now = this.now();
    let fired = 0;

    for (const a of autos) {
      const thresholdMinutes = Number((a.triggerNode.params as Record<string, unknown>)?.staleAfterMinutes);
      if (!Number.isFinite(thresholdMinutes) || thresholdMinutes <= 0) continue;
      const thresholdMs = thresholdMinutes * 60_000;
      const isStaleTrigger = a.triggerType === 'trigger.nodeStale';

      for (const c of candidates) {
        if (c.lastHeardMs == null) continue; // never heard → no transition to detect
        const key = staleKeyFor(c);
        const isStale = now - c.lastHeardMs >= thresholdMs;
        const prev = this.getStaleBaseline(a, key);

        if (prev === undefined) {
          // First sighting after (re)start: baseline only, never a fire.
          this.setStaleBaseline(a, key, { stale: isStale, lastHeardMs: c.lastHeardMs, ts: now });
          continue;
        }

        if (!prev.stale && isStale) {
          // online → stale. Record the mark first (so a suppressed fire can't re-fire).
          this.setStaleBaseline(a, key, { stale: true, lastHeardMs: c.lastHeardMs, ts: now });
          if (isStaleTrigger) {
            const ageMinutes = Math.max(0, Math.floor((now - c.lastHeardMs) / 60_000));
            const ctx = buildNodeStaleContext(c.nodeNum, c.publicKey, ageMinutes, thresholdMinutes, c.lastHeardMs, c.sourceId, now);
            fired += await this.fireStaleTransition(a, ctx, now);
          }
        } else if (prev.stale && !isStale) {
          // stale → online (the tick observed the recovery; the fallback path).
          const offlineDurationMinutes = Math.max(0, Math.floor((now - (prev.lastHeardMs ?? c.lastHeardMs)) / 60_000));
          this.setStaleBaseline(a, key, { stale: false, lastHeardMs: c.lastHeardMs, ts: now });
          if (!isStaleTrigger) {
            const ctx = buildNodeOnlineContext(c.nodeNum, c.publicKey, offlineDurationMinutes, thresholdMinutes, c.sourceId, now);
            fired += await this.fireStaleTransition(a, ctx, now);
          }
        } else {
          // No transition — just refresh the touched-timestamp for eviction ordering.
          this.setStaleBaseline(a, key, { stale: prev.stale, lastHeardMs: prev.lastHeardMs, ts: now });
        }
      }
    }
    return fired;
  }

  /**
   * Live-update recovery path for `trigger.nodeOnline` (#4558 Phase A). Called
   * when a Meshtastic node update arrives: if any nodeOnline automation had
   * marked this node stale, fire the recovery now — faster than waiting for the
   * next stale tick — and clear the mark. The tick reaches the same transition
   * as a fallback; whichever flips the mark first wins, so it never double-fires.
   */
  async checkNodeOnline(nodeNum: number, sourceId: string | null): Promise<number> {
    const online = this.index.get('trigger.nodeOnline');
    if (!online || online.length === 0) return 0;
    const now = this.now();
    const key = `${sourceId ?? ''}:${nodeNum}`;
    let fired = 0;
    for (const a of online) {
      const prev = this.getStaleBaseline(a, key);
      if (!prev || !prev.stale) continue;
      const thresholdMinutes = Number((a.triggerNode.params as Record<string, unknown>)?.staleAfterMinutes);
      const offlineDurationMinutes = Math.max(0, Math.floor((now - (prev.lastHeardMs ?? now)) / 60_000));
      // Clear the mark before firing so the tick's fallback can't also fire it.
      this.setStaleBaseline(a, key, { stale: false, lastHeardMs: now, ts: now });
      const ctx = buildNodeOnlineContext(
        nodeNum, null, offlineDurationMinutes,
        Number.isFinite(thresholdMinutes) ? thresholdMinutes : 0, sourceId, now,
      );
      fired += await this.fireStaleTransition(a, ctx, now);
    }
    return fired;
  }

  // ─── battery trend: trigger.batteryTrend (#4558 Phase E) ────────────────────

  private getBatteryTrendBaseline(a: LoadedAutomation, key: string): BatteryTrendEntry | undefined {
    return this.batteryTrendState.get(a.id)?.get(key);
  }

  private setBatteryTrendBaseline(a: LoadedAutomation, key: string, entry: BatteryTrendEntry): void {
    let inner = this.batteryTrendState.get(a.id);
    if (!inner) { inner = new Map(); this.batteryTrendState.set(a.id, inner); }
    inner.set(key, entry);
    if (inner.size > BATTERY_TREND_STATE_MAX) this.pruneBatteryTrendState(a, inner);
  }

  private pruneBatteryTrendState(a: LoadedAutomation, inner: Map<string, BatteryTrendEntry>): void {
    if (inner.size <= BATTERY_TREND_STATE_TRIM_TO) return;
    // Eviction is behaviour-safe (see BATTERY_TREND_STATE_MAX doc): drop the
    // least-recently-seen entries — those nodes have most likely churned out of
    // the enumeration — and any live one just re-baselines on its next tick.
    const byAge = [...inner.entries()].sort((x, y) => x[1].ts - y[1].ts);
    const dropCount = byAge.length - BATTERY_TREND_STATE_TRIM_TO;
    for (let i = 0; i < dropCount; i++) inner.delete(byAge[i][0]);
    logger.debug(`[AutomationEngine] "${a.name}" battery-trend state trimmed to ${inner.size}`);
  }

  /**
   * Periodic battery-decline evaluation (#4558 Phase E) — the "solar node losing
   * battery / not charging" heuristic for `trigger.batteryTrend`.
   *
   * For every enabled batteryTrend automation, reads each tracked Meshtastic
   * node's `batteryLevel` history over the automation's OWN `windowHours` and
   * computes the drop from the window's oldest sample to its newest. A node is
   * "declining" when there are ≥ 2 samples AND `startLevel - latestLevel >=
   * minDropPercent` (percentage points) — the net fall over the window IS the
   * monotonic-ish requirement, so a node that dipped and recovered nets out below
   * threshold and does not fire.
   *
   *  - a node's FIRST sighting only ESTABLISHES a baseline (no fire). This is what
   *    makes a process restart NOT replay an alert for a node that was already
   *    declining — the real history lives in the DB and the latch re-seeds
   *    silently on the first tick;
   *  - not-declining → declining fires ONCE and latches the node alarmed;
   *  - declining → not-declining clears the latch (re-arm) without firing.
   *
   * HEURISTIC CAVEAT: the protocol has no charge-state field, so this is a
   * declining-battery PROXY, not a true "not charging" signal — it can
   * false-positive under heavy transient load and does not model day/night.
   *
   * BOTH protocols are covered (#4558 follow-up). Meshtastic nodes trend on
   * `batteryLevel` (%): the drop is `startLevel - latestLevel` in percentage
   * POINTS. MeshCore nodes have no % and no numeric node id, so they trend on
   * battery VOLTS keyed by pubkey (via {@link NodeDataProvider.getMeshCoreBatteryTrendSamples}),
   * and the drop is the RELATIVE decline `(startV - latestV) / startV * 100` so
   * the same `minDropPercent` threshold stays meaningful across both units.
   * Sends NO mesh packets; returns the number of automations that dispatched
   * this tick.
   */
  async runBatteryTrendCheck(): Promise<number> {
    const autos = this.index.get('trigger.batteryTrend') ?? [];
    if (autos.length === 0) return 0;
    if (!this.data.listNodesForStaleCheck) return 0;
    // Need at least one battery-sample provider; each protocol's nodes are
    // skipped individually below when its provider is absent.
    if (!this.data.getBatteryTrendSamples && !this.data.getMeshCoreBatteryTrendSamples) return 0;

    let candidates: StaleCandidate[];
    try {
      candidates = await this.data.listNodesForStaleCheck();
    } catch (e) {
      logger.error(`[AutomationEngine] battery-trend node enumeration failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }

    const now = this.now();
    let fired = 0;

    for (const a of autos) {
      const p = (a.triggerNode.params as Record<string, unknown>) ?? {};
      const windowHours = Number(p.windowHours);
      const minDropPercent = Number(p.minDropPercent);
      if (!Number.isFinite(windowHours) || windowHours <= 0) continue;
      if (!Number.isFinite(minDropPercent) || minDropPercent <= 0) continue;
      const sinceMs = now - windowHours * 3_600_000;

      for (const c of candidates) {
        const isMeshCore = c.nodeNum == null;
        const nodeNum = isMeshCore ? null : Number(c.nodeNum);
        const publicKey = isMeshCore ? (c.publicKey ?? null) : null;
        // MeshCore candidate with no pubkey is unaddressable; skip it.
        if (isMeshCore && !publicKey) continue;
        // Per-(source, node) baseline key: numeric node for Meshtastic, pubkey for MeshCore.
        const key = staleKeyFor(c);

        let samples: Array<{ timestamp: number; value: number }> | undefined;
        try {
          if (isMeshCore) {
            if (!this.data.getMeshCoreBatteryTrendSamples) continue; // no MeshCore provider → skip
            samples = await this.data.getMeshCoreBatteryTrendSamples(c.sourceId, publicKey as string, sinceMs);
          } else {
            if (!this.data.getBatteryTrendSamples) continue; // no Meshtastic provider → skip
            samples = await this.data.getBatteryTrendSamples(c.sourceId, nodeNum as number, sinceMs);
          }
        } catch {
          continue; // a per-node read failure must not abort the rest of the tick
        }
        // Need at least two readings in the window to describe a trend at all.
        if (!samples || samples.length < 2) continue;

        let earliest = samples[0];
        let latest = samples[0];
        for (const s of samples) {
          if (s.timestamp < earliest.timestamp) earliest = s;
          if (s.timestamp > latest.timestamp) latest = s;
        }
        const startLevel = earliest.value;
        const latestLevel = latest.value;
        // Meshtastic: battery %, absolute percentage-point drop. MeshCore: volts,
        // so use the RELATIVE decline against the start voltage — a 0/negative
        // start can't yield a meaningful percentage, so it never declines.
        const drop = isMeshCore
          ? (startLevel > 0 ? ((startLevel - latestLevel) / startLevel) * 100 : 0)
          : (startLevel - latestLevel);
        const declining = drop >= minDropPercent;

        const prev = this.getBatteryTrendBaseline(a, key);
        if (prev === undefined) {
          // First sighting after (re)start: baseline only, never a fire.
          this.setBatteryTrendBaseline(a, key, { alarmed: declining, ts: now });
          continue;
        }

        if (!prev.alarmed && declining) {
          // calm → declining. Latch alarmed FIRST so a suppressed fire can't re-fire.
          this.setBatteryTrendBaseline(a, key, { alarmed: true, ts: now });
          const ctx = buildBatteryTrendContext(
            nodeNum, publicKey, Math.round(drop), windowHours, minDropPercent, startLevel, latestLevel, c.sourceId, now,
          );
          fired += await this.fireStaleTransition(a, ctx, now);
        } else if (prev.alarmed && !declining) {
          // declining → recovered: re-arm, no fire.
          this.setBatteryTrendBaseline(a, key, { alarmed: false, ts: now });
        } else {
          // No transition — refresh the touched-timestamp for eviction ordering.
          this.setBatteryTrendBaseline(a, key, { alarmed: prev.alarmed, ts: now });
        }
      }
    }
    return fired;
  }

  /**
   * Drop in-memory left-home alarmed flags for one automation (e.g. after a
   * homes reset). Persisted anchors are managed by the caller / repository.
   */
  clearLeftHomeRuntimeState(automationId: string): void {
    this.leftHomeAlarmed.delete(automationId);
  }
}

/**
 * Per-(source, node) baseline key for the staleness maps. Meshtastic keys off the
 * numeric node number, MeshCore off the public key — matching {@link staleKeyFor}'s
 * counterpart in {@link AutomationEngineService.checkNodeOnline} for Meshtastic.
 */
function staleKeyFor(c: StaleCandidate): string {
  const nodeKey = c.nodeNum != null ? String(c.nodeNum) : (c.publicKey ?? '');
  return `${c.sourceId ?? ''}:${nodeKey}`;
}

/** EMA weight for leftHome anchor refinement (new fix vs existing home). */
const LEFT_HOME_REFINE_ALPHA = 0.25;

/** True when `nodeNums` (trigger param) includes `nodeNum`. Empty/missing → no match (v1 requires hand-select). */
function nodeNumsInclude(raw: unknown, nodeNum: number): boolean {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  const want = Number(nodeNum);
  return raw.some((x) => Number(x) === want);
}
