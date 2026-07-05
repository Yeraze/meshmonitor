import { describe, it, expect } from 'vitest';
import { getMessageContentMatchNodeIds } from './messageContentFilter';
import type { MeshMessage } from '../types/message';

/** Minimal DM message factory with the fields the filter inspects. */
function dm(overrides: Partial<MeshMessage>): MeshMessage {
  return {
    id: Math.random().toString(36).slice(2),
    from: '!aaaa0001',
    to: '!bbbb0002',
    fromNodeId: '!aaaa0001',
    toNodeId: '!bbbb0002',
    text: '',
    channel: -1,
    portnum: 1,
    timestamp: new Date(),
    ...overrides,
  };
}

describe('getMessageContentMatchNodeIds', () => {
  it('returns an empty set when the term is shorter than minLength', () => {
    const messages = [dm({ text: 'pizza party tonight' })];
    expect(getMessageContentMatchNodeIds(messages, 'p').size).toBe(0);
    expect(getMessageContentMatchNodeIds(messages, '').size).toBe(0);
    expect(getMessageContentMatchNodeIds(messages, '   ').size).toBe(0);
  });

  it('matches message body case-insensitively and returns both parties', () => {
    const messages = [dm({ from: '!aaaa0001', to: '!bbbb0002', text: 'Pizza party tonight' })];
    const ids = getMessageContentMatchNodeIds(messages, 'PIZZA');
    expect(ids.has('!aaaa0001')).toBe(true);
    expect(ids.has('!bbbb0002')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('matches on substrings, not just whole words', () => {
    const messages = [dm({ text: 'meet at the trailhead' })];
    expect(getMessageContentMatchNodeIds(messages, 'trail').size).toBe(2);
  });

  it('ignores broadcast messages (to === !ffffffff)', () => {
    const messages = [dm({ to: '!ffffffff', text: 'pizza for everyone' })];
    expect(getMessageContentMatchNodeIds(messages, 'pizza').size).toBe(0);
  });

  it('ignores channel messages (channel !== -1)', () => {
    const messages = [dm({ channel: 0, text: 'pizza in channel' })];
    expect(getMessageContentMatchNodeIds(messages, 'pizza').size).toBe(0);
  });

  it('ignores non-text portnums', () => {
    const messages = [dm({ portnum: 3, text: 'pizza telemetry' })];
    expect(getMessageContentMatchNodeIds(messages, 'pizza').size).toBe(0);
  });

  it('ignores messages with no matching text', () => {
    const messages = [dm({ text: 'hello world' })];
    expect(getMessageContentMatchNodeIds(messages, 'pizza').size).toBe(0);
  });

  it('handles empty / missing text safely', () => {
    const messages = [dm({ text: '' }), dm({ text: undefined as unknown as string })];
    expect(getMessageContentMatchNodeIds(messages, 'pizza').size).toBe(0);
  });

  it('aggregates matches across multiple conversations', () => {
    const messages = [
      dm({ from: '!aaaa0001', to: '!bbbb0002', text: 'pizza tonight' }),
      dm({ from: '!cccc0003', to: '!aaaa0001', text: 'want pizza?' }),
      dm({ from: '!dddd0004', to: '!aaaa0001', text: 'tacos instead' }),
    ];
    const ids = getMessageContentMatchNodeIds(messages, 'pizza');
    expect(ids.has('!aaaa0001')).toBe(true);
    expect(ids.has('!bbbb0002')).toBe(true);
    expect(ids.has('!cccc0003')).toBe(true);
    expect(ids.has('!dddd0004')).toBe(false);
  });

  it('respects a custom minLength', () => {
    const messages = [dm({ text: 'ok' })];
    expect(getMessageContentMatchNodeIds(messages, 'ok', 3).size).toBe(0);
    expect(getMessageContentMatchNodeIds(messages, 'ok', 2).size).toBe(2);
  });
});
