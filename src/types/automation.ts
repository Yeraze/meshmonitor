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
  | 'trigger.geofence';

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
        case 'action.deviceReboot':
          // `seconds` is optional (Meshtastic reboot delay; MeshCore ignores it).
          if (p.seconds != null) {
            const secs = Number(p.seconds);
            if (!Number.isFinite(secs) || secs < 0) {
              errors.push(`action.deviceReboot "${n.id}" requires params.seconds ≥ 0`);
            }
          }
          break;
        case 'action.delay': {
          const secs = Number(p.seconds);
          if (!Number.isFinite(secs) || secs < 0 || secs > AUTOMATION_DELAY_MAX_SECONDS) {
            errors.push(`action.delay "${n.id}" requires params.seconds ∈ [0, ${AUTOMATION_DELAY_MAX_SECONDS}]`);
          }
          break;
        }
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
