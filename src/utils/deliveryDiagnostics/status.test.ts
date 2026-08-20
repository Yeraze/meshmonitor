import { describe, it, expect } from 'vitest';
import { getMeshtasticDeliveryState, getMeshCoreDeliveryState, TIMEOUT_MS } from './status';
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
