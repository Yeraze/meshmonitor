/**
 * Automation simulator (#3653) — dry-run evaluation behind the in-app "Test"
 * feature and the no-hardware system tests.
 *
 * Runs a (validated) automation graph against a user-supplied synthetic trigger
 * event, with:
 *   - a recording ActionDeps (no message sent / node touched / Apprise POST) —
 *     each action returns its fully-resolved params instead of doing IO;
 *   - a stub NodeDataProvider that overlays caller-supplied node facts + latest
 *     telemetry on top of the live DB (so node and telemetry conditions resolve);
 *   - a recording VariableResolver that reads through to real stored values (with
 *     optional overrides) but records writes instead of persisting them.
 *
 * It returns the full execution trace (trigger match, per-condition verdicts,
 * branch routing, resolved action params, simulated variable writes) and writes
 * NO run-log row. The live event-bus path (automationEngineService) is untouched.
 */
import {
  categoryOf,
  type AutomationGraph,
  type AutomationNode,
} from '../../../types/automation.js';
import type { DbMessage } from '../../../services/database.js';
import type { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver, type VarContext, type SetResult } from './variableResolver.js';
import type { DecodedValue } from './variableCodec.js';
import { evaluateGraph } from './graphEvaluator.js';
import { evaluateCondition } from './conditionEvaluator.js';
import { executeAction, type ActionDeps } from './actionExecutor.js';
import {
  buildMessageContext,
  buildNodeContext,
  buildTelemetryContext,
  buildSystemContext,
  buildGeofenceContext,
  messageMatchesFilter,
  BROADCAST_ADDR,
  type TriggerContext,
  type SystemEvent,
} from './triggerContext.js';
import { haversineKm, type GeofenceMode } from './geo.js';
import {
  varContextFromTrigger,
  resolveOperand,
  type EngineEvalContext,
  type NodeDataProvider,
  type NodeFacts,
} from './engineContext.js';

export type SimEventKind =
  | 'message' | 'nodeUpdated' | 'nodeDiscovered' | 'telemetry' | 'system' | 'geofence';

/** Synthetic trigger event the caller fills in (Test form / system test). */
export interface SimEventInput {
  kind: SimEventKind;
  sourceId?: string | null;
  // message
  text?: string;
  from?: number;
  to?: number;
  channel?: number;
  portnum?: number;
  packetId?: number;
  hopStart?: number;
  hopLimit?: number;
  snr?: number;
  rssi?: number;
  viaMqtt?: boolean;
  // node
  nodeNum?: number;
  changed?: string[];
  // telemetry
  telemetryType?: string;
  value?: number;
  unit?: string;
  // system
  event?: string;
  reason?: string;
  latestVersion?: string;
  currentVersion?: string;
}

export interface SimResult {
  matched: boolean;
  status: 'completed' | 'failed' | 'skipped';
  triggerType: string;
  fields: Record<string, unknown>;
  conditionResults: Record<string, boolean>;
  actions: Array<{ nodeId: string; type: string; ok: boolean; resolvedParams?: unknown; error?: string }>;
  variableWrites: Array<{ name: string; op: string; value?: unknown }>;
  steps: Array<{ nodeId: string; type: string; outcome: string; error?: string }>;
}

export interface SimulateOptions {
  graph: AutomationGraph;
  event: SimEventInput;
  /** Subject-node fact overrides (battery, role, name, position…). */
  node?: Partial<NodeFacts>;
  /** Latest-telemetry overrides keyed by metric (e.g. { temperature: 31 }). */
  telemetry?: Record<string, number>;
  /** Variable value overrides keyed by variable name. */
  variables?: Record<string, unknown>;
  varsRepo: AutomationVariablesRepository;
  /** Live data provider read through for any field the caller didn't override. */
  liveData?: NodeDataProvider;
  now?: number;
  maxActions?: number;
}

/** ActionDeps that perform no IO — each call resolves to its received params. */
function recordingDeps(): ActionDeps {
  return {
    async sendMessage(a) { return { action: 'sendMessage', ...a }; },
    async sendTapback(a) { return { action: 'tapback', ...a }; },
    async manageNode(a) { return { action: 'nodeManage', ...a }; },
    async notify(a) { return { action: 'notify', ...a }; },
  };
}

