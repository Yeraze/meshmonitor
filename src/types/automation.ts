/**
 * Shared Automation Engine types + graph validation (#3653).
 *
 * Canonical, framework-free definitions shared by the backend engine/routes and
 * the frontend builder. The graph is a directed acyclic graph of trigger /
 * condition / action / flow nodes (see AUTOMATION_ENGINE_PLAN §3.1).
 *
 * Validation is a small hand-written pass (the project carries no schema-
 * validation dependency); it returns structured errors suitable for surfacing in
 * the import UI.
 */

import { HOP_LIMIT_OVERRIDE_MAX, parseHopLimitOverride } from '../utils/hopLimitOverride.js';
import { isMeshCoreAdvertMode } from './meshcoreAdvert.js';

export const AUTOMATION_CONFIG_VERSION = 1;

// ─── Block type catalog ──────────────────────────────────────────────────────

export type TriggerType =
  | 'trigger.message'
  | 'trigger.nodeDiscovered'
  | 'trigger.nodeUpdated'
  | 'trigger.telemetry'
  | 'trigger.schedule'
  | 'trigger.system'
  | 'trigger.geofence'
  | 'trigger.becameMobile'
  | 'trigger.leftHome'
  | 'trigger.meshBeacon'
  | 'trigger.nodeStale'
  | 'trigger.nodeOnline'
  | 'trigger.nodeRebooted'
  | 'trigger.nodePowerChanged'
  | 'trigger.batteryTrend'
  | 'trigger.becameLikelyAircraft';

export type ConditionType =
  | 'condition.always'
  | 'condition.sourceFilter'
  | 'condition.numeric'
  | 'condition.string'
  | 'condition.distance'
  | 'condition.timeRange'
  | 'condition.variable'
  | 'condition.logical'
  | 'condition.meshcoreScope';

export type ActionType =
  | 'action.nothing'
  | 'action.sendMessage'
  | 'action.tapback'
  | 'action.nodeManage'
  | 'action.requestData'
  | 'action.deviceReboot'
  | 'action.notify'
  | 'action.runScript'
  | 'action.delay'
  | 'action.setAutomationEnabled'
  | 'action.setSourceForwardingEnabled'
  | 'action.broadcastWaypoint';

// `action.delay` is a BOUNDED, in-process pause (caps at AUTOMATION_DELAY_MAX_SECONDS)
// that blocks only its own run — it serializes naturally with the sequential,
// awaited action executor. A DURABLE wait that survives a restart (the original
// "flow.delay" Phase-1b idea) is still deferred; this is deliberately not that.
export const AUTOMATION_DELAY_MAX_SECONDS = 300;

export type FlowType = 'flow.fanout' | 'flow.collapse' | 'flow.setVar';

export type AutomationNodeType = TriggerType | ConditionType | ActionType | FlowType;

export type BlockCategory = 'trigger' | 'condition' | 'action' | 'flow';

export const TRIGGER_TYPES: readonly TriggerType[] = [
  'trigger.message',
  'trigger.nodeDiscovered',
  'trigger.nodeUpdated',
  'trigger.telemetry',
  'trigger.schedule',
  'trigger.system',
  'trigger.geofence',
  'trigger.becameMobile',
  'trigger.leftHome',
  'trigger.meshBeacon',
  'trigger.nodeStale',
  'trigger.nodeOnline',
  'trigger.nodeRebooted',
  'trigger.nodePowerChanged',
  'trigger.batteryTrend',
  'trigger.becameLikelyAircraft',
];

export const CONDITION_TYPES: readonly ConditionType[] = [
  'condition.always',
  'condition.sourceFilter',
  'condition.numeric',
  'condition.string',
  'condition.distance',
  'condition.timeRange',
  'condition.variable',
  'condition.logical',
  'condition.meshcoreScope',
];

export const ACTION_TYPES: readonly ActionType[] = [
  'action.nothing',
  'action.sendMessage',
  'action.tapback',
  'action.nodeManage',
  'action.requestData',
  'action.deviceReboot',
  'action.notify',
  'action.runScript',
  'action.delay',
  'action.setAutomationEnabled',
  'action.setSourceForwardingEnabled',
  'action.broadcastWaypoint',
];

export const FLOW_TYPES: readonly FlowType[] = ['flow.fanout', 'flow.collapse', 'flow.setVar'];

export const ALL_NODE_TYPES: readonly AutomationNodeType[] = [
  ...TRIGGER_TYPES,
  ...CONDITION_TYPES,
  ...ACTION_TYPES,
  ...FLOW_TYPES,
];

export function categoryOf(type: AutomationNodeType): BlockCategory {
  if (type.startsWith('trigger.')) return 'trigger';
  if (type.startsWith('condition.')) return 'condition';
  if (type.startsWith('action.')) return 'action';
  return 'flow';
}

export const COLLAPSE_MODES = ['ANY', 'ALL', 'NONE', 'ALWAYS'] as const;
export type CollapseMode = (typeof COLLAPSE_MODES)[number];

export const NUMERIC_OPS = ['>', '<', '>=', '<=', '==', '!='] as const;
export type NumericOp = (typeof NUMERIC_OPS)[number];

/** Node operations an `action.requestData` can ask for (#3835). */
export const REQUEST_OPS = ['telemetry', 'position', 'traceroute', 'nodeinfo', 'neighbors', 'advert'] as const;
export type RequestOp = (typeof REQUEST_OPS)[number];

/** Where action.tapback's emoji comes from. Absent = 'fixed' (pre-4.14 behaviour). */
export type TapbackEmojiMode = 'fixed' | 'hopCount';
export const TAPBACK_EMOJI_MODES: readonly TapbackEmojiMode[] = ['fixed', 'hopCount'];

/**
 * How action.setAutomationEnabled changes its target (#5445). Absent = 'set'.
 *  - 'set'     force the target to `params.enabled`.
 *  - 'toggle'  flip the target's current state; `params.enabled` is ignored.
 */
