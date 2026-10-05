/**
 * Workflow compiler (#3653) — converts between the structured builder form and
 * the engine's graph JSON.
 *
 * Builder model:
 *   WHEN  one trigger
 *   RULES one-or-more independent rule branches (the trigger FANS OUT to each):
 *           each rule = an AND-chain of conditions → a sequence of actions
 *   COMBINE (optional) a reduce step: run its actions if [ANY|ALL|NONE] of the
 *           rules matched (their conditions passed) — compiles to flow.collapse.
 *
 * compile() emits the minimal graph (a single rule with no combine stays a plain
 * linear chain, no fanout). decompile() recovers the form from the linear shape
 * OR the fanout/collapse shape, and returns null for anything more exotic (so the
 * page falls back to the raw-JSON editor / future canvas).
 */
import { isStepOutputName, type AutomationGraph, type AutomationNode } from '../../types/automation.js';

export type CollapseMode = 'ANY' | 'ALL' | 'NONE' | 'ALWAYS';

export interface FormBlock { type: string; params: Record<string, unknown>; }
export interface Rule { conditions: FormBlock[]; actions: FormBlock[]; }
export interface CombineBlock { mode: CollapseMode; actions: FormBlock[]; }
export interface WorkflowForm {
  trigger: FormBlock;
  rules: Rule[];
  combine: CombineBlock | null;
}

function isActionLike(type: string): boolean {
  return type.startsWith('action.') || type === 'flow.setVar';
}

function clean(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === '' || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

// ─── compile ────────────────────────────────────────────────────────────────

/** Where a block sits in the form. */
export type BlockLocation =
  | { section: 'condition' | 'action'; rule: number; index: number }
  | { section: 'finally'; index: number };

/** True when the form compiles to the plain chain (one rule, no FINALLY). */
function isLinear(form: WorkflowForm): boolean {
  return form.rules.length <= 1 && !form.combine;
}

/**
 * The graph node id {@link compile} gives the block at `loc`. Ids come from
 * POSITION and so change when blocks are added, removed or reordered — never
 * store one. The builder uses this only to look a block up in a freshly
 * compiled graph (e.g. which run outputs it can read, #5636).
 */
export function blockNodeId(form: WorkflowForm, loc: BlockLocation): string {
  if (loc.section === 'finally') return `f${loc.index}`;
  const kind = loc.section === 'condition' ? 'c' : 'a';
  return isLinear(form) ? `${kind}${loc.index}` : `r${loc.rule}${kind}${loc.index}`;
}

export function compile(form: WorkflowForm): AutomationGraph {
  const nodes: AutomationNode[] = [];
  const edges: { from: string; to: string }[] = [];
  const add = (id: string, type: string, params: Record<string, unknown>) =>
    nodes.push({ id, type: type as AutomationNode['type'], params: clean(params) });

  add('t', form.trigger.type, form.trigger.params);
  const rules = form.rules.length ? form.rules : [{ conditions: [], actions: [] }];

  // Minimal linear chain: one rule, no combine → no fanout/collapse.
  if (isLinear(form)) {
    let prev = 't';
    rules[0].conditions.forEach((c, k) => { const id = blockNodeId(form, { section: 'condition', rule: 0, index: k }); add(id, c.type, c.params); edges.push({ from: prev, to: id }); prev = id; });
    rules[0].actions.forEach((a, k) => { const id = blockNodeId(form, { section: 'action', rule: 0, index: k }); add(id, a.type, a.params); edges.push({ from: prev, to: id }); prev = id; });
    return { version: 1, nodes, edges };
  }

  // Fanout across rules.
  add('f', 'flow.fanout', {});
  edges.push({ from: 't', to: 'f' });
  const tails: string[] = [];
  rules.forEach((rule, i) => {
    let prev = 'f';
    rule.conditions.forEach((c, k) => { const id = blockNodeId(form, { section: 'condition', rule: i, index: k }); add(id, c.type, c.params); edges.push({ from: prev, to: id }); prev = id; });
    rule.actions.forEach((a, k) => { const id = blockNodeId(form, { section: 'action', rule: i, index: k }); add(id, a.type, a.params); edges.push({ from: prev, to: id }); prev = id; });
    tails.push(prev); // tail = last action, or last condition, or 'f' for an empty rule
  });

  // Combine / reduce → collapse joining each rule's tail.
  if (form.combine) {
    add('col', 'flow.collapse', { mode: form.combine.mode });
    tails.forEach((tail) => edges.push({ from: tail, to: 'col' }));
    let prev = 'col';
    form.combine.actions.forEach((a, k) => { const id = blockNodeId(form, { section: 'finally', index: k }); add(id, a.type, a.params); edges.push({ from: prev, to: id }); prev = id; });
  }

  return { version: 1, nodes, edges };
}

/** Every action block in the form, with a label for messages ("Rule 2", "FINALLY"). */
function actionBlocks(form: WorkflowForm): Array<{ block: FormBlock; where: string }> {
  const out: Array<{ block: FormBlock; where: string }> = [];
  form.rules.forEach((r, i) => r.actions.forEach((block) => out.push({ block, where: `Rule ${i + 1}` })));
  form.combine?.actions.forEach((block) => out.push({ block, where: 'FINALLY' }));
  return out;
}

/** Run-output names (#5636) stored by the form's steps, in form order, repeats kept. */
export function formOutputNames(form: WorkflowForm): string[] {
  return actionBlocks(form)
    .map(({ block }) => block.params.outputName)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

/**
 * Builder-side check of "This run only" names (#5636), in plain words. The
 * server re-checks on save; this catches a blank name, which compile() would
 * otherwise drop without a word.
 */
export function outputNameErrors(form: WorkflowForm): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const { block, where } of actionBlocks(form)) {
    if (!('outputName' in block.params)) continue;
    const name = block.params.outputName;
    if (name === undefined || name === null) continue;
    if (name === '') errs.push(`${where}: name the script result you keep for this run.`);
    else if (!isStepOutputName(name)) errs.push(`${where}: the run result name "${String(name)}" must start with a lower-case letter and use only lower-case letters, digits and _ (32 characters at most).`);
    else if (seen.has(name)) errs.push(`${where}: the run result name "${name}" is used twice. Each name must be unique.`);
    else seen.add(name);
  }
  return errs;
}

