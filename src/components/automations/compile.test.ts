import { describe, it, expect } from 'vitest';
import { compile, decompile, type WorkflowForm } from './compile.js';
import { validateAutomationGraph } from '../../types/automation.js';

const form: WorkflowForm = {
  trigger: { type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: '' } },
  conditions: [
    { type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0 } },
  ],
  actions: [
    { type: 'action.tapback', params: { emoji: '👍' } },
    { type: 'flow.setVar', params: { variable: 'welcomed', op: 'flag' } },
  ],
};

describe('compile', () => {
  it('produces a valid linear graph and drops blank params', () => {
    const g = compile(form);
    const v = validateAutomationGraph(g);
    expect(v.valid).toBe(true);
    const trigger = g.nodes.find((n) => n.id === 't')!;
    expect(trigger.params).toEqual({ textContains: 'ping' }); // blank cooldown dropped
    // linear chain t -> c0 -> a0 -> a1
    expect(g.edges).toEqual([
      { from: 't', to: 'c0' },
      { from: 'c0', to: 'a0' },
      { from: 'a0', to: 'a1' },
    ]);
  });

  it('handles no conditions (trigger straight to actions)', () => {
    const g = compile({ trigger: form.trigger, conditions: [], actions: [{ type: 'action.tapback', params: { emoji: '👍' } }] });
    expect(g.edges).toEqual([{ from: 't', to: 'a0' }]);
    expect(validateAutomationGraph(g).valid).toBe(true);
  });
});

describe('decompile', () => {
  it('round-trips a compiled form', () => {
    const g = compile(form);
    const back = decompile(g);
    expect(back).not.toBeNull();
    expect(back!.trigger.type).toBe('trigger.message');
    expect(back!.conditions).toHaveLength(1);
    expect(back!.actions.map((a) => a.type)).toEqual(['action.tapback', 'flow.setVar']);
  });

  it('returns null for branched graphs (ports)', () => {
    const g = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'c', type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0 } },
        { id: 'a', type: 'action.tapback' },
        { id: 'b', type: 'action.sendMessage' },
      ],
      edges: [
        { from: 't', to: 'c' },
        { from: 'c', to: 'a', port: 'true' },
        { from: 'c', to: 'b', port: 'false' },
      ],
    };
    expect(decompile(g)).toBeNull();
  });

  it('returns null for fanout', () => {
    const g = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'f', type: 'flow.fanout' },
        { id: 'a', type: 'action.tapback' },
        { id: 'b', type: 'action.sendMessage' },
      ],
      edges: [{ from: 't', to: 'f' }, { from: 'f', to: 'a' }, { from: 'f', to: 'b' }],
    };
    expect(decompile(g)).toBeNull();
  });

  it('returns null when a condition follows an action', () => {
    const g = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'a', type: 'action.tapback' },
        { id: 'c', type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0 } },
      ],
      edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'c' }],
    };
    expect(decompile(g)).toBeNull();
  });
});