export type AutomationEnableMode = 'set' | 'toggle';
export const AUTOMATION_ENABLE_MODES: readonly AutomationEnableMode[] = ['set', 'toggle'];

/**
 * Coerce action.setAutomationEnabled's `enabled` param (#5445). The builder
 * stores 'true'/'false' strings and a `{{ }}` template resolves to a string, so
 * both a boolean and its string spelling (any case, trimmed; also '1'/'0') are
 * accepted. Anything else returns undefined so the caller can fail loudly
 * rather than guess.
 */
export function parseAutomationEnabledFlag(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1 ? true : raw === 0 ? false : undefined;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
}

/**
 * What a trigger's `cooldownSeconds` window is keyed by (#4340 Phase 2).
 *
 *  - 'automation'  one timer for the whole rule — the pre-4.14 behaviour and
 *                  what an ABSENT/unrecognised value means. Never change this.
 *  - 'node'        one timer per subject node (message sender / telemetry or
 *                  geofence node), so acking one range-tester does not suppress
 *                  the ack to the next one.
 *  - 'sourceNode'  one timer per (source, node), so the same physical node heard
 *                  via two sources cools down independently.
 *
 * Key shapes mirror AutomationVariablesRepository.buildScopeKey exactly
 * ('' / '<node>' / '<source>:<node>') so cooldown keys and variable scope keys
 * read identically in logs and traces.
 */
export const COOLDOWN_SCOPES = ['automation', 'node', 'sourceNode'] as const;
export type CooldownScope = (typeof COOLDOWN_SCOPES)[number];

/**
 * Coerce a stored `params.cooldownScope` to a CooldownScope. Absent, blank, or
 * unrecognised → 'automation'. Deliberately lenient at RUNTIME (graphs written
 * before validation existed must still run) while validateAutomationGraph
 * rejects unrecognised values at SAVE time — the same split Phase 1 used for
 * action.tapback's emojiMode.
 */
export function parseCooldownScope(raw: unknown): CooldownScope {
  return COOLDOWN_SCOPES.includes(raw as CooldownScope) ? (raw as CooldownScope) : 'automation';
}

/**
 * App-level DM resend cap for `action.sendMessage` (#4340 Phase 3).
 *
 * Mirrors MessageQueueService's own bound (src/server/messageQueueService.ts:
 * 75-85, `Math.min(3, Math.max(1, …))`, #4266) — an unbounded value would let an
 * automation be abused as a repeat-broadcast mechanism. The duplication is
 * deliberate: this module must stay dependency-free (the frontend imports it),
 * and the queue's clamp is load-bearing for #4266 and must not be refactored
 * from here. autoAckParity.test.ts pins the two to the same numbers.
 */
export const SEND_MAX_ATTEMPTS_MIN = 1;
export const SEND_MAX_ATTEMPTS_MAX = 3;

/**
 * Coerce a stored `params.maxAttempts` to an integer in [1,3], or `undefined`
 * for absent / blank / unparseable — `undefined` means "one direct send", the
 * pre-4.14 behaviour every stored automation depends on. Lenient at RUNTIME
 * while validateAutomationGraph rejects an out-of-range value at SAVE time —
 * the same split Phase 1 used for emojiMode and Phase 2 for cooldownScope.
 */
export function parseSendMaxAttempts(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) return undefined;
  return Math.min(SEND_MAX_ATTEMPTS_MAX, Math.max(SEND_MAX_ATTEMPTS_MIN, n));
}

/**
 * Validate an optional `params.hopLimit` on action.sendMessage / action.tapback
 * (#5121). Absent / blank / 'inherit' is always valid and means "use the node's
 * own hop limit" — every pre-existing stored automation relies on that. A set
 * value must be an integer 0–7; the send path additionally caps it at the
 * node's configured hop limit (see src/utils/hopLimitOverride.ts).
 */
function hopLimitParamError(nodeType: string, nodeId: string, raw: unknown): string | null {
  if (raw == null || raw === '' || raw === 'inherit') return null;
  return parseHopLimitOverride(raw) === undefined
    ? `${nodeType} "${nodeId}" requires params.hopLimit ∈ {inherit, 0–${HOP_LIMIT_OVERRIDE_MAX}}`
    : null;
}

/**
 * Minimum time between two sends of the same automation waypoint (#5482),
 * in seconds. Enforced at run time from the persisted `waypoints.lastBroadcastAt`,
 * so saving the automation or restarting MeshMonitor never re-arms it.
 */
export const WAYPOINT_AUTOMATION_MIN_INTERVAL_SECONDS = 30 * 60;

/** Longest `expireHours` an action.broadcastWaypoint accepts (#5482): 30 days. */
export const WAYPOINT_AUTOMATION_MAX_EXPIRE_HOURS = 24 * 30;

/** `waypointKey` length cap (#5482); keeps `<automationId>:<key>` within the column. */
export const WAYPOINT_KEY_MAX_LENGTH = 64;

/** True when a param is a `{{ }}` template, so it can only be checked at run time. */
function isTemplated(raw: unknown): boolean {
  return typeof raw === 'string' && raw.includes('{{');
}

/**
 * Save-time checks for action.broadcastWaypoint (#5482). Fields that may hold
 * a `{{ }}` template (latitude, longitude, expireHours) are only checked when
 * they are literals; the executor re-checks the interpolated values.
 */