// ─── decompile ──────────────────────────────────────────────────────────────

function blk(n: AutomationNode): FormBlock { return { type: n.type, params: { ...(n.params ?? {}) } }; }

/** Walk a strictly-linear single-out chain from startId; null if any node branches. */
function walkLinear(startId: string, out: Map<string, string[]>, nodeById: Map<string, AutomationNode>): AutomationNode[] | null {
  const chain: AutomationNode[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = startId;
  while (cur) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const n = nodeById.get(cur);
    if (!n) return null;
    chain.push(n);
    const outs: string[] = out.get(cur) ?? [];
    if (outs.length > 1) return null;
    cur = outs[0];
  }
  return chain;
}

/** Split a branch's node chain into a conditions prefix + actions suffix. */
function partition(chain: AutomationNode[]): Rule | null {
  const conditions: FormBlock[] = [];
  const actions: FormBlock[] = [];
  let inActions = false;
  for (const n of chain) {
    const isCond = String(n.type).startsWith('condition.');
    if (!isCond && !isActionLike(String(n.type))) return null;
    if (isCond) { if (inActions) return null; conditions.push(blk(n)); }
    else { inActions = true; actions.push(blk(n)); }
  }
  return { conditions, actions };
}

export function decompile(graph: unknown): WorkflowForm | null {
  if (!graph || typeof graph !== 'object') return null;
  const g = graph as Partial<AutomationGraph>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;

  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const e of g.edges) {
    if ((e as any).port) return null; // condition-port branching → not the simple shape
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
  }

  const triggers = g.nodes.filter((n) => String(n.type).startsWith('trigger.'));
  if (triggers.length !== 1) return null;
  const trig = triggers[0];
  const tOut = out.get(trig.id) ?? [];
  if (tOut.length !== 1) return null;
  const firstNode = nodeById.get(tOut[0]);
  if (!firstNode) return null;

  // ── simple linear chain (one rule, no fanout) ──
  if (firstNode.type !== 'flow.fanout') {
    const chain = walkLinear(trig.id, out, nodeById);
    if (!chain || chain.length !== g.nodes.length) return null;
    const rule = partition(chain.slice(1));
    if (!rule) return null;
    return { trigger: blk(trig), rules: [rule], combine: null };
  }

  // ── fanout / collapse shape ──
  const f = firstNode;
  const collapses = g.nodes.filter((n) => n.type === 'flow.collapse');
  if (collapses.length > 1) return null;
  const col = collapses[0] ?? null;
  const colId = col?.id ?? null;

  const branchStarts = out.get(f.id) ?? [];
  if (branchStarts.length === 0) return null;
  let counted = 2; // trigger + fanout
  const rules: Rule[] = [];
  for (const start of branchStarts) {
    if (start === colId) return null; // empty-rule shortcut not represented in the form
    const chain: AutomationNode[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur && cur !== colId) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      const node = nodeById.get(cur);
      if (!node) return null;
      chain.push(node);
      const outs: string[] = (out.get(cur) ?? []).filter((to) => to !== colId);
      if (outs.length > 1) return null; // a branch that itself fans out → not simple
      cur = outs[0];
    }
    const rule = partition(chain);
    if (!rule) return null;
    rules.push(rule);
    counted += chain.length;
  }

  let combine: CombineBlock | null = null;
  if (col) {
    const mode = (col.params as any)?.mode;
    if (mode !== 'ANY' && mode !== 'ALL' && mode !== 'NONE' && mode !== 'ALWAYS') return null;
    const colChain = walkLinear(col.id, out, nodeById);
    if (!colChain) return null;
    const actions: FormBlock[] = [];
    for (const n of colChain.slice(1)) { if (!isActionLike(String(n.type))) return null; actions.push(blk(n)); }
    combine = { mode, actions };
    counted += colChain.length; // collapse + its actions
  }

  if (counted !== g.nodes.length) return null; // unrecognised extra structure
  return { trigger: blk(trig), rules, combine };
}
