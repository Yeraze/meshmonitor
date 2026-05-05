/**
 * Unit tests for the shared channel-view projection (MM-SEC-2).
 */

import { describe, it, expect } from 'vitest';
import { transformChannel, getRoleName } from './channelView.js';

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

    it('omits psk', () => {
      const out = transformChannel(dbRow);
      expect(out).not.toHaveProperty('psk');
    });

    it('omits internal/persistence fields', () => {
      const out = transformChannel(dbRow);
      expect(out).not.toHaveProperty('createdAt');
      expect(out).not.toHaveProperty('updatedAt');
      expect(out).not.toHaveProperty('sourceId');
    });

    it('whitelists exactly the expected fields', () => {
      const out = transformChannel(dbRow);
      expect(Object.keys(out).sort()).toEqual(
        [
          'id', 'name', 'role', 'roleName',
          'uplinkEnabled', 'downlinkEnabled', 'positionPrecision', 'pskSet',
        ].sort()
      );
    });

    it('exposes pskSet as a boolean derived from the underlying psk', () => {
      expect(transformChannel({ ...dbRow, psk: 'AdxU...' }).pskSet).toBe(true);
      expect(transformChannel({ ...dbRow, psk: '' }).pskSet).toBe(false);
      expect(transformChannel({ ...dbRow, psk: null }).pskSet).toBe(false);
      expect(transformChannel({ ...dbRow, psk: undefined }).pskSet).toBe(false);
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
