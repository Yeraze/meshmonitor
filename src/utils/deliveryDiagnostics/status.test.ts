import { describe, it, expect } from 'vitest';
import { getMeshtasticDeliveryState, getMeshCoreDeliveryState, getMeshCoreChannelSendState, getOwnMeshCoreChannelSendState, TIMEOUT_MS } from './status';
import { MessageDeliveryState } from '../../types/message';

describe('getMeshtasticDeliveryState', () => {
  const NOW = 1_700_000_000_000;
  const baseMessage = (overrides: Partial<Parameters<typeof getMeshtasticDeliveryState>[0]> = {}) => ({
    ackFailed: false,
    routingErrorReceived: false,
    deliveryState: undefined as MessageDeliveryState | undefined,
    timestamp: new Date(NOW),
    ...overrides,
  });

  it('returns failed when ackFailed is true, even with other fields unset', () => {
    const state = getMeshtasticDeliveryState(baseMessage({ ackFailed: true }), NOW);
    expect(state).toBe('failed');
  });

  it('returns failed when routingErrorReceived is true', () => {
    const state = getMeshtasticDeliveryState(baseMessage({ routingErrorReceived: true }), NOW);
    expect(state).toBe('failed');
  });

  it('returns failed when deliveryState is FAILED', () => {
    const state = getMeshtasticDeliveryState(
      baseMessage({ deliveryState: MessageDeliveryState.FAILED }),
      NOW
    );
    expect(state).toBe('failed');
  });

  it('failed takes priority over confirmed/delivered', () => {
    const state = getMeshtasticDeliveryState(
      baseMessage({ ackFailed: true, deliveryState: MessageDeliveryState.CONFIRMED }),
      NOW
    );
    expect(state).toBe('failed');
  });

  it('returns confirmed when deliveryState is CONFIRMED', () => {
    const state = getMeshtasticDeliveryState(
      baseMessage({ deliveryState: MessageDeliveryState.CONFIRMED }),
      NOW
    );
    expect(state).toBe('confirmed');
  });

  it('returns delivered when deliveryState is DELIVERED', () => {
    const state = getMeshtasticDeliveryState(
      baseMessage({ deliveryState: MessageDeliveryState.DELIVERED }),
      NOW
    );
    expect(state).toBe('delivered');
  });

  it('returns pending when message age is just under the 30s timeout', () => {
    const state = getMeshtasticDeliveryState(
      baseMessage({ timestamp: new Date(NOW - (TIMEOUT_MS - 1)) }),
      NOW
    );
    expect(state).toBe('pending');
  });

  it('returns timeout when message age is exactly at the 30s boundary', () => {
    const state = getMeshtasticDeliveryState(
      baseMessage({ timestamp: new Date(NOW - TIMEOUT_MS) }),
      NOW
    );
    expect(state).toBe('timeout');
  });

  it('returns timeout when message age is well past the 30s boundary', () => {
    const state = getMeshtasticDeliveryState(
      baseMessage({ timestamp: new Date(NOW - TIMEOUT_MS * 10) }),
      NOW
    );
    expect(state).toBe('timeout');
  });

  it('defaults `now` to Date.now() when not passed', () => {
    const state = getMeshtasticDeliveryState(baseMessage({ timestamp: new Date() }));
    expect(state).toBe('pending');
  });
});

describe('getMeshCoreDeliveryState', () => {
  it.each([
    ['sending', 'sending'],
    ['sent', 'sent'],
    ['delivered', 'delivered'],
    ['failed', 'failed'],
  ] as const)('maps deliveryStatus %s to state %s', (status, expected) => {
    expect(getMeshCoreDeliveryState(status)).toBe(expected);
  });

  it('maps undefined deliveryStatus to unknown', () => {
    expect(getMeshCoreDeliveryState(undefined)).toBe('unknown');
  });
});

describe('getMeshCoreChannelSendState (#5682)', () => {
  const SELF = 'a'.repeat(64);
  const sent = { fromPublicKey: SELF, toPublicKey: 'channel-1' };

  it('is sent_to_radio for our channel send with no relay heard', () => {
    expect(getMeshCoreChannelSendState(sent, SELF)).toBe('sent_to_radio');
    expect(getMeshCoreChannelSendState({ ...sent, heardBy: [] }, SELF)).toBe('sent_to_radio');
  });

  it('is relayed once a repeater was heard', () => {
    expect(getMeshCoreChannelSendState({ ...sent, heardBy: [{ hash: '7f' }] }, SELF)).toBe('relayed');
  });

  it('is null for a received channel message, even with our text', () => {
    expect(getMeshCoreChannelSendState({ fromPublicKey: 'channel-1', toPublicKey: 'channel-1' }, SELF)).toBeNull();
    expect(getMeshCoreChannelSendState({ ...sent, fromPublicKey: 'b'.repeat(64) }, SELF)).toBeNull();
  });

  it('is null for a DM and for a room post', () => {
    expect(getMeshCoreChannelSendState({ fromPublicKey: SELF, toPublicKey: 'd'.repeat(64) }, SELF)).toBeNull();
    expect(getMeshCoreChannelSendState({ fromPublicKey: SELF, toPublicKey: 'd'.repeat(64), messageType: 'room_post' }, SELF)).toBeNull();
    expect(getMeshCoreChannelSendState({ fromPublicKey: SELF }, SELF)).toBeNull();
  });

  it('is null when our own key is unknown', () => {
    expect(getMeshCoreChannelSendState(sent, undefined)).toBeNull();
    expect(getMeshCoreChannelSendState(sent, null)).toBeNull();
  });
});

describe('getOwnMeshCoreChannelSendState (#5682)', () => {
  it('reads the channel state without checking the sender', () => {
    expect(getOwnMeshCoreChannelSendState({ toPublicKey: 'channel-0' })).toBe('sent_to_radio');
    expect(getOwnMeshCoreChannelSendState({ toPublicKey: 'channel-0', heardBy: [{ hash: 'a3' }] })).toBe('relayed');
  });

  it('is null for a DM, a room post, and a message with no target', () => {
    expect(getOwnMeshCoreChannelSendState({ toPublicKey: 'd'.repeat(64) })).toBeNull();
    expect(getOwnMeshCoreChannelSendState({ toPublicKey: 'd'.repeat(64), messageType: 'room_post' })).toBeNull();
    expect(getOwnMeshCoreChannelSendState({})).toBeNull();
  });
});
