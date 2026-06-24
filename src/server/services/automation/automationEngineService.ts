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
  buildNodeContext,
  buildTelemetryContext,
  buildSystemContext,
  buildGeofenceContext,
  buildScheduleContext,
  messageMatchesFilter,
  type TriggerContext,
  type SystemEvent,
} from './triggerContext.js';
import { scheduleCron, validateCron } from '../../utils/cronScheduler.js';
import { haversineKm, geofenceFires, pointInShape, geofenceCenter, normalizeGeofenceParams, type GeofenceMode } from './geo.js';
import { evaluateGraph, type EvaluatorHooks } from './graphEvaluator.js';
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
    if (!this.cooledDown(a, now)) return 0;
    this.lastFired.set(a.id, now);
    await this.fireAutomation(a, buildScheduleContext(null, now), now);
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
   */
  private async runTrigger(ctx: TriggerContext, prefilter?: (a: LoadedAutomation) => boolean): Promise<number> {
    const entries = this.index.get(ctx.triggerType);
    if (!entries || entries.length === 0) return 0;
    const now = this.now();
    let fired = 0;
    for (const a of entries) {
      if (prefilter && !prefilter(a)) continue;
      if (!this.cooledDown(a, now)) continue;
      this.lastFired.set(a.id, now);
      fired++;
      await this.fireAutomation(a, ctx, now);
    }
    return fired;
  }

  /** Evaluate one automation's graph against a trigger context and write a run-log row. */
  private async fireAutomation(a: LoadedAutomation, ctx: TriggerContext, now: number): Promise<void> {
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
    } catch (e: any) {
      logger.error(`[AutomationEngine] automation "${a.name}" threw: ${e?.message}`);
      await this.automationsRepo.createRun({
        automationId: a.id,
        sourceId: ctx.sourceId,
        status: 'failed',
        triggerEvent: JSON.stringify(ctx.fields),
        log: JSON.stringify([{ outcome: 'engine:error', error: e?.message }]),
      });
    }
  }

  // ─── event entry points ─────────────────────────────────────────────────

  async onMessage(msg: DbMessage, sourceId: string | null): Promise<number> {
    const ctx = buildMessageContext(msg, sourceId, this.now());
    // Resolve the message's channel NAME once (per-source slot→name), but only
    // when a loaded message automation actually filters by channelName — keeps
    // the hot path DB-free when nobody uses name matching.
    let channelName: string | null | undefined;
    const usesChannelName = (this.index.get('trigger.message') ?? []).some((a) => {
      const p = a.triggerNode.params as Record<string, unknown> | undefined;
      return typeof p?.channelName === 'string' && p.channelName.length > 0;
    });
    if (usesChannelName && this.data.getChannelName) {
      channelName = await this.data.getChannelName(sourceId, Number(msg.channel));
    }
    return this.runTrigger(ctx, (a) => messageMatchesFilter(msg, a.triggerNode.params ?? {}, channelName));
  }

  async onNode(
    kind: 'trigger.nodeDiscovered' | 'trigger.nodeUpdated',
    nodeNum: number,
    changedKeys: string[],
    sourceId: string | null,
  ): Promise<number> {
    return this.runTrigger(buildNodeContext(kind, nodeNum, changedKeys, sourceId, this.now()));
  }

  async onTelemetry(
    nodeNum: number,
    telemetryType: string,
    value: number,
    unit: string | undefined,
    sourceId: string | null,
  ): Promise<number> {
    const ctx = buildTelemetryContext(nodeNum, telemetryType, value, unit, sourceId, this.now());
    return this.runTrigger(ctx, (a) => {
      const want = (a.triggerNode.params as any)?.telemetryType;
      return want == null || want === telemetryType;
    });
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
    return this.runTrigger(ctx, (a) => {
      const want = (a.triggerNode.params as any)?.event;
      return want == null || want === '' || want === event;
    });
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

      if (!geofenceFires(prev, inside, mode)) continue;
      if (!this.cooledDown(a, now)) continue;
      this.lastFired.set(a.id, now);
      fired++;
      await this.fireAutomation(a, buildGeofenceContext(nodeNum, mode, node.latitude, node.longitude, distanceKm, sourceId, now), now);
    }
    return fired;
  }
}