/** Overlay caller-supplied node facts / telemetry on top of the live provider. */
function stubData(
  node: Partial<NodeFacts> | undefined,
  telemetry: Record<string, number> | undefined,
  live: NodeDataProvider | undefined,
): NodeDataProvider {
  return {
    async getNode(sourceId, nodeNum) {
      const liveNode = live ? await live.getNode(sourceId, nodeNum).catch(() => null) : null;
      if (!node) return liveNode;
      return { nodeNum, ...(liveNode ?? {}), ...node } as NodeFacts;
    },
    async getTelemetry(sourceId, nodeNum, type) {
      if (telemetry && Object.prototype.hasOwnProperty.call(telemetry, type)) {
        return Number(telemetry[type]);
      }
      return live ? live.getTelemetry(sourceId, nodeNum, type).catch(() => null) : null;
    },
  };
}

/** VariableResolver that reads real values (with overrides) but records writes. */
class SimVariableResolver extends VariableResolver {
  public readonly writes: Array<{ name: string; op: string; value?: unknown }> = [];
  constructor(repo: AutomationVariablesRepository, private readonly overrides: Record<string, unknown> = {}) {
    super(repo);
  }
  async getValue(name: string, ctx: VarContext, now: number = Date.now()): Promise<DecodedValue> {
    if (Object.prototype.hasOwnProperty.call(this.overrides, name)) {
      const v = this.overrides[name];
      return (v == null ? null : v) as DecodedValue;
    }
    return super.getValue(name, ctx, now);
  }
  async setValue(name: string, value: unknown): Promise<SetResult> { this.writes.push({ name, op: 'set', value }); return { ok: true }; }
  async setFlag(name: string): Promise<SetResult> { this.writes.push({ name, op: 'flag' }); return { ok: true }; }
  async clearFlag(name: string): Promise<SetResult> { this.writes.push({ name, op: 'clear' }); return { ok: true }; }
  async increment(name: string, delta: number): Promise<SetResult> { this.writes.push({ name, op: 'increment', value: delta }); return { ok: true }; }
}

/** Mirror of the engine's flow.setVar handling, routed through the sim resolver. */
async function simApplySetVar(node: AutomationNode, ctx: EngineEvalContext): Promise<void> {
  const p = (node.params ?? {}) as Record<string, unknown>;
  const name = String(p.variable ?? '');
  if (!name) return;
  const op = String(p.op ?? 'set');
  if (op === 'clear') { await ctx.vars.clearFlag(name, ctx.varCtx); return; }
  if (op === 'flag') { await ctx.vars.setFlag(name, ctx.varCtx, ctx.now); return; }
  if (op === 'increment') {
    const delta = Number(await resolveOperand(ctx, p.value ?? 1)) || 1;
    await ctx.vars.increment(name, delta, ctx.varCtx, ctx.now);
    return;
  }
  const value = await resolveOperand(ctx, p.value);
  await ctx.vars.setValue(name, value, ctx.varCtx, ctx.now);
}

/** Build a synthetic DbMessage from a message sim-event. */
function synthMessage(ev: SimEventInput, sourceId: string | null): DbMessage {
  const from = Number(ev.from ?? 0);
  const to = Number(ev.to ?? BROADCAST_ADDR);
  const packetId = Number(ev.packetId ?? 1);
  return {
    id: `${sourceId ?? 'default'}_${from}_${packetId}`,
    fromNodeNum: from,
    toNodeNum: to,
    fromNodeId: `!${(from >>> 0).toString(16).padStart(8, '0')}`,
    toNodeId: to === BROADCAST_ADDR ? '!ffffffff' : `!${(to >>> 0).toString(16).padStart(8, '0')}`,
    text: ev.text ?? '',
    channel: Number(ev.channel ?? 0),
    portnum: Number(ev.portnum ?? 1),
    hopStart: ev.hopStart,
    hopLimit: ev.hopLimit,
    rxSnr: ev.snr,
    rxRssi: ev.rssi,
    viaMqtt: ev.viaMqtt,
    timestamp: 0,
    createdAt: 0,
  } as unknown as DbMessage;
}

interface BuiltContext { ctx: TriggerContext; matched: boolean; }

