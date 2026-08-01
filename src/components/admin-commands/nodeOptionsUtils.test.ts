import { describe, expect, it } from 'vitest';
import { shouldApplyOptimisticNodeState } from './nodeOptionsUtils';

describe('shouldApplyOptimisticNodeState', () => {
  it('allows local sends and confirmed remote ACKs', () => {
    expect(shouldApplyOptimisticNodeState()).toBe(true);
    expect(shouldApplyOptimisticNodeState({
      acked: true,
      timedOut: false,
      errorReason: null,
      status: 'confirmed',
    })).toBe(true);
  });

  it('keeps the optimistic favorite/ignore state after an uncertain ACK timeout', () => {
    expect(shouldApplyOptimisticNodeState({
      acked: false,
      timedOut: true,
      errorReason: null,
      status: 'timeout',
    })).toBe(true);
  });

  it('does not update favorite/ignore state after an explicit routing rejection', () => {
    expect(shouldApplyOptimisticNodeState({
      acked: false,
      timedOut: false,
      errorReason: 5,
      status: 'MAX_RETRANSMIT',
    })).toBe(false);
  });
});
