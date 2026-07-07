import { describe, it, expect } from 'vitest';
import { compile, decompile, type WorkflowForm } from './compile.js';
import { validateAutomationGraph } from '../../types/automation.js';
import { TRIGGERS } from './catalog.js';

const trig = { type: 'trigger.message', params: { textContains: 'ping' } };
const cond = (value: number) => ({ type: 'condition.numeric', params: { field: 'hops', op: '==', value } });
const tap = { type: 'action.tapback', params: { emoji: '👍' } };
const msg = (text: string) => ({ type: 'action.sendMessage', params: { text } });

function valid(form: WorkflowForm) {
  const g = compile(form);
  const v = validateAutomationGraph(g);
  expect(v.valid, v.errors.join('; ')).toBe(true);
  return g;
}

describe('compile — single rule (linear)', () => {
  it('emits a plain linear chain with no fanout/collapse', () => {
    const g = valid({ trigger: trig, rules: [{ conditions: [cond(0)], actions: [tap] }], combine: null });
    expect(g.nodes.map((n) => n.type)).toEqual(['trigger.message', 'condition.numeric', 'action.tapback']);
    expect(g.nodes.some((n) => n.type === 'flow.fanout')).toBe(false);
    expect(g.edges).toEqual([{ from: 't', to: 'c0' }, { from: 'c0', to: 'a0' }]);
  });

  it('round-trips', () => {
    const form: WorkflowForm = { trigger: trig, rules: [{ conditions: [cond(0)], actions: [tap] }], combine: null };
    const back = decompile(compile(form));
    expect(back).not.toBeNull();
    expect(back!.rules).toHaveLength(1);
    expect(back!.combine).toBeNull();
    expect(back!.rules[0].conditions[0].params).toMatchObject({ field: 'hops', op: '==', value: 0 });
  });
});

describe('compile — multiple rules (fanout)', () => {
  const form: WorkflowForm = {
    trigger: trig,
    rules: [
      { conditions: [cond(0)], actions: [tap] },
      { conditions: [{ type: 'condition.numeric', params: { field: 'hops', op: '>', value: 0 } }], actions: [msg('copy')] },
    ],
    combine: null,
  };

  it('emits a fanout with one branch per rule', () => {
    const g = valid(form);
    expect(g.nodes.find((n) => n.type === 'flow.fanout')).toBeTruthy();
    expect(g.edges).toContainEqual({ from: 't', to: 'f' });
    expect(g.edges).toContainEqual({ from: 'f', to: 'r0c0' });
    expect(g.edges).toContainEqual({ from: 'f', to: 'r1c0' });
  });

  it('round-trips two rules', () => {
    const back = decompile(compile(form));
    expect(back).not.toBeNull();
    expect(back!.rules).toHaveLength(2);
    expect(back!.rules[0].actions[0].type).toBe('action.tapback');
    expect(back!.rules[1].actions[0].type).toBe('action.sendMessage');
    expect(back!.combine).toBeNull();
  });
});

describe('compile — combine (collapse / reduce)', () => {
  const mk = (mode: 'ANY' | 'ALL' | 'NONE'): WorkflowForm => ({
    trigger: trig,
    rules: [
      { conditions: [cond(0)], actions: [tap] },
      { conditions: [cond(1)], actions: [] }, // condition-only rule feeding the combine
    ],
    combine: { mode, actions: [{ type: 'flow.setVar', params: { variable: 'responded', op: 'flag' } }] },
  });

  it.each(['ANY', 'ALL', 'NONE', 'ALWAYS'] as const)('emits a collapse(%s) joining rule tails and round-trips', (mode) => {
    const g = valid(mk(mode));
    const col = g.nodes.find((n) => n.type === 'flow.collapse');
    expect(col?.params).toMatchObject({ mode });
    // both rule tails edge into the collapse
    const intoCol = g.edges.filter((e) => e.to === 'col').map((e) => e.from);
    expect(intoCol).toHaveLength(2);

    const back = decompile(g);
    expect(back).not.toBeNull();
    expect(back!.rules).toHaveLength(2);
    expect(back!.rules[1].actions).toHaveLength(0); // condition-only rule preserved
    expect(back!.combine).toEqual({ mode, actions: [{ type: 'flow.setVar', params: { variable: 'responded', op: 'flag' } }] });
  });
});

