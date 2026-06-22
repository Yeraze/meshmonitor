/**
 * Workflow compiler (#3653) — converts between the IFTTT-style builder form and
 * the engine's graph JSON.
 *
 * Builder model (linear, v1): one trigger → an AND-chain of conditions → a
 * sequence of actions. compile() emits the linear graph; decompile() recovers
 * the form from a graph IFF it is that simple linear shape (otherwise null, and
 * the page falls back to the raw-JSON editor for advanced/imported graphs).
 */
import type { AutomationGraph, AutomationNode } from '../../types/automation.js';

export interface FormBlock {
  type: string;
  params: Record<string, unknown>;
}

export interface WorkflowForm {
  trigger: FormBlock;
  conditions: FormBlock[];
  actions: FormBlock[];
}

function isActionLike(type: string): boolean {
  return type.startsWith('action.') || type === 'flow.setVar';
}

/** Drop blank/empty params so the stored config stays clean. */
function clean(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === '' || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

/** Compile a builder form into a linear automation graph. */
export function compile(form: WorkflowForm): AutomationGraph {
  const nodes: AutomationNode[] = [];
  const edges: { from: string; to: string }[] = [];

  nodes.push({ id: 't', type: form.trigger.type as AutomationNode['type'], params: clean(form.trigger.params) });
  let prev = 't';

  form.conditions.forEach((c, i) => {
    const id = `c${i}`;
    nodes.push({ id, type: c.type as AutomationNode['type'], params: clean(c.params) });
    edges.push({ from: prev, to: id });
    prev = id;
  });

  form.actions.forEach((a, i) => {
    const id = `a${i}`;
    nodes.push({ id, type: a.type as AutomationNode['type'], params: clean(a.params) });
    edges.push({ from: prev, to: id });
    prev = id;
  });

  return { version: 1, nodes, edges };
}

/**
 * Recover a builder form from a graph, or null if the graph isn't a simple
 * linear chain (has ports/fanout/collapse, branches, orphans, or conditions
 * after actions) — in which case the caller uses the JSON editor.
 */
export function decompile(graph: unknown): WorkflowForm | null {
  if (!graph || typeof graph !== 'object') return null;
  const g = graph as Partial<AutomationGraph>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;

  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const e of g.edges) {
    if ((e as any).port) return null; // branching → not a simple chain
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
  }
  for (const tos of out.values()) if (tos.length > 1) return null; // fanout

  const triggers = g.nodes.filter((n) => String(n.type).startsWith('trigger.'));
  if (triggers.length !== 1) return null;

  // Walk the single chain from the trigger.
  const chain: AutomationNode[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = triggers[0].id;
  while (cur) {
    if (seen.has(cur)) return null; // cycle
    seen.add(cur);
    const node = nodeById.get(cur);
    if (!node) return null;
    chain.push(node);
    cur = out.get(cur)?.[0];
  }
  if (chain.length !== g.nodes.length) return null; // orphan / branch

  const [first, ...rest] = chain;
  const conditions: FormBlock[] = [];
  const actions: FormBlock[] = [];
  let inActions = false;
  for (const n of rest) {
    const isCond = String(n.type).startsWith('condition.');
    if (!isCond && !isActionLike(String(n.type))) return null; // fanout/collapse/delay → not simple
    if (isCond) {
      if (inActions) return null; // condition after action → not the simple shape
      conditions.push({ type: n.type, params: { ...(n.params ?? {}) } });
    } else {
      inActions = true;
      actions.push({ type: n.type, params: { ...(n.params ?? {}) } });
    }
  }

  return {
    trigger: { type: first.type, params: { ...(first.params ?? {}) } },
    conditions,
    actions,
  };
}
