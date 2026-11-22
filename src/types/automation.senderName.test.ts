import { describe, it, expect } from 'vitest';
import { validateAutomationGraph } from './automation';

const graph = (senderName: unknown) => ({
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.message', params: {} },
    { id: 'a', type: 'action.sendMessage', params: { text: 'hi', ...(senderName === undefined ? {} : { senderName }) } },
  ],
  edges: [{ from: 't', to: 'a' }],
});

describe('action.sendMessage senderName validation (#6341 P4)', () => {
  it('accepts absent, blank and a valid name', () => {
    for (const v of [undefined, '', '  ', 'Alerts Bot']) {
      const r = validateAutomationGraph(graph(v));
      expect(r.valid, JSON.stringify(r)).toBe(true);
    }
  });
  it('rejects a bad name and a non-string', () => {
    for (const v of ['a: b', '#room', 'x'.repeat(40), 5]) {
      const r = validateAutomationGraph(graph(v));
      expect(r.valid).toBe(false);
    }
  });
});
