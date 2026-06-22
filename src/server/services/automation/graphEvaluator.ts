/**
 * Automation graph evaluator (#3653, §4).
 *
 * Synchronous (Phase 1a) topological-activation walk over a validated DAG. The
 * evaluator is decoupled from mesh IO: condition evaluation, action execution,
 * and variable writes are injected as `hooks`, so the routing/collapse/fanout
 * logic is fully unit-testable.
 *
 * Activation model (handles fanout, collapse, and If/ElseIf/Else routing
 * uniformly): process nodes in topological order; a node is "active" when its
 * incoming edges are satisfied. An edge is satisfied when its source is active
 * AND the port matches the source's routing decision:
 *   - source is a condition: port 'true' needs result===true, 'false' needs
 *     result===false, and an unported edge behaves as a gate (needs true).
 *   - source is any other node: the edge is satisfied whenever the source is active.
 * A `flow.collapse` node activates per its mode over (satisfied, total) incoming
 * edges: ANY ≥1, ALL = all, NONE = 0. Every other node activates on ≥1 satisfied
 * edge. The single trigger is the always-active entry point.
 */
import {
  type AutomationGraph,
  type AutomationNode,
  type AutomationEdge,
  type CollapseMode,
  categoryOf,
} from '../../../types/automation.js';

export interface EvaluatorHooks<Ctx> {
  /** Evaluate a condition node → boolean (sync or async). */
  evaluateCondition(node: AutomationNode, ctx: Ctx): boolean | Promise<boolean>;
  /** Execute an action node; return value is recorded in the step log. */
  executeAction(node: AutomationNode, ctx: Ctx): unknown | Promise<unknown>;
  /** Apply a flow.setVar write. */
  applySetVar(node: AutomationNode, ctx: Ctx): void | Promise<void>;
}

export type StepOutcome =
  | 'condition:true'
  | 'condition:false'
  | 'action:ok'
  | 'action:error'
  | 'setVar:ok'
  | 'setVar:error'
  | 'activated'
  | 'guard:maxActions';

export interface EvaluationStep {
  nodeId: string;
  type: string;
  outcome: StepOutcome;
  error?: string;
}

export interface EvaluationResult {
  /** ids of every node that became active. */
  activatedNodeIds: string[];
  /** condition node id → boolean result. */
  conditionResults: Record<string, boolean>;
  /** ordered action executions with their returned value (or error). */
  actions: Array<{ nodeId: string; ok: boolean; value?: unknown; error?: string }>;
  steps: EvaluationStep[];
}

export interface EvaluatorOptions {
  /** Cap on executed actions per run (loop/spam guard). Default 50. */
  maxActions?: number;
}

/** Topological order of a validated DAG via Kahn's algorithm. */
function topoOrder(nodes: AutomationNode[], edges: AutomationEdge[]): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) { indeg.set(n.id, 0); adj.set(n.id, []); }
  for (const e of edges) {
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of adj.get(u) ?? []) {
      indeg.set(v, (indeg.get(v) ?? 0) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  return order;
}

/**
 * Evaluate a validated automation graph. Action/setVar errors are caught and
 * recorded (an action failure never aborts the run).
 */
export async function evaluateGraph<Ctx>(
  graph: AutomationGraph,
  ctx: Ctx,
  hooks: EvaluatorHooks<Ctx>,
  options: EvaluatorOptions = {},
): Promise<EvaluationResult> {
  const maxActions = options.maxActions ?? 50;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const incomingByNode = new Map<string, AutomationEdge[]>();
  for (const n of graph.nodes) incomingByNode.set(n.id, []);
  for (const e of graph.edges) incomingByNode.get(e.to)?.push(e);

  const active = new Set<string>();
  const conditionResults: Record<string, boolean> = {};
  const actions: EvaluationResult['actions'] = [];
  const steps: EvaluationStep[] = [];
  let actionCount = 0;

  // Trigger is the always-active entry point.
  const trigger = graph.nodes.find((n) => categoryOf(n.type) === 'trigger');
  if (trigger) active.add(trigger.id);

  const portSatisfied = (edge: AutomationEdge): boolean => {
    if (!active.has(edge.from)) return false;
    const src = nodeById.get(edge.from)!;
    if (categoryOf(src.type) === 'condition') {
      const result = conditionResults[edge.from];
      if (edge.port === 'true' || edge.port === undefined) return result === true;
      return result === false; // edge.port === 'false'
    }
    return true; // non-condition source: active ⇒ satisfied
  };

  const collapseActivates = (mode: CollapseMode, satisfied: number, total: number): boolean => {
    if (mode === 'ANY') return satisfied >= 1;
    if (mode === 'ALL') return total > 0 && satisfied === total;
    return satisfied === 0; // NONE
  };

  for (const nodeId of topoOrder(graph.nodes, graph.edges)) {
    const node = nodeById.get(nodeId)!;
    const cat = categoryOf(node.type);

    // Determine activation (trigger already active).
    if (!active.has(nodeId)) {
      const incoming = incomingByNode.get(nodeId) ?? [];
      const satisfied = incoming.filter(portSatisfied).length;
      const isActive =
        node.type === 'flow.collapse'
          ? collapseActivates((node.params?.mode as CollapseMode) ?? 'ANY', satisfied, incoming.length)
          : satisfied >= 1;
      if (!isActive) continue;
      active.add(nodeId);
    }

    // Execute node behavior.
    if (cat === 'condition') {
      let result = false;
      try {
        result = await hooks.evaluateCondition(node, ctx);
      } catch (e: any) {
        result = false;
        steps.push({ nodeId, type: node.type, outcome: 'condition:false', error: e?.message });
      }
      conditionResults[nodeId] = result;
      steps.push({ nodeId, type: node.type, outcome: result ? 'condition:true' : 'condition:false' });
    } else if (cat === 'action') {
      if (actionCount >= maxActions) {
        steps.push({ nodeId, type: node.type, outcome: 'guard:maxActions' });
        continue;
      }
      actionCount++;
      try {
        const value = await hooks.executeAction(node, ctx);
        actions.push({ nodeId, ok: true, value });
        steps.push({ nodeId, type: node.type, outcome: 'action:ok' });
      } catch (e: any) {
        actions.push({ nodeId, ok: false, error: e?.message });
        steps.push({ nodeId, type: node.type, outcome: 'action:error', error: e?.message });
      }
    } else if (node.type === 'flow.setVar') {
      try {
        await hooks.applySetVar(node, ctx);
        steps.push({ nodeId, type: node.type, outcome: 'setVar:ok' });
      } catch (e: any) {
        steps.push({ nodeId, type: node.type, outcome: 'setVar:error', error: e?.message });
      }
    } else {
      // trigger / flow.fanout / flow.collapse — activation only.
      steps.push({ nodeId, type: node.type, outcome: 'activated' });
    }
  }

  return { activatedNodeIds: [...active], conditionResults, actions, steps };
}
