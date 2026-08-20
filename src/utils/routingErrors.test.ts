import { describe, it, expect } from 'vitest';
import { getRoutingErrorName } from './routingErrors';

describe('getRoutingErrorName', () => {
  it('resolves NONE for code 0', () => {
    expect(getRoutingErrorName(0)).toBe('NONE');
  });

  it('resolves MAX_RETRANSMIT for code 5', () => {
    expect(getRoutingErrorName(5)).toBe('MAX_RETRANSMIT');
  });

  it('resolves PKI_SEND_FAIL_PUBLIC_KEY for code 39', () => {
    expect(getRoutingErrorName(39)).toBe('PKI_SEND_FAIL_PUBLIC_KEY');
  });

  it('falls back to UNKNOWN_<code> for an unmapped code', () => {
    expect(getRoutingErrorName(99)).toBe('UNKNOWN_99');
  });
});
