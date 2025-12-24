import { describe, it, expect } from 'vitest';
import {
  ipStringToUint32,
  uint32ToIpString,
  convertIpv4ConfigToStrings,
  convertIpv4ConfigToUint32
} from './protobufService.js';

describe('IP Address Conversion Functions', () => {
  describe('ipStringToUint32', () => {
    it('should convert 192.168.1.100 to correct uint32', () => {
      // 192.168.1.100 = (192 << 24) | (168 << 16) | (1 << 8) | 100
      // = 3232235876
      expect(ipStringToUint32('192.168.1.100')).toBe(3232235876);
    });

    it('should convert 0.0.0.0 to 0', () => {
      expect(ipStringToUint32('0.0.0.0')).toBe(0);
    });

    it('should convert 255.255.255.255 to max uint32', () => {
      expect(ipStringToUint32('255.255.255.255')).toBe(4294967295);
    });

    it('should convert 10.0.0.1 correctly', () => {
      // 10.0.0.1 = (10 << 24) | (0 << 16) | (0 << 8) | 1
      // = 167772161
      expect(ipStringToUint32('10.0.0.1')).toBe(167772161);
    });

    it('should convert 172.16.0.1 correctly', () => {
      // 172.16.0.1 = (172 << 24) | (16 << 16) | (0 << 8) | 1
      // = 2886729729
      expect(ipStringToUint32('172.16.0.1')).toBe(2886729729);
    });

    it('should return 0 for invalid IP strings', () => {
      expect(ipStringToUint32('')).toBe(0);
      expect(ipStringToUint32('invalid')).toBe(0);
      expect(ipStringToUint32('192.168.1')).toBe(0);
      expect(ipStringToUint32('192.168.1.1.1')).toBe(0);
      expect(ipStringToUint32('256.0.0.1')).toBe(0);
      expect(ipStringToUint32('-1.0.0.1')).toBe(0);
    });

    it('should return 0 for null/undefined', () => {
      expect(ipStringToUint32(null as any)).toBe(0);
      expect(ipStringToUint32(undefined as any)).toBe(0);
    });
  });

  describe('uint32ToIpString', () => {
    it('should convert 3232235876 to 192.168.1.100', () => {
      expect(uint32ToIpString(3232235876)).toBe('192.168.1.100');
    });

    it('should return empty string for 0', () => {
      expect(uint32ToIpString(0)).toBe('');
    });

    it('should convert max uint32 to 255.255.255.255', () => {
      expect(uint32ToIpString(4294967295)).toBe('255.255.255.255');
    });

    it('should convert 167772161 to 10.0.0.1', () => {
      expect(uint32ToIpString(167772161)).toBe('10.0.0.1');
    });

    it('should convert 2886729729 to 172.16.0.1', () => {
      expect(uint32ToIpString(2886729729)).toBe('172.16.0.1');
    });

    it('should return empty string for null/undefined', () => {
      expect(uint32ToIpString(null as any)).toBe('');
      expect(uint32ToIpString(undefined as any)).toBe('');
    });

    it('should handle negative numbers by treating as unsigned', () => {
      // -1 as signed int32 is 0xFFFFFFFF as unsigned = 255.255.255.255
      expect(uint32ToIpString(-1)).toBe('255.255.255.255');
    });
  });

  describe('round-trip conversion', () => {
    const testIps = [
      '192.168.1.1',
      '10.0.0.1',
      '172.16.0.1',
      '8.8.8.8',
      '255.255.255.0',
      '192.168.0.1',
      '1.2.3.4'
    ];

    testIps.forEach(ip => {
      it(`should round-trip ${ip} correctly`, () => {
        const uint32 = ipStringToUint32(ip);
        const result = uint32ToIpString(uint32);
        expect(result).toBe(ip);
      });
    });
  });

  describe('convertIpv4ConfigToStrings', () => {
    it('should convert all IP fields from uint32 to strings', () => {
      const config = {
        ip: 3232235876,       // 192.168.1.100
        gateway: 3232235777,  // 192.168.1.1
        subnet: 4294967040,   // 255.255.255.0
        dns: 134744072        // 8.8.8.8
      };

      const result = convertIpv4ConfigToStrings(config);

      expect(result.ip).toBe('192.168.1.100');
      expect(result.gateway).toBe('192.168.1.1');
      expect(result.subnet).toBe('255.255.255.0');
      expect(result.dns).toBe('8.8.8.8');
    });

    it('should return empty strings for zero values', () => {
      const config = {
        ip: 0,
        gateway: 0,
        subnet: 0,
        dns: 0
      };

      const result = convertIpv4ConfigToStrings(config);

      expect(result.ip).toBe('');
      expect(result.gateway).toBe('');
      expect(result.subnet).toBe('');
      expect(result.dns).toBe('');
    });

    it('should return null/undefined config as-is', () => {
      expect(convertIpv4ConfigToStrings(null)).toBe(null);
      expect(convertIpv4ConfigToStrings(undefined)).toBe(undefined);
    });
  });

  describe('convertIpv4ConfigToUint32', () => {
    it('should convert all IP fields from strings to uint32', () => {
      const config = {
        ip: '192.168.1.100',
        gateway: '192.168.1.1',
        subnet: '255.255.255.0',
        dns: '8.8.8.8'
      };

      const result = convertIpv4ConfigToUint32(config);

      expect(result.ip).toBe(3232235876);
      expect(result.gateway).toBe(3232235777);
      expect(result.subnet).toBe(4294967040);
      expect(result.dns).toBe(134744072);
    });

    it('should return 0 for empty string values', () => {
      const config = {
        ip: '',
        gateway: '',
        subnet: '',
        dns: ''
      };

      const result = convertIpv4ConfigToUint32(config);

      expect(result.ip).toBe(0);
      expect(result.gateway).toBe(0);
      expect(result.subnet).toBe(0);
      expect(result.dns).toBe(0);
    });

    it('should return null/undefined config as-is', () => {
      expect(convertIpv4ConfigToUint32(null)).toBe(null);
      expect(convertIpv4ConfigToUint32(undefined)).toBe(undefined);
    });
  });

  describe('config round-trip', () => {
    it('should round-trip a complete config correctly', () => {
      const originalConfig = {
        ip: '192.168.1.100',
        gateway: '192.168.1.1',
        subnet: '255.255.255.0',
        dns: '8.8.8.8'
      };

      const asUint32 = convertIpv4ConfigToUint32(originalConfig);
      const backToStrings = convertIpv4ConfigToStrings(asUint32);

      expect(backToStrings).toEqual(originalConfig);
    });
  });
});