describe('compile — geofence shape param round-trips', () => {
  const geoTrig = (shape: unknown) => ({ type: 'trigger.geofence', params: { event: 'enter', shape } });

  it('preserves a nested polygon shape (vertices array survives clean())', () => {
    const shape = { type: 'polygon', vertices: [{ lat: -1, lng: -1 }, { lat: -1, lng: 1 }, { lat: 1, lng: 0 }] };
    const form: WorkflowForm = { trigger: geoTrig(shape), rules: [{ conditions: [], actions: [tap] }], combine: null };
    const g = compile(form);
    expect(g.nodes[0].params).toMatchObject({ event: 'enter', shape });
    const back = decompile(g);
    expect(back).not.toBeNull();
    expect(back!.trigger.params.shape).toEqual(shape);
  });

  it('preserves a nested circle shape', () => {
    const shape = { type: 'circle', center: { lat: 27.95, lng: -82.46 }, radiusKm: 5 };
    const form: WorkflowForm = { trigger: geoTrig(shape), rules: [{ conditions: [], actions: [tap] }], combine: null };
    const back = decompile(compile(form));
    expect(back!.trigger.params.shape).toEqual(shape);
  });
});

describe('decompile — fall-back to null', () => {
  it('null for condition-port branches', () => {
    expect(decompile({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'c', type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0 } },
        { id: 'a', type: 'action.tapback' }, { id: 'b', type: 'action.sendMessage' },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a', port: 'true' }, { from: 'c', to: 'b', port: 'false' }],
    })).toBeNull();
  });

  it('null when a branch itself fans out', () => {
    expect(decompile({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'f', type: 'flow.fanout' },
        { id: 'a', type: 'action.tapback' },
        { id: 'x', type: 'flow.fanout' },
        { id: 'b', type: 'action.sendMessage' }, { id: 'c', type: 'action.notify' },
      ],
      edges: [
        { from: 't', to: 'f' }, { from: 'f', to: 'a' }, { from: 'f', to: 'x' },
        { from: 'x', to: 'b' }, { from: 'x', to: 'c' },
      ],
    })).toBeNull();
  });

  it('null for two collapse nodes', () => {
    expect(decompile({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message' }, { id: 'f', type: 'flow.fanout' },
        { id: 'a', type: 'action.tapback' },
        { id: 'col', type: 'flow.collapse', params: { mode: 'ANY' } },
        { id: 'col2', type: 'flow.collapse', params: { mode: 'ALL' } },
        { id: 'z', type: 'action.notify' },
      ],
      edges: [{ from: 't', to: 'f' }, { from: 'f', to: 'a' }, { from: 'a', to: 'col' }, { from: 'col', to: 'col2' }, { from: 'col2', to: 'z' }],
    })).toBeNull();
  });

  it('recovers a hand-written simple linear graph as one rule (backward-compat)', () => {
    const back = decompile({
      version: 1,
      nodes: [{ id: 't', type: 'trigger.message', params: { textContains: 'ping' } }, { id: 'a', type: 'action.tapback', params: { emoji: '👍' } }],
      edges: [{ from: 't', to: 'a' }],
    });
    expect(back).not.toBeNull();
    expect(back!.rules).toHaveLength(1);
    expect(back!.rules[0].conditions).toHaveLength(0);
    expect(back!.rules[0].actions[0].type).toBe('action.tapback');
  });
});

describe('trigger.message catalog — multi-channel field (#3974)', () => {
  const trigMsg = TRIGGERS.find((t) => t.type === 'trigger.message')!;

  it('exposes a channelMulti "channels" field', () => {
    const f = trigMsg.fields.find((x) => x.name === 'channels');
    expect(f).toBeDefined();
    expect(f!.kind).toBe('channelMulti');
  });

  it('keeps the legacy scalar channelName/channel fields for backward compat', () => {
    expect(trigMsg.fields.some((x) => x.name === 'channelName' && x.kind === 'text')).toBe(true);
    expect(trigMsg.fields.some((x) => x.name === 'channel' && x.kind === 'number')).toBe(true);
  });

  it('round-trips a channels array through compile/decompile', () => {
    const channels = [{ name: 'gauntlet', protocol: 'meshtastic' }, { name: 'ops', protocol: 'meshtastic' }];
    const form: WorkflowForm = {
      trigger: { type: 'trigger.message', params: { channels } },
      rules: [{ conditions: [], actions: [{ type: 'action.tapback', params: { emoji: '👍' } }] }],
      combine: null,
    };
    const back = decompile(compile(form));
    expect(back).not.toBeNull();
    expect(back!.trigger.params).toEqual({ channels });
  });
});
