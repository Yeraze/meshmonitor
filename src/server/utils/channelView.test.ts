/**
 * Unit tests for the shared channel-view projection (MM-SEC-2 + #2951).
 */

import { describe, it, expect } from 'vitest';
import {
  transformChannel,
  getRoleName,
  getEncryptionStatus,
  DEFAULT_PUBLIC_PSK,
} from './channelView.js';

describe('channelView', () => {
  describe('getRoleName', () => {
    it('maps known roles', () => {
      expect(getRoleName(0)).toBe('Disabled');
      expect(getRoleName(1)).toBe('Primary');
      expect(getRoleName(2)).toBe('Secondary');
    });
    it('falls back to Unknown for unmapped roles', () => {
      expect(getRoleName(undefined)).toBe('Unknown');
      expect(getRoleName(99)).toBe('Unknown');
    });
  });

  describe('getEncryptionStatus', () => {
    it('returns "none" for missing/empty psk', () => {
      expect(getEncryptionStatus(undefined)).toBe('none');
      expect(getEncryptionStatus(null)).toBe('none');
      expect(getEncryptionStatus('')).toBe('none');
    });
    it('returns "default" for the publicly known default key', () => {
      expect(getEncryptionStatus(DEFAULT_PUBLIC_PSK)).toBe('default');
      expect(getEncryptionStatus('AQ==')).toBe('default');
    });
    it('returns "secure" for any other key', () => {
      expect(getEncryptionStatus('AdxUQpUaswPOlEvZIWNryuMxW8KmsooSIB0LsDYWQ4Y=')).toBe('secure');
      expect(getEncryptionStatus('shorthand')).toBe('secure');
    });
  });

  describe('transformChannel', () => {
    const dbRow = {
      id: 0,
      name: 'PrimaryChan',
      psk: 'AdxUQpUaswPOlEvZIWNryuMxW8KmsooSIB0LsDYWQ4Y=',
      role: 1,
      uplinkEnabled: true,
      downlinkEnabled: false,
      positionPrecision: 14,
      // extra fields that should never surface
      createdAt: 1700000000000,
      updatedAt: 1700000010000,
      sourceId: 'src-uuid',
    };

    it('omits psk by default', () => {
      const out = transformChannel(dbRow);
      expect(out).not.toHaveProperty('psk');
    });

    it('omits internal/persistence fields', () => {
      const out = transformChannel(dbRow);
      expect(out).not.toHaveProperty('createdAt');
      expect(out).not.toHaveProperty('updatedAt');
      expect(out).not.toHaveProperty('sourceId');
    });

    it('whitelists exactly the expected fields when psk is omitted', () => {
      const out = transformChannel(dbRow);
      expect(Object.keys(out).sort()).toEqual(
        [
          'id', 'name', 'role', 'roleName',
          'uplinkEnabled', 'downlinkEnabled', 'positionPrecision',
          'pskSet', 'encryptionStatus',
        ].sort()
      );
    });

    it('includes psk only when includePsk: true is passed', () => {
      const omitted = transformChannel(dbRow);
      expect(omitted).not.toHaveProperty('psk');

      const included = transformChannel(dbRow, { includePsk: true });
      expect(included).toHaveProperty('psk');
      expect((included as any).psk).toBe(dbRow.psk);
    });

    it('returns null psk when includePsk: true and the row has no psk', () => {
      const included = transformChannel({ ...dbRow, psk: null }, { includePsk: true });
      expect((included as any).psk).toBeNull();
      const includedUndef = transformChannel({ ...dbRow, psk: undefined }, { includePsk: true });
      expect((includedUndef as any).psk).toBeNull();
    });

    it('exposes pskSet as a boolean derived from the underlying psk', () => {
      expect(transformChannel({ ...dbRow, psk: 'AdxU...' }).pskSet).toBe(true);
      expect(transformChannel({ ...dbRow, psk: '' }).pskSet).toBe(false);
      expect(transformChannel({ ...dbRow, psk: null }).pskSet).toBe(false);
      expect(transformChannel({ ...dbRow, psk: undefined }).pskSet).toBe(false);
    });

    it('exposes encryptionStatus derived from the underlying psk', () => {
      expect(transformChannel({ ...dbRow, psk: '' }).encryptionStatus).toBe('none');
      expect(transformChannel({ ...dbRow, psk: null }).encryptionStatus).toBe('none');
      expect(transformChannel({ ...dbRow, psk: undefined }).encryptionStatus).toBe('none');
      expect(transformChannel({ ...dbRow, psk: 'AQ==' }).encryptionStatus).toBe('default');
      expect(transformChannel({ ...dbRow, psk: 'custom-key' }).encryptionStatus).toBe('secure');
    });

    it('encryptionStatus is present even when the actual psk is omitted', () => {
      // Issue #2951: read-only viewers must still get an accurate encryption
      // badge without ever receiving the key itself.
      const out = transformChannel({ ...dbRow, psk: 'CustomKey123=' });
      expect(out).not.toHaveProperty('psk');
      expect(out.encryptionStatus).toBe('secure');
      expect(out.pskSet).toBe(true);
    });

    it('annotates roleName from role', () => {
      expect(transformChannel({ ...dbRow, role: 1 }).roleName).toBe('Primary');
      expect(transformChannel({ ...dbRow, role: 2 }).roleName).toBe('Secondary');
      expect(transformChannel({ ...dbRow, role: 0 }).roleName).toBe('Disabled');
    });

    it('preserves false / 0 values for boolean and numeric fields', () => {
      const out = transformChannel({
        id: 5,
        name: '',
        psk: 'leak-me',
        role: 2,
        uplinkEnabled: false,
        downlinkEnabled: false,
        positionPrecision: 0,
      });
      expect(out.id).toBe(5);
      expect(out.name).toBe('');
      expect(out.uplinkEnabled).toBe(false);
      expect(out.downlinkEnabled).toBe(false);
      expect(out.positionPrecision).toBe(0);
      expect(out).not.toHaveProperty('psk');
    });
  });
});
