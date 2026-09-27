import { describe, it, expect } from 'vitest';
import { findAutomationsNamingSlots } from './meshcoreChannelRemapService.js';

const auto = (id: string, nodes: unknown[]) => ({ id, name: `auto ${id}`, config: JSON.stringify({ version: 1, nodes, edges: [] }) });

describe('findAutomationsNamingSlots (#5379)', () => {
  it('flags a numeric channel on a message trigger or legacy send action', () => {
    const res = findAutomationsNamingSlots([
      auto('t', [{ id: 'n1', type: 'trigger.message', params: { channel: 2 } }]),
      auto('s', [{ id: 'n1', type: 'action.sendMessage', params: { channel: '3' } }]),
    ], new Set([2, 3]));
    expect(res).toEqual([
      { id: 't', name: 'auto t', slots: [2] },
      { id: 's', name: 'auto s', slots: [3] },
    ]);
  });

  it('ignores name-based picks, unmoved slots, other node types and bad JSON', () => {
    const res = findAutomationsNamingSlots([
      auto('byName', [{ id: 'n', type: 'trigger.message', params: { channel: 2, channels: [{ name: 'ops', protocol: 'meshcore' }] } }]),
      auto('legacyName', [{ id: 'n', type: 'trigger.message', params: { channel: 2, channelName: 'ops' } }]),
      auto('unmoved', [{ id: 'n', type: 'trigger.message', params: { channel: 5 } }]),
      auto('other', [{ id: 'n', type: 'action.requestData', params: { channel: 2 } }]),
      { id: 'bad', name: 'bad', config: '{nope' },
    ], new Set([2]));
    expect(res).toEqual([]);
  });
});
