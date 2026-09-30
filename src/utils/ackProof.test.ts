import { describe, it, expect } from 'vitest';
import {
  AckProofStatus,
  formatAckProofStatus,
  normalizeAckProofStatus,
  readAckProofStatus,
  resolveAckProofStatus,
} from './ackProof';

describe('ackProof (#5279)', () => {
  it('keeps the proto enum numbers', () => {
    expect(AckProofStatus).toEqual({ ABSENT: 0, VALID: 1, INVALID: 2, NO_KEY: 3 });
  });

  it('normalizes numbers, numeric strings and enum names to numbers', () => {
    expect(normalizeAckProofStatus(1)).toBe(1);
    expect(normalizeAckProofStatus(0)).toBe(0);
    expect(normalizeAckProofStatus('3')).toBe(3);
    expect(normalizeAckProofStatus('ACK_PROOF_INVALID')).toBe(2);
    expect(normalizeAckProofStatus('ACK_PROOF_ABSENT')).toBe(0);
  });

  it('returns undefined for absent or unknown values', () => {
    for (const v of [undefined, null, 4, -1, 1.5, '', 'VALID', {}, true]) {
      expect(normalizeAckProofStatus(v)).toBeUndefined();
    }
  });

  it('reads camelCase or snake_case off a decoded packet', () => {
    expect(readAckProofStatus({ ackProofStatus: 1 })).toBe(1);
    expect(readAckProofStatus({ ack_proof_status: 2 })).toBe(2);
    expect(readAckProofStatus({ ackProofStatus: null })).toBeUndefined();
    expect(readAckProofStatus({})).toBeUndefined();
    expect(readAckProofStatus(null)).toBeUndefined();
  });

  it('formats a display label with name and number', () => {
    expect(formatAckProofStatus(1)).toBe('ACK_PROOF_VALID (1)');
    expect(formatAckProofStatus(99)).toBeNull();
  });

  it('resolves a missing field to ABSENT only on 2.8.1+ radios', () => {
    // ABSENT (0) is never encoded on the wire, so the field reads missing.
    expect(resolveAckProofStatus({}, '2.8.1.7fe3176')).toBe(AckProofStatus.ABSENT);
    expect(resolveAckProofStatus({}, '2.9.0')).toBe(AckProofStatus.ABSENT);
    expect(resolveAckProofStatus({}, '2.8.0.47db0e3')).toBeUndefined();
    expect(resolveAckProofStatus({}, undefined)).toBeUndefined();
    expect(resolveAckProofStatus({}, 'garbage')).toBeUndefined();
  });

  it('keeps a reported value regardless of firmware', () => {
    expect(resolveAckProofStatus({ ackProofStatus: 1 }, '2.8.0')).toBe(AckProofStatus.VALID);
    expect(resolveAckProofStatus({ ackProofStatus: 'ACK_PROOF_INVALID' }, undefined)).toBe(AckProofStatus.INVALID);
  });
});