function broadcastWaypointParamErrors(nodeId: string, p: Record<string, unknown>): string[] {
  const t = 'action.broadcastWaypoint';
  const errors: string[] = [];
  if (typeof p.sourceId !== 'string' || p.sourceId.trim().length === 0) {
    errors.push(`${t} "${nodeId}" requires params.sourceId (a Meshtastic source)`);
  }
  const key = typeof p.waypointKey === 'string' ? p.waypointKey.trim() : '';
  if (!key) {
    errors.push(`${t} "${nodeId}" requires params.waypointKey`);
  } else if (key.length > WAYPOINT_KEY_MAX_LENGTH) {
    errors.push(`${t} "${nodeId}" requires params.waypointKey of at most ${WAYPOINT_KEY_MAX_LENGTH} characters`);
  }
  const coord = (name: 'latitude' | 'longitude', limit: number) => {
    const raw = p[name];
    if (raw == null || raw === '') {
      errors.push(`${t} "${nodeId}" requires params.${name}`);
      return;
    }
    if (isTemplated(raw)) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < -limit || n > limit) {
      errors.push(`${t} "${nodeId}" requires params.${name} ∈ [-${limit}, ${limit}]`);
    }
  };
  coord('latitude', 90);
  coord('longitude', 180);
  if (p.expireHours != null && p.expireHours !== '' && !isTemplated(p.expireHours)) {
    const h = Number(p.expireHours);
    if (!Number.isFinite(h) || h <= 0 || h > WAYPOINT_AUTOMATION_MAX_EXPIRE_HOURS) {
      errors.push(`${t} "${nodeId}" requires params.expireHours ∈ (0, ${WAYPOINT_AUTOMATION_MAX_EXPIRE_HOURS}]`);
    }
  }
  if (p.channel != null && p.channel !== '') {
    const c = Number(p.channel);
    if (!Number.isInteger(c) || c < 0 || c > 7) {
      errors.push(`${t} "${nodeId}" requires params.channel ∈ [0, 7]`);
    }
  }
  const hopErr = hopLimitParamError(t, nodeId, p.hopLimit);
  if (hopErr) errors.push(hopErr);
  if (p.onlyWhenChanged != null && typeof p.onlyWhenChanged !== 'boolean') {
    errors.push(`${t} "${nodeId}" requires params.onlyWhenChanged to be true or false`);
  }
  return errors;
}

/**
 * Per-automation flood ceiling (#4577 Phase 2, work package RATE-LIMIT).
 *
 * Distinct from the per-subject `cooldownGate` debounce above: this bounds
 * how many times a SINGLE automation may FIRE inside a rolling window, keyed
 * by automation id ONLY (never per-subject) — a flood guard, not a debounce.
 * It composes with cooldownScope: cooldown decides IF/WHEN a given subject
 * may re-fire; rate limit decides how many fires the whole automation may
 * spend across ALL subjects in the window.
 */
export const RATE_LIMIT_MAX_ACTIONS_MIN = 1;
export const RATE_LIMIT_MAX_ACTIONS_MAX = 1000;

/**
 * Coerce a stored `params.rateLimit` to `{ maxActions, windowSeconds }`, or
 * `undefined` for absent / blank / malformed input — `undefined` means "no
 * rate limit", the pre-Phase-2 behaviour every stored automation depends on.
 * Lenient at RUNTIME (graphs written before this existed must still run)
 * while validateAutomationGraph rejects a malformed value at SAVE time — the
 * same split used above for cooldownScope and maxAttempts.
 */
export function parseRateLimit(raw: unknown): { maxActions: number; windowSeconds: number } | undefined {
  if (!isPlainObject(raw)) return undefined;
  const maxActions = Number(raw.maxActions);
  const windowSeconds = Number(raw.windowSeconds);
  if (!Number.isInteger(maxActions) || maxActions < RATE_LIMIT_MAX_ACTIONS_MIN) return undefined;
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) return undefined;
  return { maxActions: Math.min(RATE_LIMIT_MAX_ACTIONS_MAX, maxActions), windowSeconds };
}

/**
 * Match modes for `condition.meshcoreScope` (#3914). A MeshCore text message
 * carries a region "scope" (`scopeCode` 0 = unscoped, >0 = a region; `scopeName`
 * = the resolved region). This condition matches:
 *  - `named`    — the message's region is one of the listed names (with an
 *                 optional `includeUnscoped` toggle → "region de OR unscoped");
 *  - `unscoped` — the message was sent with no region (`scopeCode === 0`);
 *  - `scoped`   — the message carries any region (`scopeCode > 0`).
 * Meshtastic messages carry no scope and therefore never match.
 */
export const MESHCORE_SCOPE_MODES = ['named', 'unscoped', 'scoped'] as const;
export type MeshCoreScopeMode = (typeof MESHCORE_SCOPE_MODES)[number];

// ─── Variable types (canonical home; repository re-exports these) ─────────────

