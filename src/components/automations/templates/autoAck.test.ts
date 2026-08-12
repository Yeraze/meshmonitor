import { describe, it, expect } from 'vitest';
import { autoAckTemplate } from './autoAck';
import { validateAutomationGraph, type AutomationGraph } from '../../../types/automation';
import type { BuiltAutomation } from './types';

function buildOne(values: Record<string, unknown>): BuiltAutomation {
  const built = autoAckTemplate.build(values);
  const arr = Array.isArray(built) ? built : [built];
  expect(arr).toHaveLength(1); // Auto-Ack never produces a pair (unlike a bridge template)
  return arr[0];
}

function node(config: AutomationGraph, id: string) {
  const n = config.nodes.find((x) => x.id === id);
  expect(n, `node "${id}" not found in ${JSON.stringify(config.nodes)}`).toBeDefined();
  return n!;
}

describe('autoAckTemplate', () => {
  it('has the expected template metadata', () => {
    expect(autoAckTemplate.id).toBe('auto-ack');
    expect(autoAckTemplate.tags).toEqual(['Acknowledgement', 'Reply']);
    expect(autoAckTemplate.params.map((p) => p.name)).toEqual(['sourceIds', 'channelFilter', 'ackStyle']);
    // AutomationBuilder.tsx's defaultParams() seeds a select from options[0] —
    // 'hop' must stay first so an un-configured template defaults sanely.
    const ackStyleField = autoAckTemplate.params.find((p) => p.name === 'ackStyle')!;
    expect(ackStyleField.options?.[0]?.value).toBe('hop');
  });

  it('defaults to ackStyle=hop with no source/channel filter', () => {
    const { config } = buildOne({});
    expect(config.nodes.map((n) => n.type)).toEqual(['trigger.message', 'condition.numeric', 'action.tapback']);
    expect(node(config, 't').params).toEqual({ rateLimit: { maxActions: 30, windowSeconds: 60 } });
    expect(node(config, 'c0').params).toEqual({ field: 'zeroHop', op: '==', value: '1' });
    expect(node(config, 'a0').params).toEqual({ emojiMode: 'hopCount' });
    expect(config.edges).toEqual([{ from: 't', to: 'c0' }, { from: 'c0', to: 'a0' }]);
  });

  it('ackStyle=fixed emits action.tapback with no explicit emoji (executor defaults to 👍)', () => {
    const { config } = buildOne({ ackStyle: 'fixed' });
    // No `emoji` key: actionExecutor.ts's action.tapback case already falls back
    // to 👍 when it's absent (`String(p.emoji ?? '👍')`) — duplicating the glyph
    // here would just be a second place for it to drift out of sync.
    expect(node(config, 'a0')).toEqual({ id: 'a0', type: 'action.tapback', params: { emojiMode: 'fixed' } });
  });

  it('ackStyle=text emits action.sendMessage with a hopEmoji reply, threaded via replyToTrigger', () => {
    const { config } = buildOne({ ackStyle: 'text' });
    expect(node(config, 'a0')).toEqual({
      id: 'a0',
      type: 'action.sendMessage',
      params: { text: 'Received ({{ trigger.hopEmoji }})', replyToTrigger: true },
    });
  });

  it('an unrecognised ackStyle value falls back to hop (same as blank)', () => {
    const { config } = buildOne({ ackStyle: 'bogus' });
    expect(node(config, 'a0').params).toEqual({ emojiMode: 'hopCount' });
  });

  it('omits condition.sourceFilter when sourceIds is blank', () => {
    const { config } = buildOne({});
    expect(config.nodes.some((n) => n.type === 'condition.sourceFilter')).toBe(false);
  });

  it('inserts condition.sourceFilter between the trigger and the zeroHop check when sourceIds is set, threading the ids', () => {
    const { config } = buildOne({ sourceIds: ['source-a', 'source-b'] });
    expect(config.nodes.map((n) => n.type)).toEqual([
      'trigger.message', 'condition.sourceFilter', 'condition.numeric', 'action.tapback',
    ]);
    expect(node(config, 'c0')).toEqual({
      id: 'c0', type: 'condition.sourceFilter', params: { sourceIds: ['source-a', 'source-b'] },
    });
    expect(node(config, 'c1').params).toEqual({ field: 'zeroHop', op: '==', value: '1' });
    expect(config.edges).toEqual([
      { from: 't', to: 'c0' }, { from: 'c0', to: 'c1' }, { from: 'c1', to: 'a0' },
    ]);
  });

  it('ignores a non-string/blank entries in sourceIds and still omits sourceFilter for an all-blank list', () => {
    const { config } = buildOne({ sourceIds: ['', null, undefined, 42] });
    expect(config.nodes.some((n) => n.type === 'condition.sourceFilter')).toBe(false);
  });

  it('omits the trigger channels param when channelFilter is blank', () => {
    const { config } = buildOne({});
    expect(node(config, 't').params).not.toHaveProperty('channels');
  });

  it('adds channels to the trigger only when channelFilter is set, leaving the condition chain untouched', () => {
    const { config } = buildOne({ channelFilter: [{ name: 'general' }, { name: 'gauntlet', protocol: 'meshcore' }] });
    expect(node(config, 't').params).toEqual({
      rateLimit: { maxActions: 30, windowSeconds: 60 },
      channels: [{ name: 'general' }, { name: 'gauntlet', protocol: 'meshcore' }],
    });
    // No sourceFilter inserted just because a channel filter was set.
    expect(config.nodes.some((n) => n.type === 'condition.sourceFilter')).toBe(false);
  });

  it('combines a source filter, a channel filter, and a text ack together', () => {
    const { config } = buildOne({
      sourceIds: ['source-a'],
      channelFilter: [{ name: 'general' }],
      ackStyle: 'text',
    });
    expect(config.nodes.map((n) => n.type)).toEqual([
      'trigger.message', 'condition.sourceFilter', 'condition.numeric', 'action.sendMessage',
    ]);
    expect(node(config, 't').params.channels).toEqual([{ name: 'general' }]);
    expect(node(config, 'c0').params).toEqual({ sourceIds: ['source-a'] });
    expect(node(config, 'a0').type).toBe('action.sendMessage');
  });

  it('never emits a portnum trigger param (would silently make the rule Meshtastic-only)', () => {
    const { config } = buildOne({});
    expect(node(config, 't').params).not.toHaveProperty('portnum');
  });

  it('always sets the default flood-guard rateLimit on the trigger', () => {
    for (const values of [{}, { sourceIds: ['s1'] }, { ackStyle: 'text' as const }]) {
      const { config } = buildOne(values);
      expect(node(config, 't').params.rateLimit).toEqual({ maxActions: 30, windowSeconds: 60 });
    }
  });

  it('every edge leaving a condition node is an implicit-true gate (no `port` field) — compile()\'s minimal linear chain never emits ports; graphEvaluator.ts treats an unported edge from a condition identically to an explicit port:\'true\' gate', () => {
    for (const values of [{}, { sourceIds: ['s1'] }, { channelFilter: [{ name: 'general' }] }, { sourceIds: ['s1'], channelFilter: [{ name: 'general' }], ackStyle: 'text' as const }]) {
      const { config } = buildOne(values);
      for (const edge of config.edges) {
        expect(edge).not.toHaveProperty('port');
      }
    }
  });

  it('always validates', () => {
    for (const values of [
      {},
      { ackStyle: 'hop' },
      { ackStyle: 'fixed' },
      { ackStyle: 'text' },
      { sourceIds: ['source-a'] },
      { channelFilter: [{ name: 'general' }] },
      { sourceIds: ['source-a'], channelFilter: [{ name: 'general' }], ackStyle: 'text' as const },
    ]) {
      const { config } = buildOne(values);
      const result = validateAutomationGraph(config);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    }
  });
});
