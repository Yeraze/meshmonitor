/**
 * emptySendFinding / validateAutomationGraph warnings (#5697): an action whose
 * text is empty saves (the user may be drafting) but is never silent.
 */
import { describe, it, expect } from 'vitest';
import { emptySendFinding, analyzeEmptySends, validateAutomationGraph } from './automation';

function graph(action: { type: string; params?: Record<string, unknown> }) {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.message', params: {} },
      { id: 'a', type: action.type, params: action.params ?? {} },
    ],
    edges: [{ from: 't', to: 'a' }],
  };
}

describe('emptySendFinding (#5697)', () => {
  it('flags a blank or absent message', () => {
    expect(emptySendFinding('action.sendMessage', { text: '' })?.sendsNothing).toBe(true);
    expect(emptySendFinding('action.sendMessage', { text: '   ' })?.sendsNothing).toBe(true);
    expect(emptySendFinding('action.sendMessage', {})?.fields).toEqual(['text']);
    expect(emptySendFinding('action.sendMessage', { text: '{{ node.longName }}' })).toBeUndefined();
  });

  it('follows the engine on notifications: an absent title still sends', () => {
    expect(emptySendFinding('action.notify', { body: '' })).toMatchObject({ fields: ['body'], sendsNothing: false });
    expect(emptySendFinding('action.notify', { title: '', body: '' })).toMatchObject({ fields: ['title', 'body'], sendsNothing: true });
    expect(emptySendFinding('action.notify', { title: '', body: 'x' })).toBeUndefined();
  });

  it('flags a blank fixed tapback emoji only', () => {
    expect(emptySendFinding('action.tapback', { emoji: ' ' })?.sendsNothing).toBe(true);
    expect(emptySendFinding('action.tapback', {})).toBeUndefined(); // engine defaults to 👍
    expect(emptySendFinding('action.tapback', { emojiMode: 'hopCount', emoji: '' })).toBeUndefined();
  });

  it('ignores other actions', () => {
    expect(emptySendFinding('action.nothing', {})).toBeUndefined();
  });
});

describe('validateAutomationGraph empty-send warnings (#5697)', () => {
  it('saves an empty message but returns a warning', () => {
    const r = validateAutomationGraph(graph({ type: 'action.sendMessage', params: { text: '' } }));
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual(['action.sendMessage "a": the message is empty, so this step will send nothing']);
  });

  it('returns no warnings for a message with text', () => {
    const r = validateAutomationGraph(graph({ type: 'action.sendMessage', params: { text: 'hi' } }));
    expect(r.warnings).toBeUndefined();
  });

  it('analyzeEmptySends lists one line per affected action', () => {
    expect(analyzeEmptySends({ nodes: [
      { id: 'x', type: 'action.sendMessage', params: {} },
      { id: 'y', type: 'action.notify', params: { title: 'T', body: 'B' } },
    ] } as never)).toHaveLength(1);
  });
});
