import { describe, it, expect } from 'vitest';
import {
  validateAutomationGraph,
  categoryOf,
  AUTOMATION_CONFIG_VERSION,
  type AutomationGraph,
} from './automation.js';

/** A minimal valid graph: trigger → tapback. */
function baseGraph(overrides: Partial<AutomationGraph> = {}): AutomationGraph {
  return {
    version: AUTOMATION_CONFIG_VERSION,
    nodes: [
      { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
      { id: 'a', type: 'action.tapback', params: { emoji: '👍' } },
    ],
    edges: [{ from: 't', to: 'a' }],
    ...overrides,
  };
}

describe('categoryOf', () => {
  it('classifies by prefix', () => {
    expect(categoryOf('trigger.message')).toBe('trigger');
    expect(categoryOf('condition.numeric')).toBe('condition');
    expect(categoryOf('action.tapback')).toBe('action');
    expect(categoryOf('flow.collapse')).toBe('flow');
  });
});

describe('validateAutomationGraph', () => {
  it('accepts a minimal valid graph', () => {
    const r = validateAutomationGraph(baseGraph());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.graph).toBeDefined();
  });

  it('accepts an If/ElseIf/Else routing graph (true/false ports)', () => {
    const g: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { regex: '^(test|ping)' } },
        { id: 'c', type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0 } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        { id: 'msg', type: 'action.sendMessage', params: { text: 'pong' } },
      ],
      edges: [
        { from: 't', to: 'c' },
        { from: 'c', to: 'tap', port: 'true' },
        { from: 'c', to: 'msg', port: 'false' },
      ],
    };
    expect(validateAutomationGraph(g).valid).toBe(true);
  });

  it('rejects non-object config', () => {
    expect(validateAutomationGraph(null).valid).toBe(false);
    expect(validateAutomationGraph(42).errors[0]).toMatch(/must be an object/);
  });

  it('rejects malformed top-level shape', () => {
    const r = validateAutomationGraph({ version: 'x', nodes: {}, edges: 1 });
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/version must be a number/),
      expect.stringMatching(/nodes must be an array/),
      expect.stringMatching(/edges must be an array/),
    ]));
  });

  it('requires exactly one trigger', () => {
    const none = baseGraph({
      nodes: [{ id: 'a', type: 'action.tapback' }],
      edges: [],
    });
    expect(validateAutomationGraph(none).errors.join()).toMatch(/exactly one trigger/);

    const two = baseGraph({
      nodes: [
        { id: 't1', type: 'trigger.message' },
        { id: 't2', type: 'trigger.schedule' },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't1', to: 'a' }, { from: 't2', to: 'a' }],
    });
    expect(validateAutomationGraph(two).errors.join()).toMatch(/found 2/);
  });

  it('rejects unknown node types and duplicate ids', () => {
    expect(validateAutomationGraph(baseGraph({
      nodes: [{ id: 't', type: 'trigger.message' }, { id: 'a', type: 'action.bogus' as any }],
      edges: [{ from: 't', to: 'a' }],
    })).errors.join()).toMatch(/unknown type/);

    expect(validateAutomationGraph(baseGraph({
      nodes: [{ id: 'dup', type: 'trigger.message' }, { id: 'dup', type: 'action.tapback' }],
      edges: [],
    })).errors.join()).toMatch(/duplicate node id/);
  });

  it('rejects edges to/from unknown nodes and self-loops', () => {
    expect(validateAutomationGraph(baseGraph({
      edges: [{ from: 't', to: 'ghost' }],
    })).errors.join()).toMatch(/unknown node "ghost"/);

    expect(validateAutomationGraph(baseGraph({
      nodes: [{ id: 't', type: 'trigger.message' }, { id: 'a', type: 'action.tapback' }],
      edges: [{ from: 'a', to: 'a' }],
    })).errors.join()).toMatch(/self-loop/);
  });

  it('rejects ports on non-condition edges and invalid port values', () => {
    expect(validateAutomationGraph(baseGraph({
      edges: [{ from: 't', to: 'a', port: 'true' }],
    })).errors.join()).toMatch(/only allowed on edges leaving a condition/);

    const g = baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'c', type: 'condition.string', params: { op: 'contains', value: 'x' } },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a', port: 'maybe' as any }],
    });
    expect(validateAutomationGraph(g).errors.join()).toMatch(/port must be/);
  });

  it('rejects incoming edges to a trigger', () => {
    const g = baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'a' }, { from: 'a', to: 't' }],
    });
    // a→t also forms a cycle, but the trigger-incoming check fires first
    expect(validateAutomationGraph(g).errors.join()).toMatch(/must not have incoming edges/);
  });

  it('detects cycles', () => {
    const g = baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'a', type: 'flow.fanout' },
        { id: 'b', type: 'flow.fanout' },
      ],
      edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    });
    expect(validateAutomationGraph(g).errors.join()).toMatch(/acyclic/);
  });

  it('flags orphan (unreachable) nodes', () => {
    const g = baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'a', type: 'action.tapback' },
        { id: 'orphan', type: 'action.sendMessage', params: { text: 'hi' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    expect(validateAutomationGraph(g).errors.join()).toMatch(/not reachable from the trigger/);
  });

  it('applies light per-block param checks', () => {
    expect(validateAutomationGraph(baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'c', type: 'flow.collapse', params: { mode: 'MAYBE' } },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a' }],
    })).errors.join()).toMatch(/mode ∈/);

    expect(validateAutomationGraph(baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'v', type: 'flow.setVar', params: {} },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'v' }, { from: 'v', to: 'a' }],
    })).errors.join()).toMatch(/requires params.variable/);
  });
});
