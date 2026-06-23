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
  | 'condition.sourceFilter'
  | 'condition.numeric'
  | 'condition.string'
  | 'condition.distance'
  | 'condition.timeRange'
  | 'condition.variable'
  | 'condition.logical';

export type ActionType =
  | 'action.sendMessage'
  | 'action.tapback'
  | 'action.nodeManage'
  | 'action.notify';

// flow.delay is intentionally absent — deferred to Phase 1b (stateful waits).
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
  'condition.sourceFilter',
  'condition.numeric',
  'condition.string',
  'condition.distance',
  'condition.timeRange',
  'condition.variable',
  'condition.logical',
];

export const ACTION_TYPES: readonly ActionType[] = [
  'action.sendMessage',
  'action.tapback',
  'action.nodeManage',
  'action.notify',
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

export const COLLAPSE_MODES = ['ANY', 'ALL', 'NONE'] as const;
export type CollapseMode = (typeof COLLAPSE_MODES)[number];

export const NUMERIC_OPS = ['>', '<', '>=', '<=', '==', '!='] as const;
export type NumericOp = (typeof NUMERIC_OPS)[number];

// ─── Variable types (canonical home; repository re-exports these) ─────────────

export const VARIABLE_TYPES = ['string', 'integer', 'float', 'boolean', 'flag'] as const;
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
            errors.push(`flow.collapse "${n.id}" requires params.mode ∈ {ANY,ALL,NONE}`);
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
