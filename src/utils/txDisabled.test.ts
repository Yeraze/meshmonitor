import { describe, it, expect } from 'vitest';
import { TX_DISABLED_CODE, isTxDisabledBody, isTxDisabledError } from './txDisabled';

describe('txDisabled (#4294)', () => {
  it('exposes the TX_DISABLED code constant', () => {
    expect(TX_DISABLED_CODE).toBe('TX_DISABLED');
  });

  describe('isTxDisabledBody', () => {
    it('is true for a 409 with a matching code', () => {
      expect(isTxDisabledBody(409, { code: 'TX_DISABLED' })).toBe(true);
    });

    it('is true even when the body carries extra fields', () => {
      expect(isTxDisabledBody(409, { code: 'TX_DISABLED', error: 'Transmit is disabled', extra: 1 })).toBe(true);
    });

    it('is false for a non-409 status with a matching code', () => {
      expect(isTxDisabledBody(500, { code: 'TX_DISABLED' })).toBe(false);
      expect(isTxDisabledBody(403, { code: 'TX_DISABLED' })).toBe(false);
      expect(isTxDisabledBody(200, { code: 'TX_DISABLED' })).toBe(false);
    });

    it('is false for a 409 with a different code', () => {
      expect(isTxDisabledBody(409, { code: 'OTHER_ERROR' })).toBe(false);
      expect(isTxDisabledBody(409, { code: '' })).toBe(false);
    });

    it('is false when the body has no code field', () => {
      expect(isTxDisabledBody(409, {})).toBe(false);
    });

    it('is false for non-object bodies', () => {
      expect(isTxDisabledBody(409, null)).toBe(false);
      expect(isTxDisabledBody(409, undefined)).toBe(false);
      expect(isTxDisabledBody(409, 'TX_DISABLED')).toBe(false);
      expect(isTxDisabledBody(409, 42)).toBe(false);
      expect(isTxDisabledBody(409, ['TX_DISABLED'])).toBe(false);
    });
  });

  describe('isTxDisabledError', () => {
    it('is true for a matching {code} shape', () => {
      expect(isTxDisabledError({ code: 'TX_DISABLED' })).toBe(true);
    });

    it('is true for an ApiError-shaped object with extra fields', () => {
      expect(isTxDisabledError({ status: 409, code: 'TX_DISABLED', message: 'Transmit is disabled' })).toBe(true);
    });

    it('is false for a different code', () => {
      expect(isTxDisabledError({ code: 'OTHER_ERROR' })).toBe(false);
    });

    it('is false when there is no code field', () => {
      expect(isTxDisabledError({})).toBe(false);
      expect(isTxDisabledError(new Error('boom'))).toBe(false);
    });

    it('is false for null/undefined/non-objects', () => {
      expect(isTxDisabledError(null)).toBe(false);
      expect(isTxDisabledError(undefined)).toBe(false);
      expect(isTxDisabledError('TX_DISABLED')).toBe(false);
      expect(isTxDisabledError(42)).toBe(false);
    });
  });
});