export const VARIABLE_TYPES = ['string', 'integer', 'float', 'boolean', 'flag', 'json'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const VARIABLE_SCOPES = ['global', 'source', 'node', 'sourceNode'] as const;
export type VariableScope = (typeof VARIABLE_SCOPES)[number];

// ─── Graph shape ─────────────────────────────────────────────────────────────

export type EdgePort = 'true' | 'false';

export interface AutomationNode {
  id: string;
  type: AutomationNodeType;
  params?: Record<string, unknown>;
}

export interface AutomationEdge {
  from: string;
  to: string;
  /** Only meaningful for edges leaving a condition node (If/ElseIf/Else routing). */
  port?: EdgePort;
}

export interface AutomationGraph {
  version: number;
  nodes: AutomationNode[];
  edges: AutomationEdge[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /**
   * Non-blocking findings: `{{ steps.* }}` references that will, or may,
   * render empty (#5636), and actions whose text is empty (#5697). Present
   * only when valid and there is something to say.
   */
  warnings?: string[];
  /** Present only when valid. */
  graph?: AutomationGraph;
}

// ─── Run-scoped step outputs (#5636) ─────────────────────────────────────────
//
// A step can keep its result for the rest of the SAME run under a name the
// user gives it (`params.outputName`); later steps read it as
// `{{ steps.<name>.output }}`. The name is the key, never the node id: the
// builder regenerates node ids from position on every save (compile.ts).

/** A run-output name: lower-case letter first, then letters, digits or `_`; 1–32 chars. */
export const STEP_OUTPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** Most bytes of one step's output kept for the run; longer output is cut. */
export const STEP_OUTPUT_MAX_BYTES = 64 * 1024;

/** Action types that can store a run output. v1: "Run a script" only. */
export const STEP_OUTPUT_ACTION_TYPES: readonly ActionType[] = ['action.runScript'];

export function isStepOutputName(raw: unknown): raw is string {
  return typeof raw === 'string' && STEP_OUTPUT_NAME_PATTERN.test(raw);
}

/** The run-output name a node stores under, or undefined when it stores none. */
export function stepOutputNameOf(node: Pick<AutomationNode, 'type' | 'params'>): string | undefined {
  if (!STEP_OUTPUT_ACTION_TYPES.includes(node.type as ActionType)) return undefined;
  const name = node.params?.outputName;
  return isStepOutputName(name) ? name : undefined;
}

/**
 * Distinct run-output names that `{{ steps.<name>… }}` tokens in `text` refer
 * to. Scans with indexOf rather than a regex: the text is user-supplied, and
 * a lazy `\s*…\s*` token pattern backtracks badly on crafted input. Token
 * bounds match the engine's interpolate TOKEN: `{{`, then up to the first `}`,
 * which must begin `}}`.
 */
export function stepOutputRefs(text: string): string[] {
  if (typeof text !== 'string') return [];
  const names = new Set<string>();
  let from = 0;
  for (;;) {
    const open = text.indexOf('{{', from);
    if (open === -1) break;
    const close = text.indexOf('}', open + 2);
    if (close === -1) break;
    if (text[close + 1] !== '}') { from = open + 1; continue; }
    const path = text.slice(open + 2, close).trim();
    if (path.startsWith('steps.')) names.add(path.slice('steps.'.length).split('.')[0]);
    from = close + 2;
  }
  return [...names];
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (isPlainObject(value)) for (const v of Object.values(value)) collectStrings(v, out);
}

/** Which run outputs a node can read. */
export interface StepOutputScope {
  /** Stored by a step that always runs before this node. */
  guaranteed: Set<string>;
  /** Stored by a step that runs before this node on at least one path. */
  possible: Set<string>;
}

/**
 * For every node, the run outputs it can read (#5636). Works on DAG ancestry,
 * not list order, because rules interleave: a step in Rule 2 never sees an
 * output stored in Rule 1.
 *
 * `guaranteed` follows the evaluator's activation rules (graphEvaluator.ts):
 * a plain node or an ANY collapse runs when at least one incoming edge is
 * satisfied, so only what every incoming path has in common is certain; an
 * ALL collapse needs every edge, so it is certain of them all; NONE / ALWAYS
 * collapses can run with no satisfied edge, so nothing on the rules is
 * certain. A step that runs on every event (no condition in front of it) is
 * certain wherever it is an ancestor.
 *
 * Expects a structurally valid DAG; on a cyclic graph the nodes on the cycle
 * get empty scopes.
 */
export function stepOutputScopes(graph: Pick<AutomationGraph, 'nodes' | 'edges'>): Map<string, StepOutputScope> {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) { incoming.set(n.id, []); outgoing.set(n.id, []); indeg.set(n.id, 0); }
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    incoming.get(e.to)!.push(e.from);
    outgoing.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const order: string[] = [];
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  while (queue.length) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of outgoing.get(u) ?? []) {
      indeg.set(v, (indeg.get(v) ?? 0) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }

  const isCondition = (id: string) => categoryOf(byId.get(id)!.type) === 'condition';
  const ancestors = new Map<string, Set<string>>();
  const certain = new Map<string, Set<string>>();
  /** Nodes that run on every event. */
  const always = new Set<string>();

  for (const id of order) {
    const node = byId.get(id)!;
    const preds = incoming.get(id) ?? [];
    const anc = new Set<string>();
    for (const p of preds) { anc.add(p); for (const a of ancestors.get(p) ?? []) anc.add(a); }
    ancestors.set(id, anc);

    const mode = node.type === 'flow.collapse' ? ((node.params?.mode as CollapseMode) ?? 'ANY') : null;
    const sureEdges = preds.filter((p) => always.has(p) && !isCondition(p)).length;
    if (preds.length === 0) {
      if (categoryOf(node.type) === 'trigger') always.add(id);
    } else if (mode === 'ALWAYS') always.add(id);
    else if (mode === 'ALL') { if (sureEdges === preds.length) always.add(id); }
    else if (mode !== 'NONE' && sureEdges >= 1) always.add(id);

    const viaEdge = preds.map((p) => new Set<string>([p, ...(certain.get(p) ?? [])]));
    let sure = new Set<string>();
    if (mode === 'ALL') {
      for (const s of viaEdge) for (const x of s) sure.add(x);
    } else if (mode !== 'NONE' && mode !== 'ALWAYS' && viaEdge.length > 0) {
      sure = new Set([...viaEdge[0]].filter((x) => viaEdge.every((s) => s.has(x))));
    }
    for (const a of anc) if (always.has(a)) sure.add(a);
    certain.set(id, sure);
  }

  const nameOf = new Map<string, string>();
  for (const n of nodes) { const name = stepOutputNameOf(n); if (name) nameOf.set(n.id, name); }
  const names = (ids: Set<string> | undefined) =>
    new Set([...(ids ?? [])].map((x) => nameOf.get(x)).filter((x): x is string => x !== undefined));
  const scopes = new Map<string, StepOutputScope>();
  for (const n of nodes) {
    scopes.set(n.id, { guaranteed: names(certain.get(n.id)), possible: names(ancestors.get(n.id)) });
  }
  return scopes;
}

export type StepOutputRefProblem = 'unknown' | 'notBefore' | 'maybe';

/**
 * Why `{{ steps.<name>… }}` read from a node with `scope` will, or may, render
 * empty; undefined when the output is certain to be there. `allNames` is every
 * run-output name in the automation.
 */
export function stepOutputRefProblem(
  name: string,
  scope: StepOutputScope | undefined,
  allNames: ReadonlySet<string>,
): StepOutputRefProblem | undefined {
  if (!allNames.has(name)) return 'unknown';
  if (!scope || !scope.possible.has(name)) return 'notBefore';
  return scope.guaranteed.has(name) ? undefined : 'maybe';
}

/** Builder / validation copy for a {@link StepOutputRefProblem}. */
export function stepOutputProblemDetail(problem: StepOutputRefProblem, name: string): string {
  if (problem === 'unknown') return `is always empty: no step stores its output as "${name}"`;
  if (problem === 'notBefore') return `is always empty: the step that stores "${name}" does not run before this one`;
  return `may be empty: the step that stores "${name}" does not always run before this one`;
}

export interface StepOutputDiagnostic {
  nodeId: string;
  name: string;
  /** 'error' = always empty; 'warn' = may be empty. */
  severity: 'error' | 'warn';
  message: string;
}

/** Every `{{ steps.* }}` reference in `graph` that will, or may, render empty (#5636). */
export function analyzeStepOutputRefs(graph: Pick<AutomationGraph, 'nodes' | 'edges'>): StepOutputDiagnostic[] {
  const scopes = stepOutputScopes(graph);
  const allNames = new Set<string>();
  for (const n of graph.nodes ?? []) { const name = stepOutputNameOf(n); if (name) allNames.add(name); }
  const out: StepOutputDiagnostic[] = [];
  for (const n of graph.nodes ?? []) {
    const strings: string[] = [];
    collectStrings(n.params ?? {}, strings);
    const seen = new Set<string>();
    for (const s of strings) {
      for (const name of stepOutputRefs(s)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const problem = stepOutputRefProblem(name, scopes.get(n.id), allNames);
        if (!problem) continue;
        out.push({
          nodeId: n.id,
          name,
          severity: problem === 'maybe' ? 'warn' : 'error',
          message: `${n.type} "${n.id}": {{ steps.${name} }} ${stepOutputProblemDetail(problem, name)}`,
        });
      }
    }
  }
  return out;
}

/** An action field left empty so the step sends nothing, or less than intended (#5697). */
export interface EmptySendFinding {
  /** Params that are empty. */
  fields: string[];
  /** true = the step sends nothing at all; false = it sends, but without this text. */
  sendsNothing: boolean;
  /** Builder copy, without the node prefix. */
  detail: string;
}

const isBlankParam = (v: unknown): boolean => v == null || (typeof v === 'string' && v.trim() === '');

/**
 * What an action block will leave out because a text field is empty (#5697).
 * Mirrors the engine's empty-send rule (#5636, actionExecutor): only literal
 * emptiness is caught here; a template whose tokens render empty is the
 * run-time rule's job. Absent params that the engine defaults (a notification
 * title, a tapback emoji) are not empty.
 */
export function emptySendFinding(type: string, params: Record<string, unknown> | undefined): EmptySendFinding | undefined {
  const p = params ?? {};
  switch (type) {
    case 'action.sendMessage':
      return isBlankParam(p.text)
        ? { fields: ['text'], sendsNothing: true, detail: 'the message is empty, so this step will send nothing' }
        : undefined;
    case 'action.notify': {
      // An absent title falls back to "MeshMonitor automation"; a blank one stays blank.
      const titleBlank = typeof p.title === 'string' && p.title.trim() === '';
      if (!isBlankParam(p.body)) return undefined;
      return titleBlank
        ? { fields: ['title', 'body'], sendsNothing: true, detail: 'the title and body are empty, so this step will send nothing' }
        : { fields: ['body'], sendsNothing: false, detail: 'the body is empty, so the notification will carry only its title' };
    }
    case 'action.tapback':
      return p.emojiMode !== 'hopCount' && typeof p.emoji === 'string' && p.emoji.trim() === ''
        ? { fields: ['emoji'], sendsNothing: true, detail: 'the emoji is empty, so this step will send nothing' }
        : undefined;
    default:
      return undefined;
  }
}

/** Every action in `graph` with an empty text field (#5697), as save warnings. */
export function analyzeEmptySends(graph: Pick<AutomationGraph, 'nodes'>): string[] {
  const out: string[] = [];
  for (const n of graph.nodes ?? []) {
    const f = emptySendFinding(n.type, n.params);
    if (f) out.push(`${n.type} "${n.id}": ${f.detail}`);
  }
  return out;
}

/**
 * Every source an action.setSourceForwardingEnabled block in `graph` targets
 * (#5537), deduped. Automations are global and run as the system, so the save
 * routes use this to check that the SAVING user holds `automation` write on
 * each one. Validation guarantees the ids are literals.
 */
export function forwardingToggleSourceIds(graph: Pick<AutomationGraph, 'nodes'>): string[] {
  const ids = new Set<string>();
  for (const n of graph.nodes ?? []) {
    if (n.type !== 'action.setSourceForwardingEnabled') continue;
    const sid = n.params?.sourceId;
    if (typeof sid === 'string' && sid.trim()) ids.add(sid.trim());
  }
  return [...ids];
}

// ─── Validation ──────────────────────────────────────────────────────────────

const NODE_TYPE_SET = new Set<string>(ALL_NODE_TYPES);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate an automation graph document. Returns structured errors rather than
 * throwing, so the import UI can list every problem at once.
 *
 * Enforced invariants:
 *  - well-formed { version, nodes[], edges[] }
 *  - unique non-empty node ids; known node types
 *  - exactly one trigger node (UI v1 entry point)
 *  - edges reference existing nodes; no self-loops
 *  - `port` only on edges leaving a condition node, and ∈ {true,false}
 *  - triggers have no incoming edges
 *  - the graph is acyclic (DAG)
 *  - every node is reachable from the trigger (no orphans)
 *  - light per-block param checks (extended over time)
 */
export function validateAutomationGraph(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { valid: false, errors: ['config must be an object'] };
  }
  if (typeof input.version !== 'number') {
    errors.push('version must be a number');
  }
  if (!Array.isArray(input.nodes)) {
    errors.push('nodes must be an array');
  }
  if (!Array.isArray(input.edges)) {
    errors.push('edges must be an array');
  }
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const rawNodes = input.nodes as unknown[];
  const rawEdges = input.edges as unknown[];

  // ── nodes ──
  const ids = new Set<string>();
  const typeById = new Map<string, AutomationNodeType>();
  rawNodes.forEach((n, i) => {
    if (!isPlainObject(n)) {
      errors.push(`nodes[${i}] must be an object`);
      return;
    }
    if (typeof n.id !== 'string' || n.id.length === 0) {
      errors.push(`nodes[${i}].id must be a non-empty string`);
      return;
    }
    if (ids.has(n.id)) {
      errors.push(`duplicate node id "${n.id}"`);
      return;
    }
    ids.add(n.id);
    if (typeof n.type !== 'string' || !NODE_TYPE_SET.has(n.type)) {
      errors.push(`node "${n.id}" has unknown type "${String(n.type)}"`);
      return;
    }
    if (n.params !== undefined && !isPlainObject(n.params)) {
      errors.push(`node "${n.id}".params must be an object`);
    }
    typeById.set(n.id, n.type as AutomationNodeType);
  });

  const triggerIds = [...typeById.entries()].filter(([, t]) => categoryOf(t) === 'trigger').map(([id]) => id);
  if (triggerIds.length === 0) {
    errors.push('graph must contain exactly one trigger node (found 0)');
  } else if (triggerIds.length > 1) {
    errors.push(`graph must contain exactly one trigger node (found ${triggerIds.length})`);
  }

  // ── edges ──
  const incoming = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  rawEdges.forEach((e, i) => {
    if (!isPlainObject(e)) {
      errors.push(`edges[${i}] must be an object`);
      return;
    }
    const { from, to, port } = e as Record<string, unknown>;
    if (typeof from !== 'string' || !typeById.has(from)) {
      errors.push(`edges[${i}].from references unknown node "${String(from)}"`);
      return;
    }
    if (typeof to !== 'string' || !typeById.has(to)) {
      errors.push(`edges[${i}].to references unknown node "${String(to)}"`);
      return;
    }
    if (from === to) {
      errors.push(`edges[${i}] is a self-loop on "${from}"`);
      return;
    }
    if (port !== undefined) {
      if (port !== 'true' && port !== 'false') {
        errors.push(`edges[${i}].port must be "true" or "false"`);
      } else if (categoryOf(typeById.get(from)!) !== 'condition') {
        errors.push(`edges[${i}].port is only allowed on edges leaving a condition node`);
      }
    }
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push(to);
  });

  // triggers must have no incoming edges
  for (const tid of triggerIds) {
    if ((incoming.get(tid) ?? 0) > 0) {
      errors.push(`trigger node "${tid}" must not have incoming edges`);
    }
  }

  // cycle detection (DFS) — only meaningful if structure is otherwise sound
  if (errors.length === 0) {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of ids) color.set(id, WHITE);
    let hasCycle = false;
    const visit = (u: string): void => {
      color.set(u, GRAY);
      for (const v of adjacency.get(u) ?? []) {
        if (color.get(v) === GRAY) { hasCycle = true; return; }
        if (color.get(v) === WHITE) { visit(v); if (hasCycle) return; }
      }
      color.set(u, BLACK);
    };
    for (const id of ids) {
      if (color.get(id) === WHITE) visit(id);
      if (hasCycle) break;
    }
    if (hasCycle) errors.push('graph must be acyclic (a cycle was detected)');

    // reachability from the single trigger
    if (!hasCycle && triggerIds.length === 1) {
      const seen = new Set<string>();
      const stack = [triggerIds[0]];
      while (stack.length) {
        const u = stack.pop()!;
        if (seen.has(u)) continue;
        seen.add(u);
        for (const v of adjacency.get(u) ?? []) stack.push(v);
      }
      for (const id of ids) {
        if (!seen.has(id)) errors.push(`node "${id}" is not reachable from the trigger`);
      }
    }
  }

  // ── light per-block param checks ──
  if (errors.length === 0) {
    /** Run-output names seen so far → the node that took each (#5636). */
    const outputNames = new Map<string, string>();
    for (const n of rawNodes as AutomationNode[]) {
      const p = (n.params ?? {}) as Record<string, unknown>;
      // Run-scoped step output (#5636). Optional; absent/blank = store nothing
      // for the run. The name is what later steps read, so it must be
      // well-formed and unique within the automation.
      if (p.outputName != null && p.outputName !== '') {
        if (!STEP_OUTPUT_ACTION_TYPES.includes(n.type as ActionType)) {
          errors.push(`${n.type} "${n.id}" cannot store a run output (params.outputName); only action.runScript can`);
        } else if (!isStepOutputName(p.outputName)) {
          errors.push(`${n.type} "${n.id}" requires params.outputName to be 1–32 characters: a lower-case letter, then lower-case letters, digits or _`);
        } else if (outputNames.has(p.outputName)) {
          errors.push(`${n.type} "${n.id}" reuses the run output name "${p.outputName}" (already used by "${outputNames.get(p.outputName)}"); names must be unique within an automation`);
        } else {
          outputNames.set(p.outputName, n.id);
        }
      }
      // Cooldown scope (#4340 Phase 2) is a trigger-level param every trigger type
      // shares, so it is checked once here rather than duplicated into seven cases
      // (which would silently miss any trigger type added later). Optional:
      // absent/unset = 'automation', the pre-4.14 behaviour every stored automation
      // depends on — same contract as action.tapback's emojiMode.
      if (categoryOf(n.type) === 'trigger'
          && p.cooldownScope != null
          && !COOLDOWN_SCOPES.includes(p.cooldownScope as CooldownScope)) {
        errors.push(`${n.type} "${n.id}" requires params.cooldownScope ∈ {automation,node,sourceNode}`);
      }
      // Rate limit (#4577 Phase 2, RATE-LIMIT) is likewise a trigger-level param
      // shared by every trigger type, checked once here for the same reason.
      // Optional: absent/null = no rate limit, the pre-Phase-2 behaviour every
      // stored automation depends on. Save-time strict; runtime lenient via
      // parseRateLimit (same split as cooldownScope above).
      if (categoryOf(n.type) === 'trigger' && p.rateLimit != null) {
        const rl = p.rateLimit;
        const maxActions = isPlainObject(rl) ? Number((rl as Record<string, unknown>).maxActions) : NaN;
        const windowSeconds = isPlainObject(rl) ? Number((rl as Record<string, unknown>).windowSeconds) : NaN;
        const validShape = isPlainObject(rl)
          && Number.isInteger(maxActions) && maxActions >= RATE_LIMIT_MAX_ACTIONS_MIN && maxActions <= RATE_LIMIT_MAX_ACTIONS_MAX
          && Number.isInteger(windowSeconds) && windowSeconds >= 1;
        if (!validShape) {
          errors.push(`${n.type} "${n.id}" requires params.rateLimit = { maxActions >= 1, windowSeconds >= 1 }`);
        }
      }
      switch (n.type) {
        case 'flow.collapse':
          if (!COLLAPSE_MODES.includes(p.mode as CollapseMode)) {
            errors.push(`flow.collapse "${n.id}" requires params.mode ∈ {ANY,ALL,NONE,ALWAYS}`);
          }
          break;
        case 'condition.numeric':
          if (!NUMERIC_OPS.includes(p.op as NumericOp)) {
            errors.push(`condition.numeric "${n.id}" requires a valid params.op`);
          }
          if (typeof p.field !== 'string' || p.field.length === 0) {
            errors.push(`condition.numeric "${n.id}" requires params.field`);
          }
          break;
        case 'condition.variable':
        case 'flow.setVar':
          if (typeof p.variable !== 'string' || p.variable.length === 0) {
            errors.push(`${n.type} "${n.id}" requires params.variable`);
          }
          break;
        case 'condition.meshcoreScope': {
          const mode = p.mode == null ? 'named' : p.mode;
          if (!MESHCORE_SCOPE_MODES.includes(mode as MeshCoreScopeMode)) {
            errors.push(`condition.meshcoreScope "${n.id}" requires params.mode ∈ {named,unscoped,scoped}`);
          } else if (mode === 'named') {
            const hasRegions = typeof p.regions === 'string' && p.regions.trim().length > 0;
            if (!hasRegions && p.includeUnscoped !== true) {
              errors.push(`condition.meshcoreScope "${n.id}" (named) requires params.regions or params.includeUnscoped`);
            }
          }
          break;
        }
        case 'action.runScript':
          if (typeof p.scriptPath !== 'string' || p.scriptPath.length === 0) {
            errors.push(`action.runScript "${n.id}" requires params.scriptPath`);
          }
          break;
        case 'action.requestData':
          if (p.op != null && !REQUEST_OPS.includes(p.op as RequestOp)) {
            errors.push(`action.requestData "${n.id}" requires a valid params.op`);
          }
          // Optional MeshCore advert reach. Absent = flood (pre-existing actions).
          if (p.advertMode != null && !isMeshCoreAdvertMode(p.advertMode)) {
            errors.push(`action.requestData "${n.id}" requires params.advertMode ∈ {zero_hop,flood}`);
          }
          break;
        case 'action.tapback':
          // Optional. Absent/unset = 'fixed' — every pre-existing stored automation
          // must keep validating and behaving exactly as before.
          if (p.emojiMode != null && !TAPBACK_EMOJI_MODES.includes(p.emojiMode as TapbackEmojiMode)) {
            errors.push(`action.tapback "${n.id}" requires params.emojiMode ∈ {fixed,hopCount}`);
          }
          {
            const hopErr = hopLimitParamError('action.tapback', n.id, p.hopLimit);
            if (hopErr) errors.push(hopErr);
          }
          break;
        case 'action.deviceReboot':
          // `seconds` is optional (Meshtastic reboot delay; MeshCore ignores it).
          if (p.seconds != null) {
            const secs = Number(p.seconds);
            if (!Number.isFinite(secs) || secs < 0) {
              errors.push(`action.deviceReboot "${n.id}" requires params.seconds ≥ 0`);
            }
          }
          // `targetNodeNum` is optional (#4126). Blank/absent = local-only reboot;
          // a positive integer = remote-admin reboot over the mesh (Meshtastic).
          if (p.targetNodeNum != null && p.targetNodeNum !== '') {
            const target = Number(p.targetNodeNum);
            if (!Number.isInteger(target) || target <= 0) {
              errors.push(`action.deviceReboot "${n.id}" requires params.targetNodeNum to be a positive node number`);
            }
          }
          break;
        case 'trigger.becameMobile':
        case 'trigger.leftHome': {
          // Hand-selected node list is required for v1 (no "all nodes" mode).
          const nums = Array.isArray(p.nodeNums) ? p.nodeNums : null;
          if (!nums || nums.length === 0) {
            errors.push(`${n.type} "${n.id}" requires params.nodeNums (non-empty array of node numbers)`);
          } else if (!nums.every((x) => Number.isInteger(Number(x)))) {
            errors.push(`${n.type} "${n.id}" requires params.nodeNums to be an array of integers`);
          }
          if (n.type === 'trigger.leftHome') {
            const thr = p.thresholdMeters == null || p.thresholdMeters === '' ? 300 : Number(p.thresholdMeters);
            if (!Number.isFinite(thr) || thr <= 0) {
              errors.push(`trigger.leftHome "${n.id}" requires params.thresholdMeters > 0`);
            }
          }
          break;
        }
        case 'trigger.nodeStale':
        case 'trigger.nodeOnline': {
          // Staleness is packet ABSENCE (#4558 Phase A): the threshold defines
          // what "silent long enough" means for BOTH the going-silent alert and
          // its recovery counterpart, so both require a positive minutes value.
          const thrMin = p.staleAfterMinutes == null || p.staleAfterMinutes === ''
            ? NaN
            : Number(p.staleAfterMinutes);
          if (!Number.isFinite(thrMin) || thrMin <= 0) {
            errors.push(`${n.type} "${n.id}" requires params.staleAfterMinutes > 0`);
          }
          break;
        }
        case 'trigger.nodePowerChanged': {
          // Device Health (#4558 Phase C). Optional direction filter; absent /
          // blank means 'either', so every pre-existing stored automation and a
          // freshly-dropped block both validate. Reject only an unknown value.
          const dir = p.direction == null || p.direction === '' ? 'either' : String(p.direction);
          if (!['lost', 'restored', 'either'].includes(dir)) {
            errors.push(`trigger.nodePowerChanged "${n.id}" requires params.direction to be one of: lost, restored, either`);
          }
          break;
        }
        case 'trigger.batteryTrend': {
          // Device Health (#4558 Phase E). A declining-battery heuristic driven by
          // durable telemetry history on a periodic tick: both the lookback window
          // and the drop that counts as "declining" must be positive. `windowHours`
          // is the lookback; `minDropPercent` is the battery-level fall (percentage
          // POINTS, since the metric is batteryLevel %) that fires the alert.
          const windowHours = p.windowHours == null || p.windowHours === '' ? NaN : Number(p.windowHours);
          if (!Number.isFinite(windowHours) || windowHours <= 0) {
            errors.push(`trigger.batteryTrend "${n.id}" requires params.windowHours > 0`);
          }
          const minDropPercent = p.minDropPercent == null || p.minDropPercent === '' ? NaN : Number(p.minDropPercent);
          if (!Number.isFinite(minDropPercent) || minDropPercent <= 0) {
            errors.push(`trigger.batteryTrend "${n.id}" requires params.minDropPercent > 0`);
          }
          break;
        }
        case 'action.setAutomationEnabled': {
          // #5445. automationId may be a literal id or a {{ }} template, so only
          // its presence is checked here; an unknown id fails the step at run time.
          if (typeof p.automationId !== 'string' || p.automationId.trim().length === 0) {
            errors.push(`action.setAutomationEnabled "${n.id}" requires params.automationId`);
          }
          const mode = p.mode == null ? 'set' : p.mode;
          if (!AUTOMATION_ENABLE_MODES.includes(mode as AutomationEnableMode)) {
            errors.push(`action.setAutomationEnabled "${n.id}" requires params.mode ∈ {set,toggle}`);
          } else if (mode === 'set') {
            // Toggle ignores `enabled`. Set needs a boolean, its string spelling,
            // or a template that resolves to one at run time.
            const e = p.enabled;
            const templated = typeof e === 'string' && e.includes('{{');
            if (!templated && parseAutomationEnabledFlag(e) === undefined) {
              errors.push(`action.setAutomationEnabled "${n.id}" requires params.enabled to be true or false`);
            }
          }
          break;
        }
        case 'action.setSourceForwardingEnabled': {
          // #5537. The source must be a literal id, never a {{ }} template: the
          // save route checks the saving user's `automation` write on it, and a
          // template would dodge that check.
          const sid = p.sourceId;
          if (typeof sid !== 'string' || sid.trim().length === 0) {
            errors.push(`action.setSourceForwardingEnabled "${n.id}" requires params.sourceId`);
          } else if (sid.includes('{{')) {
            errors.push(`action.setSourceForwardingEnabled "${n.id}" params.sourceId must be a source, not a template`);
          }
          const mode = p.mode == null ? 'set' : p.mode;
          if (!AUTOMATION_ENABLE_MODES.includes(mode as AutomationEnableMode)) {
            errors.push(`action.setSourceForwardingEnabled "${n.id}" requires params.mode ∈ {set,toggle}`);
          } else if (mode === 'set') {
            const e = p.enabled;
            const templated = typeof e === 'string' && e.includes('{{');
            if (!templated && parseAutomationEnabledFlag(e) === undefined) {
              errors.push(`action.setSourceForwardingEnabled "${n.id}" requires params.enabled to be true or false`);
            }
          }
          break;
        }
        case 'action.broadcastWaypoint': {
          for (const e of broadcastWaypointParamErrors(n.id, p)) errors.push(e);
          break;
        }
        case 'action.delay': {
          const secs = Number(p.seconds);
          if (!Number.isFinite(secs) || secs < 0 || secs > AUTOMATION_DELAY_MAX_SECONDS) {
            errors.push(`action.delay "${n.id}" requires params.seconds ∈ [0, ${AUTOMATION_DELAY_MAX_SECONDS}]`);
          }
          break;
        }
        case 'action.sendMessage':
          // Optional. Absent/blank = one direct send — every pre-existing stored
          // automation must keep validating and behaving exactly as before.
          if (p.maxAttempts != null && p.maxAttempts !== '') {
            const attempts = Number(p.maxAttempts);
            if (!Number.isInteger(attempts) || attempts < SEND_MAX_ATTEMPTS_MIN || attempts > SEND_MAX_ATTEMPTS_MAX) {
              errors.push(`action.sendMessage "${n.id}" requires params.maxAttempts ∈ [${SEND_MAX_ATTEMPTS_MIN}, ${SEND_MAX_ATTEMPTS_MAX}]`);
            }
          }
          {
            const hopErr = hopLimitParamError('action.sendMessage', n.id, p.hopLimit);
            if (hopErr) errors.push(hopErr);
          }
          break;
        default:
          break;
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  const graph = input as unknown as AutomationGraph;
  // Non-blocking, like the builder's token hints: an empty reference is safe
  // (it renders '' and an empty message is not sent), so it must not stop a save.
  const warnings = [
    ...analyzeStepOutputRefs(graph).map((d) => d.message),
    // #5697: an empty message is allowed (the user may be drafting) but never silent.
    ...analyzeEmptySends(graph),
  ];
  return { valid: true, errors: [], ...(warnings.length > 0 ? { warnings } : {}), graph };
}