/** Build the trigger context + prefilter verdict for the given sim event. */
function buildContext(graph: AutomationGraph, ev: SimEventInput, node: Partial<NodeFacts> | undefined, now: number): BuiltContext {
  const sourceId = ev.sourceId ?? 'default';
  const triggerNode = graph.nodes.find((n) => categoryOf(n.type) === 'trigger');
  const params = (triggerNode?.params ?? {}) as Record<string, unknown>;

  switch (ev.kind) {
    case 'message': {
      const msg = synthMessage(ev, sourceId);
      return { ctx: buildMessageContext(msg, sourceId, now), matched: messageMatchesFilter(msg, params) };
    }
    case 'nodeDiscovered':
    case 'nodeUpdated': {
      const kind = ev.kind === 'nodeDiscovered' ? 'trigger.nodeDiscovered' : 'trigger.nodeUpdated';
      return { ctx: buildNodeContext(kind, Number(ev.nodeNum ?? 0), ev.changed ?? [], sourceId, now), matched: true };
    }
    case 'telemetry': {
      const type = String(ev.telemetryType ?? '');
      const want = params.telemetryType;
      const matched = want == null || want === '' || want === type;
      return { ctx: buildTelemetryContext(Number(ev.nodeNum ?? 0), type, Number(ev.value ?? 0), ev.unit, sourceId, now), matched };
    }
    case 'system': {
      const event = String(ev.event ?? 'bootup') as SystemEvent;
      const want = params.event;
      const matched = want == null || want === '' || want === event;
      const extra = { latestVersion: ev.latestVersion, currentVersion: ev.currentVersion };
      return { ctx: buildSystemContext(event, sourceId, ev.nodeNum ?? null, ev.reason, now, extra), matched };
    }
    case 'geofence': {
      const mode = (String(params.event ?? 'enter') as GeofenceMode);
      const lat = Number(node?.latitude ?? 0);
      const lon = Number(node?.longitude ?? 0);
      const distanceKm = haversineKm(lat, lon, Number(params.lat), Number(params.lon));
      // Preview: assume the configured crossing occurred; conditions still run
      // against the supplied position. matched=true so the trace is informative.
      return { ctx: buildGeofenceContext(Number(ev.nodeNum ?? 0), mode, lat, lon, distanceKm, sourceId, now), matched: true };
    }
    default:
      return { ctx: buildSystemContext('bootup', sourceId, null, undefined, now), matched: false };
  }
}

/**
 * Dry-run an automation graph against a synthetic event and return the full trace.
 * Performs no IO and writes no run-log row.
 */
export async function simulateAutomation(opts: SimulateOptions): Promise<SimResult> {
  const now = opts.now ?? Date.now();
  const { ctx, matched } = buildContext(opts.graph, opts.event, opts.node, now);
  const typeById = new Map(opts.graph.nodes.map((n) => [n.id, n.type as string]));

  if (!matched) {
    return {
      matched: false, status: 'skipped', triggerType: ctx.triggerType, fields: ctx.fields,
      conditionResults: {}, actions: [], variableWrites: [], steps: [],
    };
  }

  const deps = recordingDeps();
  const vars = new SimVariableResolver(opts.varsRepo, opts.variables ?? {});
  const data = stubData(opts.node, opts.telemetry, opts.liveData);
  const evalCtx: EngineEvalContext = { trigger: ctx, vars, data, varCtx: varContextFromTrigger(ctx), now };

  const result = await evaluateGraph(opts.graph, evalCtx, {
    evaluateCondition: (n, c) => evaluateCondition(n, c),
    executeAction: (n, c) => executeAction(n, c, deps),
    applySetVar: (n, c) => simApplySetVar(n, c),
  }, { maxActions: opts.maxActions });

  const status = result.actions.some((a) => !a.ok) ? 'failed' : 'completed';
  return {
    matched: true,
    status,
    triggerType: ctx.triggerType,
    fields: ctx.fields,
    conditionResults: result.conditionResults,
    actions: result.actions.map((a) => ({
      nodeId: a.nodeId, type: typeById.get(a.nodeId) ?? '', ok: a.ok, resolvedParams: a.value, error: a.error,
    })),
    variableWrites: vars.writes,
    steps: result.steps,
  };
}
