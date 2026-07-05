import { describe, it, expect } from 'vitest';
import {
  getMessageContentMatchNodeIds,
  getMeshCoreMessageContentMatchKeys,
  type MeshCoreContentMessage,
} from './messageContentFilter';
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

/** Minimal MeshCore DM message factory with the fields the filter inspects. */
function mcdm(overrides: Partial<MeshCoreContentMessage>): MeshCoreContentMessage {
  return {
    fromPublicKey: 'aaaa0001',
    toPublicKey: 'bbbb0002',
    text: '',
    messageType: 'text',
    ...overrides,
  };
}

describe('getMeshCoreMessageContentMatchKeys', () => {
  it('returns an empty set when the term is shorter than minLength', () => {
    const messages = [mcdm({ text: 'pizza party tonight' })];
    expect(getMeshCoreMessageContentMatchKeys(messages, 'p').size).toBe(0);
    expect(getMeshCoreMessageContentMatchKeys(messages, '').size).toBe(0);
    expect(getMeshCoreMessageContentMatchKeys(messages, '   ').size).toBe(0);
  });

  it('matches message body case-insensitively and returns both parties', () => {
    const messages = [mcdm({ fromPublicKey: 'aaaa0001', toPublicKey: 'bbbb0002', text: 'Pizza party tonight' })];
    const keys = getMeshCoreMessageContentMatchKeys(messages, 'PIZZA');
    expect(keys.has('aaaa0001')).toBe(true);
    expect(keys.has('bbbb0002')).toBe(true);
    expect(keys.size).toBe(2);
  });

  it('matches on substrings, not just whole words', () => {
    const messages = [mcdm({ text: 'meet at the trailhead' })];
    expect(getMeshCoreMessageContentMatchKeys(messages, 'trail').size).toBe(2);
  });

  it('ignores room posts (messageType === room_post)', () => {
    const messages = [mcdm({ messageType: 'room_post', text: 'pizza in the room' })];
    expect(getMeshCoreMessageContentMatchKeys(messages, 'pizza').size).toBe(0);
  });

  it('ignores messages with no toPublicKey', () => {
    const messages = [mcdm({ toPublicKey: undefined, text: 'pizza broadcast' })];
    expect(getMeshCoreMessageContentMatchKeys(messages, 'pizza').size).toBe(0);
  });

  it('ignores channel pseudo-key messages when isChannelKey is supplied', () => {
    const isChannelKey = (k: string) => k.startsWith('channel-');
    const messages = [
      mcdm({ fromPublicKey: 'channel-0', toPublicKey: 'channel-0', text: 'pizza in channel' }),
      mcdm({ fromPublicKey: 'aaaa0001', toPublicKey: 'channel-1', text: 'pizza to channel' }),
    ];
    expect(getMeshCoreMessageContentMatchKeys(messages, 'pizza', { isChannelKey }).size).toBe(0);
  });

  it('ignores messages with no matching text', () => {
    const messages = [mcdm({ text: 'hello world' })];
    expect(getMeshCoreMessageContentMatchKeys(messages, 'pizza').size).toBe(0);
  });

  it('handles empty / missing text safely', () => {
    const messages = [mcdm({ text: '' }), mcdm({ text: undefined })];
    expect(getMeshCoreMessageContentMatchKeys(messages, 'pizza').size).toBe(0);
  });

  it('aggregates matches across multiple conversations', () => {
    const messages = [
      mcdm({ fromPublicKey: 'aaaa0001', toPublicKey: 'bbbb0002', text: 'pizza tonight' }),
      mcdm({ fromPublicKey: 'cccc0003', toPublicKey: 'aaaa0001', text: 'want pizza?' }),
      mcdm({ fromPublicKey: 'dddd0004', toPublicKey: 'aaaa0001', text: 'tacos instead' }),
    ];
    const keys = getMeshCoreMessageContentMatchKeys(messages, 'pizza');
    expect(keys.has('aaaa0001')).toBe(true);
    expect(keys.has('bbbb0002')).toBe(true);
    expect(keys.has('cccc0003')).toBe(true);
    expect(keys.has('dddd0004')).toBe(false);
  });

  it('canonicalizes prefix keys via the supplied callback', () => {
    // Inbound messages arrive with a short pubkey prefix; canonicalize maps it
    // to the full contact key so match keys align with the DM list.
    const canonicalize = (k: string) => (k === 'bbbb' ? 'bbbb0002ffffffff' : k);
    const messages = [mcdm({ fromPublicKey: 'aaaa0001', toPublicKey: 'bbbb', text: 'pizza time' })];
    const keys = getMeshCoreMessageContentMatchKeys(messages, 'pizza', { canonicalize });
    expect(keys.has('bbbb0002ffffffff')).toBe(true);
    expect(keys.has('bbbb')).toBe(false);
  });

  it('respects a custom minLength', () => {
    const messages = [mcdm({ text: 'ok' })];
    expect(getMeshCoreMessageContentMatchKeys(messages, 'ok', { minLength: 3 }).size).toBe(0);
    expect(getMeshCoreMessageContentMatchKeys(messages, 'ok', { minLength: 2 }).size).toBe(2);
  });
});
