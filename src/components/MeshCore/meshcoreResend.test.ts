import { describe, it, expect } from 'vitest';
import { resendAvailability } from './meshcoreResend';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'a'.repeat(64);
const NOW = 10_000_000;
const own = (extra: Partial<MeshCoreMessage> = {}): MeshCoreMessage => ({
  id: 'm1', fromPublicKey: SELF, toPublicKey: 'channel-1', text: 'hi',
  timestamp: NOW - 120_000, senderTimestamp: 1, ...extra,
});

describe('resendAvailability', () => {
  it('offers resend on our own channel send', () => {
    expect(resendAvailability(own(), SELF, NOW).kind).toBe('ready');
  });
  it('never offers resend on a reaction row', () => {
    expect(resendAvailability(own({ reactionEmoji: '👍' }), SELF, NOW).kind).toBe('never');
  });
});
