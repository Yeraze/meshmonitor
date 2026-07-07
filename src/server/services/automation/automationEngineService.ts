/**
 * Automation Engine service (#3653, §4) — the runtime orchestrator.
 *
 * Loads enabled automations, indexes them by trigger type, and on each mesh event
 * builds the trigger context, fast-fails on the trigger pre-filter, enforces a
 * per-automation cooldown, evaluates the graph (condition routing / collapse /
 * fanout / actions / setVar), and writes a run-log row.
 *
 * Phase 1a is synchronous: every run completes to `completed`/`failed`; the
 * `waiting` status and flow.delay arrive in 1b. Mesh IO is injected via ActionDeps
 * so the whole pipeline is testable without a live node.
 */
import { logger } from '../../../utils/logger.js';
import type { DbMessage } from '../../../services/database.js';
import type { AutomationsRepository } from '../../../db/repositories/automations.js';
import {
  validateAutomationGraph,
  categoryOf,
  type AutomationGraph,
  type AutomationNode,
  type TriggerType,
} from '../../../types/automation.js';
import { VariableResolver } from './variableResolver.js';
import {
  buildMessageContext,
  buildMeshCoreMessageContext,
  buildNodeContext,
  buildTelemetryContext,
  buildSystemContext,
  buildGeofenceContext,
  buildScheduleContext,
  messageMatchesFilter,
  meshCoreMessageMatchesFilter,
  describeMessageFilterMiss,
  describeMeshCoreFilterMiss,
  messageFilterUsesChannelName,
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
} from './engineContext.js';

interface LoadedAutomation {
  id: string;
  name: string;
  graph: AutomationGraph;
  triggerNode: AutomationNode;
  triggerType: TriggerType;
  cooldownSeconds: number;
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
  private readonly now: () => number;
  private readonly maxActions: number;
  private readonly cron: CronScheduler;

  /** triggerType → loaded automations. */
  private index = new Map<TriggerType, LoadedAutomation[]>();
  /** automationId → last fired ms (cooldown). */
  private lastFired = new Map<string, number>();
  /** `${automationId}:${nodeNum}` → was the node inside the geofence last check. */
  private geofenceState = new Map<string, boolean>();
  /** automationId → live cron job, for `trigger.schedule` automations. */
  private cronJobs = new Map<string, { stop: () => void }>();

  constructor(opts: EngineServiceOptions) {
    this.automationsRepo = opts.automationsRepo;
    this.vars = opts.varResolver;
    this.deps = opts.deps;
    this.data = opts.data;
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
      const entry: LoadedAutomation = {
        id: row.id, name: row.name, graph: result.graph, triggerNode, triggerType, cooldownSeconds,
      };
      if (!index.has(triggerType)) index.set(triggerType, []);
      index.get(triggerType)!.push(entry);
    }
    this.index = index;
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
    if (!this.cooledDown(a, now)) {
      if (traced) {
        const remainingMs = Math.max(0, a.cooldownSeconds * 1000 - (now - (this.lastFired.get(a.id) ?? 0)));
        this.emitTrace(a, ctx, now, { outcome: 'cooldown', reason: `cooldown active — ${Math.ceil(remainingMs / 1000)}s remaining` });
      }
      return 0;
    }
    this.lastFired.set(a.id, now);
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

