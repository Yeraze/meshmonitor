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
  messageMatchesFilter,
  type TriggerContext,
} from './triggerContext.js';
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
}

export class AutomationEngineService {
  private readonly automationsRepo: AutomationsRepository;
  private readonly vars: VariableResolver;
  private readonly deps: ActionDeps;
  private readonly data: NodeDataProvider;
  private readonly now: () => number;
  private readonly maxActions: number;

  /** triggerType → loaded automations. */
  private index = new Map<TriggerType, LoadedAutomation[]>();
  /** automationId → last fired ms (cooldown). */
  private lastFired = new Map<string, number>();

  constructor(opts: EngineServiceOptions) {
    this.automationsRepo = opts.automationsRepo;
    this.vars = opts.varResolver;
    this.deps = opts.deps;
    this.data = opts.data;
    this.now = opts.now ?? (() => Date.now());
    this.maxActions = opts.maxActions ?? 50;
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
    logger.info(`[AutomationEngine] loaded ${rows.length} enabled automation(s)`);
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
    return fired;
  }

  // ─── event entry points ─────────────────────────────────────────────────

  async onMessage(msg: DbMessage, sourceId: string | null): Promise<number> {
    const ctx = buildMessageContext(msg, sourceId, this.now());
    return this.runTrigger(ctx, (a) => messageMatchesFilter(msg, a.triggerNode.params ?? {}));
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
    event: 'bootup' | 'source-connected' | 'source-disconnected',
    sourceId: string | null,
    nodeNum: number | null,
    reason?: string,
  ): Promise<number> {
    return this.runTrigger(buildSystemContext(event, sourceId, nodeNum, reason, this.now()));
  }
}
