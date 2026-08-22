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
  | 'trigger.nodePowerChanged';

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
  | 'action.delay';

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
  /** Present only when valid. */
  graph?: AutomationGraph;
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
    for (const n of rawNodes as AutomationNode[]) {
      const p = (n.params ?? {}) as Record<string, unknown>;
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
          break;
        case 'action.tapback':
          // Optional. Absent/unset = 'fixed' — every pre-existing stored automation
          // must keep validating and behaving exactly as before.
          if (p.emojiMode != null && !TAPBACK_EMOJI_MODES.includes(p.emojiMode as TapbackEmojiMode)) {
            errors.push(`action.tapback "${n.id}" requires params.emojiMode ∈ {fixed,hopCount}`);
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
          break;
        default:
          break;
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, errors: [], graph: input as unknown as AutomationGraph };
}
