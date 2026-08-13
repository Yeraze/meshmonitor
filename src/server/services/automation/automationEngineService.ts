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
import type { AutomationsRepository } from '../../../db/repositories/automations.js';
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
  buildNodeContext,
  buildTelemetryContext,
  buildMeshBeaconContext,
  buildSystemContext,
  buildGeofenceContext,
  buildBecameMobileContext,
  buildLeftHomeContext,
  buildScheduleContext,
  messageMatchesFilter,
  meshCoreMessageMatchesFilter,
  describeMessageFilterMiss,
  describeMeshCoreFilterMiss,
  parseMeshCoreChannelIdx,
  type TriggerContext,
  type SystemEvent,
} from './triggerContext.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';
import { scheduleCron, validateCron } from '../../utils/cronScheduler.js';
import { haversineKm, geofenceFires, pointInShape, geofenceCenter, normalizeGeofenceParams, type GeofenceMode } from './geo.js';
import { evaluateGraph, type EvaluatorHooks } from './graphEvaluator.js';
import { automationTraceBus } from './automationTraceBus.js';
import { evaluateCondition } from './conditionEvaluator.js';
import { executeAction, type ActionDeps } from './actionExecutor.js';
import {
  type EngineEvalContext,
  type NodeDataProvider,
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
  async load(): Promise<void> {
    const rows = await this.automationsRepo.listEnabledAutomations();
    const index = new Map<TriggerType, LoadedAutomation[]>();
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.config);
      } catch {
        logger.warn(`[AutomationEngine] automation "${row.name}" has unparseable config; skipping`);
        continue;
      }
      const result = validateAutomationGraph(parsed);
      if (!result.valid || !result.graph) {
        logger.warn(`[AutomationEngine] automation "${row.name}" is invalid; skipping: ${result.errors.join('; ')}`);
        continue;
      }
      const triggerNode = result.graph.nodes.find((n) => categoryOf(n.type) === 'trigger');
      if (!triggerNode) continue;
      const triggerType = triggerNode.type as TriggerType;
      const cooldownSeconds = Number((triggerNode.params as any)?.cooldownSeconds ?? 0) || 0;
      // No `as any` needed: params is Record<string, unknown> and parseCooldownScope
      // takes unknown. (The cooldownSeconds line above predates the lint ratchet.)
      const cooldownScope = parseCooldownScope(triggerNode.params?.cooldownScope);
      // No `as any` needed: params is Record<string, unknown> and parseRateLimit
      // takes unknown (same reasoning as the parseCooldownScope line above).
      const rateLimit = parseRateLimit(triggerNode.params?.rateLimit);
      const entry: LoadedAutomation = {
        id: row.id, name: row.name, graph: result.graph, triggerNode, triggerType, cooldownSeconds, cooldownScope, rateLimit,
      };
      if (!index.has(triggerType)) index.set(triggerType, []);
      index.get(triggerType)!.push(entry);
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

  /** Stop all cron jobs (clean shutdown / test teardown). */
  stop(): void {
    for (const job of this.cronJobs.values()) job.stop();
    this.cronJobs.clear();
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

  // ─── event entry points ─────────────────────────────────────────────────

  async onMessage(msg: DbMessage, sourceId: string | null): Promise<number> {
    if (await this.isSelfMeshtastic(sourceId, msg.fromNodeNum)) return 0; // #3914: ignore our own sends
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
      (a) => messageMatchesFilter(msg, a.triggerNode.params ?? {}, channelName),
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
    if (await this.isSelfMeshCore(sourceId, msg.fromPublicKey)) return 0; // #3914: ignore our own sends
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
      (a) => meshCoreMessageMatchesFilter(msg, a.triggerNode.params ?? {}, channelName),
      (a) => describeMeshCoreFilterMiss(msg, a.triggerNode.params ?? {}, channelName),
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
      const shape = normalizeGeofenceParams(p);
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

  /**
   * Drop in-memory left-home alarmed flags for one automation (e.g. after a
   * homes reset). Persisted anchors are managed by the caller / repository.
   */
  clearLeftHomeRuntimeState(automationId: string): void {
    this.leftHomeAlarmed.delete(automationId);
  }
}

/** EMA weight for leftHome anchor refinement (new fix vs existing home). */
const LEFT_HOME_REFINE_ALPHA = 0.25;

/** True when `nodeNums` (trigger param) includes `nodeNum`. Empty/missing → no match (v1 requires hand-select). */
function nodeNumsInclude(raw: unknown, nodeNum: number): boolean {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  const want = Number(nodeNum);
  return raw.some((x) => Number(x) === want);
}
