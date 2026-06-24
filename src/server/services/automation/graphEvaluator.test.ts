import { describe, it, expect } from 'vitest';
import { evaluateGraph, type EvaluatorHooks } from './graphEvaluator.js';
import { validateAutomationGraph, type AutomationGraph } from '../../../types/automation.js';

/**
 * Fake hooks:
 *  - a condition's result is read from node.params.result (boolean)
 *  - actions record their id into `ran`; an action whose params.throw is set rejects
 *  - setVar records into `vars`
 */
function makeHooks() {
  const ran: string[] = [];
  const vars: string[] = [];
  const hooks: EvaluatorHooks<unknown> = {
    evaluateCondition: (node) => Boolean(node.params?.result),
    executeAction: (node) => {
      if (node.params?.throw) throw new Error(`boom:${node.id}`);
      ran.push(node.id);
      return { sent: node.id };
    },
    applySetVar: (node) => { vars.push(node.id); },
  };
  return { hooks, ran, vars };
}

/** Build + validate a graph (fails the test if the fixture is itself invalid). */
function g(graph: AutomationGraph): AutomationGraph {
  const r = validateAutomationGraph(graph);
  if (!r.valid) throw new Error('invalid fixture: ' + r.errors.join('; '));
  return r.graph!;
}

describe('evaluateGraph', () => {
  it('runs a linear trigger → action', async () => {
    const { hooks, ran } = makeHooks();
    const graph = g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const r = await evaluateGraph(graph, {}, hooks);
    expect(ran).toEqual(['a']);
    expect(r.actions).toEqual([{ nodeId: 'a', ok: true, value: { sent: 'a' } }]);
  });

  it('records a single step when a condition throws (no double-push)', async () => {
    const hooks: EvaluatorHooks<unknown> = {
      evaluateCondition: () => { throw new Error('boom'); },
      executeAction: () => ({}),
      applySetVar: () => {},
    };
    const graph = g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'c', type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0 } },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a', port: 'true' }],
    });
    const r = await evaluateGraph(graph, {}, hooks);
    const cSteps = r.steps.filter((s) => s.nodeId === 'c');
    expect(cSteps).toHaveLength(1);
    expect(cSteps[0].outcome).toBe('condition:false');
    expect(cSteps[0].error).toBe('boom');
    expect(r.conditionResults['c']).toBe(false);
  });

  it('does not pollute Object.prototype via an adversarial node id', async () => {
    const hooks: EvaluatorHooks<unknown> = {
      evaluateCondition: () => true,
      executeAction: () => ({}),
      applySetVar: () => {},
    };
    const graph = g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: '__proto__', type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0 } },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: '__proto__' }, { from: '__proto__', to: 'a', port: 'true' }],
    });
    const r = await evaluateGraph(graph, {}, hooks);
    // No prototype pollution; the id is a safe own property of the result map.
    expect(({} as Record<string, unknown>).hops).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r.conditionResults, '__proto__')).toBe(true);
  });

  it('routes If/Else by condition result (true → tapback, false skipped)', async () => {
    const { hooks, ran } = makeHooks();
    const graph = g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'c', type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0, result: true } },
        { id: 'tap', type: 'action.tapback' },
        { id: 'msg', type: 'action.sendMessage' },
      ],
      edges: [
        { from: 't', to: 'c' },
        { from: 'c', to: 'tap', port: 'true' },
        { from: 'c', to: 'msg', port: 'false' },
      ],
    });
    const r = await evaluateGraph(graph, {}, hooks);
    expect(ran).toEqual(['tap']);
    expect(r.conditionResults.c).toBe(true);
  });

  it('routes the false branch when the condition is false', async () => {
    const { hooks, ran } = makeHooks();
    const graph = g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'c', type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0, result: false } },
        { id: 'tap', type: 'action.tapback' },
        { id: 'msg', type: 'action.sendMessage' },
      ],
      edges: [
        { from: 't', to: 'c' },
        { from: 'c', to: 'tap', port: 'true' },
        { from: 'c', to: 'msg', port: 'false' },
      ],
    });
    await evaluateGraph(graph, {}, hooks);
    expect(ran).toEqual(['msg']);
  });

  it('treats an unported condition edge as a gate (continues only on true)', async () => {
    const { hooks, ran } = makeHooks();
    const mk = (result: boolean) => g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'c', type: 'condition.string', params: { op: 'contains', value: 'x', result } },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a' }],
    });
    await evaluateGraph(mk(false), {}, hooks);
    expect(ran).toEqual([]); // gate blocked
    await evaluateGraph(mk(true), {}, hooks);
    expect(ran).toEqual(['a']); // gate passed
  });

  it('cascades ElseIf (cond1 false → cond2 true → action)', async () => {
    const { hooks, ran } = makeHooks();
    const graph = g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'c1', type: 'condition.string', params: { op: 'eq', value: 'a', result: false } },
        { id: 'c2', type: 'condition.string', params: { op: 'eq', value: 'b', result: true } },
        { id: 'aYes', type: 'action.sendMessage' },
        { id: 'aElse', type: 'action.tapback' },
      ],
      edges: [
        { from: 't', to: 'c1' },
        { from: 'c1', to: 'aYes', port: 'true' },
        { from: 'c1', to: 'c2', port: 'false' },
        { from: 'c2', to: 'aElse', port: 'true' },
      ],
    });
    await evaluateGraph(graph, {}, hooks);
    expect(ran).toEqual(['aElse']);
  });

  it('fans out to multiple actions', async () => {
    const { hooks, ran } = makeHooks();
    const graph = g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'f', type: 'flow.fanout' },
        { id: 'a1', type: 'action.tapback' },
        { id: 'a2', type: 'action.sendMessage' },
      ],
      edges: [{ from: 't', to: 'f' }, { from: 'f', to: 'a1' }, { from: 'f', to: 'a2' }],
    });
    await evaluateGraph(graph, {}, hooks);
    expect(ran.sort()).toEqual(['a1', 'a2']);
  });

  describe('collapse modes', () => {
    // two conditions feed a collapse; cA=true, cB=false → 1 of 2 incoming satisfied
    const build = (mode: string) => g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'cA', type: 'condition.string', params: { op: 'x', value: 'x', result: true } },
        { id: 'cB', type: 'condition.string', params: { op: 'x', value: 'x', result: false } },
        { id: 'col', type: 'flow.collapse', params: { mode } },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [
        { from: 't', to: 'cA' }, { from: 't', to: 'cB' },
        { from: 'cA', to: 'col' }, { from: 'cB', to: 'col' },
        { from: 'col', to: 'a' },
      ],
    });

    it('ANY fires with ≥1 satisfied', async () => {
      const { hooks, ran } = makeHooks();
      await evaluateGraph(build('ANY'), {}, hooks);
      expect(ran).toEqual(['a']);
    });

    it('ALL does not fire with only 1 of 2 satisfied', async () => {
      const { hooks, ran } = makeHooks();
      await evaluateGraph(build('ALL'), {}, hooks);
      expect(ran).toEqual([]);
    });

    it('NONE does not fire when 1 is satisfied', async () => {
      const { hooks, ran } = makeHooks();
      await evaluateGraph(build('NONE'), {}, hooks);
      expect(ran).toEqual([]);
    });

    it('ALWAYS fires regardless of how many rules matched', async () => {
      const { hooks, ran } = makeHooks();
      await evaluateGraph(build('ALWAYS'), {}, hooks);
      expect(ran).toEqual(['a']);
    });
  });

  it('isolates an action error and keeps running others', async () => {
    const { hooks, ran } = makeHooks();
    const graph = g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'f', type: 'flow.fanout' },
        { id: 'bad', type: 'action.tapback', params: { throw: true } },
        { id: 'ok', type: 'action.sendMessage' },
      ],
      edges: [{ from: 't', to: 'f' }, { from: 'f', to: 'bad' }, { from: 'f', to: 'ok' }],
    });
    const r = await evaluateGraph(graph, {}, hooks);
    expect(ran).toEqual(['ok']);
    expect(r.actions).toEqual(expect.arrayContaining([
      { nodeId: 'bad', ok: false, error: 'boom:bad' },
      { nodeId: 'ok', ok: true, value: { sent: 'ok' } },
    ]));
  });

  it('enforces the maxActions guard', async () => {
    const { hooks, ran } = makeHooks();
    const graph = g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'f', type: 'flow.fanout' },
        { id: 'a1', type: 'action.tapback' },
        { id: 'a2', type: 'action.sendMessage' },
        { id: 'a3', type: 'action.notify' },
      ],
      edges: [
        { from: 't', to: 'f' },
        { from: 'f', to: 'a1' }, { from: 'f', to: 'a2' }, { from: 'f', to: 'a3' },
      ],
    });
    const r = await evaluateGraph(graph, {}, hooks, { maxActions: 2 });
    expect(ran.length).toBe(2);
    expect(r.steps.some((s) => s.outcome === 'guard:maxActions')).toBe(true);
  });

  it('applies setVar nodes', async () => {
    const { hooks, vars } = makeHooks();
    const graph = g({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'v', type: 'flow.setVar', params: { variable: 'welcomed' } },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'v' }, { from: 'v', to: 'a' }],
    });
    await evaluateGraph(graph, {}, hooks);
    expect(vars).toEqual(['v']);
  });
});