  private cooledDown(a: LoadedAutomation, now: number): boolean {
    if (a.cooldownSeconds <= 0) return true;
    const last = this.lastFired.get(a.id);
    return last == null || now - last >= a.cooldownSeconds * 1000;
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
      if (!this.cooledDown(a, now)) {
        if (traced) {
          const remainingMs = Math.max(0, a.cooldownSeconds * 1000 - (now - (this.lastFired.get(a.id) ?? 0)));
          this.emitTrace(a, ctx, now, { outcome: 'cooldown', reason: `cooldown active — ${Math.ceil(remainingMs / 1000)}s remaining` });
        }
        continue;
      }
      this.lastFired.set(a.id, now);
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

  /** True if `fromNodeNum` is this Meshtastic source's own local node. */
  private async isSelfMeshtastic(sourceId: string | null, fromNodeNum: number | null | undefined): Promise<boolean> {
    if (!this.data.getLocalNodeNum || fromNodeNum == null) return false;
    const local = await this.data.getLocalNodeNum(sourceId);
    return local != null && Number(local) === Number(fromNodeNum);
  }

  /** True if `fromPublicKey` is this MeshCore source's own local node key. */
  private async isSelfMeshCore(sourceId: string | null, fromPublicKey: string | null | undefined): Promise<boolean> {
    if (!this.data.getSelfPublicKey || !fromPublicKey) return false;
    const key = await this.data.getSelfPublicKey(sourceId);
    return key != null && key.toLowerCase() === fromPublicKey.toLowerCase();
  }

  // ─── event entry points ─────────────────────────────────────────────────

  async onMessage(msg: DbMessage, sourceId: string | null): Promise<number> {
    if (await this.isSelfMeshtastic(sourceId, msg.fromNodeNum)) return 0; // #3914: ignore our own sends
    const ctx = buildMessageContext(msg, sourceId, this.now());
    // Resolve the message's channel NAME once (per-source slot→name), but only
    // when a loaded message automation actually filters by channelName — keeps
    // the hot path DB-free when nobody uses name matching.
    let channelName: string | null | undefined;
    const usesChannelName = (this.index.get('trigger.message') ?? []).some((a) => {
      const p = a.triggerNode.params as Record<string, unknown> | undefined;
      return messageFilterUsesChannelName(p ?? {});
    });
    if (usesChannelName && this.data.getChannelName) {
      channelName = await this.data.getChannelName(sourceId, Number(msg.channel));
    }
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
    const ctx = buildMeshCoreMessageContext(msg, sourceId, this.now());
    let channelName: string | null | undefined;
    const usesChannelName = (this.index.get('trigger.message') ?? []).some((a) => {
      const p = a.triggerNode.params as Record<string, unknown> | undefined;
      return messageFilterUsesChannelName(p ?? {});
    });
    // A received channel message stores its slot index in `from` as `channel-<idx>`.
    const channelIdx = ctx.fields.channel;
    if (usesChannelName && this.data.getChannelName && typeof channelIdx === 'number') {
      channelName = await this.data.getChannelName(sourceId, channelIdx);
    }
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
      const key = `${a.id}:${nodeNum}`;
      const prev = this.geofenceState.get(key);
      this.geofenceState.set(key, inside);

      const traced = automationTraceBus.activeCount() > 0 && automationTraceBus.isTracing(a.id, now);
      const geoCtx = buildGeofenceContext(nodeNum, mode, node.latitude, node.longitude, distanceKm, sourceId, now);

      if (!geofenceFires(prev, inside, mode)) {
        if (traced) this.emitTrace(a, geoCtx, now, { outcome: 'prefiltered', reason: prev === undefined ? 'first sighting — baseline only' : `no ${mode} transition (node ${inside ? 'inside' : 'outside'})` });
        continue;
      }
      if (!this.cooledDown(a, now)) {
        if (traced) {
          const remainingMs = Math.max(0, a.cooldownSeconds * 1000 - (now - (this.lastFired.get(a.id) ?? 0)));
          this.emitTrace(a, geoCtx, now, { outcome: 'cooldown', reason: `cooldown active — ${Math.ceil(remainingMs / 1000)}s remaining` });
        }
        continue;
      }
      this.lastFired.set(a.id, now);
      fired++;
      const fr = await this.fireAutomation(a, geoCtx, now);
      if (traced) this.emitTrace(a, geoCtx, now, { outcome: 'fired', status: fr.status, conditionResults: fr.conditionResults, actions: fr.actions, steps: fr.steps });
    }
    return fired;
  }
}
