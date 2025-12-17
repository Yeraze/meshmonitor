import { describe, it, expect } from 'vitest';
import {
  validateBroadcastInterval,
  validateLatitude,
  validateLongitude,
  validateAltitude,
  validateGpioPin,
  validatePositionConfig,
  validateAdminKey,
  validateAdminKeys,
  type ValidationResult,
  type PositionConfigValidation
} from './adminCommandsValidation';

describe('Admin Commands Validation', () => {
  describe('validateBroadcastInterval', () => {
    it('should accept valid intervals', () => {
      expect(validateBroadcastInterval(0)).toBeUndefined();
      expect(validateBroadcastInterval(32)).toBeUndefined();
      expect(validateBroadcastInterval(60)).toBeUndefined();
      expect(validateBroadcastInterval(3600)).toBeUndefined();
      expect(validateBroadcastInterval(86400)).toBeUndefined();
    });

    it('should reject negative values', () => {
      expect(validateBroadcastInterval(-1)).toBe('Must be between 0 and 86400 seconds (0-24 hours)');
      expect(validateBroadcastInterval(-100)).toBe('Must be between 0 and 86400 seconds (0-24 hours)');
    });

    it('should reject values greater than 86400', () => {
      expect(validateBroadcastInterval(86401)).toBe('Must be between 0 and 86400 seconds (0-24 hours)');
      expect(validateBroadcastInterval(100000)).toBe('Must be between 0 and 86400 seconds (0-24 hours)');
    });

    it('should reject values between 1 and 31 (minimum is 32)', () => {
      expect(validateBroadcastInterval(1)).toBe('Minimum interval is 32 seconds');
      expect(validateBroadcastInterval(15)).toBe('Minimum interval is 32 seconds');
      expect(validateBroadcastInterval(31)).toBe('Minimum interval is 32 seconds');
    });

    it('should accept boundary values', () => {
      expect(validateBroadcastInterval(0)).toBeUndefined();
      expect(validateBroadcastInterval(32)).toBeUndefined();
      expect(validateBroadcastInterval(86400)).toBeUndefined();
    });
  });

  describe('validateLatitude', () => {
    it('should accept valid latitude values', () => {
      expect(validateLatitude(-90)).toBeUndefined();
      expect(validateLatitude(0)).toBeUndefined();
      expect(validateLatitude(90)).toBeUndefined();
      expect(validateLatitude(45.5)).toBeUndefined();
      expect(validateLatitude(-45.5)).toBeUndefined();
    });

    it('should reject values less than -90', () => {
      expect(validateLatitude(-91)).toBe('Latitude must be between -90 and 90 degrees');
      expect(validateLatitude(-100)).toBe('Latitude must be between -90 and 90 degrees');
    });

    it('should reject values greater than 90', () => {
      expect(validateLatitude(91)).toBe('Latitude must be between -90 and 90 degrees');
      expect(validateLatitude(100)).toBe('Latitude must be between -90 and 90 degrees');
    });

    it('should accept boundary values', () => {
      expect(validateLatitude(-90)).toBeUndefined();
      expect(validateLatitude(90)).toBeUndefined();
    });
  });

  describe('validateLongitude', () => {
    it('should accept valid longitude values', () => {
      expect(validateLongitude(-180)).toBeUndefined();
      expect(validateLongitude(0)).toBeUndefined();
      expect(validateLongitude(180)).toBeUndefined();
      expect(validateLongitude(45.5)).toBeUndefined();
      expect(validateLongitude(-45.5)).toBeUndefined();
    });

    it('should reject values less than -180', () => {
      expect(validateLongitude(-181)).toBe('Longitude must be between -180 and 180 degrees');
      expect(validateLongitude(-200)).toBe('Longitude must be between -180 and 180 degrees');
    });

    it('should reject values greater than 180', () => {
      expect(validateLongitude(181)).toBe('Longitude must be between -180 and 180 degrees');
      expect(validateLongitude(200)).toBe('Longitude must be between -180 and 180 degrees');
    });

    it('should accept boundary values', () => {
      expect(validateLongitude(-180)).toBeUndefined();
      expect(validateLongitude(180)).toBeUndefined();
    });
  });

  describe('validateAltitude', () => {
    it('should accept valid altitude values', () => {
      expect(validateAltitude(-500)).toBeUndefined();
      expect(validateAltitude(0)).toBeUndefined();
      expect(validateAltitude(9000)).toBeUndefined();
      expect(validateAltitude(100)).toBeUndefined();
      expect(validateAltitude(-100)).toBeUndefined();
    });

    it('should reject values less than -500', () => {
      expect(validateAltitude(-501)).toBe('Altitude must be between -500 and 9000 meters');
      expect(validateAltitude(-1000)).toBe('Altitude must be between -500 and 9000 meters');
    });

    it('should reject values greater than 9000', () => {
      expect(validateAltitude(9001)).toBe('Altitude must be between -500 and 9000 meters');
      expect(validateAltitude(10000)).toBe('Altitude must be between -500 and 9000 meters');
    });

    it('should accept boundary values', () => {
      expect(validateAltitude(-500)).toBeUndefined();
      expect(validateAltitude(9000)).toBeUndefined();
    });
  });

  describe('validateGpioPin', () => {
    it('should accept valid GPIO pin values', () => {
      expect(validateGpioPin(0)).toBeUndefined();
      expect(validateGpioPin(255)).toBeUndefined();
      expect(validateGpioPin(10)).toBeUndefined();
      expect(validateGpioPin(100)).toBeUndefined();
    });

    it('should accept undefined (optional field)', () => {
      expect(validateGpioPin(undefined)).toBeUndefined();
      // @ts-expect-error - Testing runtime behavior
      expect(validateGpioPin(null)).toBeUndefined();
    });

    it('should reject negative values', () => {
      expect(validateGpioPin(-1)).toBe('GPIO pin must be between 0 and 255');
      expect(validateGpioPin(-100)).toBe('GPIO pin must be between 0 and 255');
    });

    it('should reject values greater than 255', () => {
      expect(validateGpioPin(256)).toBe('GPIO pin must be between 0 and 255');
      expect(validateGpioPin(1000)).toBe('GPIO pin must be between 0 and 255');
    });

    it('should accept boundary values', () => {
      expect(validateGpioPin(0)).toBeUndefined();
      expect(validateGpioPin(255)).toBeUndefined();
    });
  });

  describe('validatePositionConfig', () => {
    it('should accept valid position config', () => {
      const config: PositionConfigValidation = {
        positionBroadcastSecs: 300,
        fixedLatitude: 45.5,
        fixedLongitude: -122.5,
        fixedAltitude: 100
      };
      const result = validatePositionConfig(config);
      expect(result.isValid).toBe(true);
      expect(Object.keys(result.errors)).toHaveLength(0);
    });

    it('should validate all position config fields', () => {
      const config: PositionConfigValidation = {
        positionBroadcastSecs: 300,
        nodeInfoBroadcastSecs: 3600,
        gpsUpdateInterval: 60,
        broadcastSmartMinimumIntervalSecs: 120,
        fixedLatitude: 45.5,
        fixedLongitude: -122.5,
        fixedAltitude: 100,
        rxGpio: 10,
        txGpio: 11,
        gpsEnGpio: 12
      };
      const result = validatePositionConfig(config);
      expect(result.isValid).toBe(true);
      expect(Object.keys(result.errors)).toHaveLength(0);
    });

    it('should detect invalid positionBroadcastSecs', () => {
      const config: PositionConfigValidation = {
        positionBroadcastSecs: 15 // Less than 32
      };
      const result = validatePositionConfig(config);
      expect(result.isValid).toBe(false);
      expect(result.errors.positionBroadcastSecs).toBe('Minimum interval is 32 seconds');
    });

    it('should detect invalid fixedLatitude', () => {
      const config: PositionConfigValidation = {
        fixedLatitude: 91 // Out of range
      };
      const result = validatePositionConfig(config);
      expect(result.isValid).toBe(false);
      expect(result.errors.fixedLatitude).toBe('Latitude must be between -90 and 90 degrees');
    });

    it('should detect invalid fixedLongitude', () => {
      const config: PositionConfigValidation = {
        fixedLongitude: 181 // Out of range
      };
      const result = validatePositionConfig(config);
      expect(result.isValid).toBe(false);
      expect(result.errors.fixedLongitude).toBe('Longitude must be between -180 and 180 degrees');
    });

    it('should detect invalid fixedAltitude', () => {
      const config: PositionConfigValidation = {
        fixedAltitude: 10000 // Out of range
      };
      const result = validatePositionConfig(config);
      expect(result.isValid).toBe(false);
      expect(result.errors.fixedAltitude).toBe('Altitude must be between -500 and 9000 meters');
    });

    it('should detect invalid GPIO pins', () => {
      const config: PositionConfigValidation = {
        rxGpio: 300, // Out of range
        txGpio: -1, // Out of range
        gpsEnGpio: 256 // Out of range
      };
      const result = validatePositionConfig(config);
      expect(result.isValid).toBe(false);
      expect(result.errors.rxGpio).toBe('GPIO pin must be between 0 and 255');
      expect(result.errors.txGpio).toBe('GPIO pin must be between 0 and 255');
      expect(result.errors.gpsEnGpio).toBe('GPIO pin must be between 0 and 255');
    });

    it('should detect multiple validation errors', () => {
      const config: PositionConfigValidation = {
        positionBroadcastSecs: 15, // Invalid
        fixedLatitude: 91, // Invalid
        fixedLongitude: 181, // Invalid
        fixedAltitude: 10000 // Invalid
      };
      const result = validatePositionConfig(config);
      expect(result.isValid).toBe(false);
      expect(Object.keys(result.errors)).toHaveLength(4);
    });

    it('should handle empty config', () => {
      const config: PositionConfigValidation = {};
      const result = validatePositionConfig(config);
      expect(result.isValid).toBe(true);
      expect(Object.keys(result.errors)).toHaveLength(0);
    });

    it('should handle undefined values', () => {
      const config: PositionConfigValidation = {
        positionBroadcastSecs: undefined,
        fixedLatitude: undefined
      };
      const result = validatePositionConfig(config);
      expect(result.isValid).toBe(true);
      expect(Object.keys(result.errors)).toHaveLength(0);
    });
  });

  describe('validateAdminKey', () => {
    it('should accept empty key (will be filtered out)', () => {
      const result = validateAdminKey('');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid base64 key', () => {
      // 32 bytes = 44 base64 characters (including padding)
      const validBase64 = 'base64:' + 'A'.repeat(44);
      const result = validateAdminKey(validBase64);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid base64 key with padding', () => {
      // 32 bytes encoded in base64 = 44 characters (including padding)
      // Using a proper 32-byte base64 string (44 chars total)
      const validBase64 = 'base64:' + 'dGVzdGluZzEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9w'; // 44 chars
      const result = validateAdminKey(validBase64);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid hex key', () => {
      // 32 bytes = 64 hex characters
      const validHex = 'a'.repeat(64);
      const result = validateAdminKey(validHex);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid hex key with 0x prefix', () => {
      const validHex = '0x' + 'a'.repeat(64);
      const result = validateAdminKey(validHex);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid hex key with uppercase', () => {
      const validHex = 'A'.repeat(64);
      const result = validateAdminKey(validHex);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid hex key with mixed case', () => {
      const validHex = 'aAbBcCdD'.repeat(8); // 64 characters
      const result = validateAdminKey(validHex);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject base64 key with invalid characters', () => {
      const invalidBase64 = 'base64:test@123!invalid';
      const result = validateAdminKey(invalidBase64);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Invalid base64 format');
    });

    it('should reject base64 key with wrong length', () => {
      const shortBase64 = 'base64:' + 'A'.repeat(43); // 43 chars instead of 44
      const result = validateAdminKey(shortBase64);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Base64 key must be 44 characters');
    });

    it('should reject base64 key that is too long', () => {
      const longBase64 = 'base64:' + 'A'.repeat(45); // 45 chars instead of 44
      const result = validateAdminKey(longBase64);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Base64 key must be 44 characters');
    });

    it('should reject hex key with invalid characters', () => {
      const invalidHex = 'g'.repeat(64); // 'g' is not valid hex
      const result = validateAdminKey(invalidHex);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Invalid hex format');
    });

    it('should reject hex key with wrong length', () => {
      const shortHex = 'a'.repeat(63); // 63 chars instead of 64
      const result = validateAdminKey(shortHex);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Hex key must be 64 characters');
    });

    it('should reject hex key that is too long', () => {
      const longHex = 'a'.repeat(65); // 65 chars instead of 64
      const result = validateAdminKey(longHex);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Hex key must be 64 characters');
    });

    it('should handle whitespace in key', () => {
      const validHex = '  ' + 'a'.repeat(64) + '  ';
      const result = validateAdminKey(validHex);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject hex key with 0x prefix but wrong length', () => {
      const invalidHex = '0x' + 'a'.repeat(63); // 63 chars after 0x
      const result = validateAdminKey(invalidHex);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Hex key must be 64 characters');
    });
  });

  describe('validateAdminKeys', () => {
    it('should accept empty array', () => {
      const result = validateAdminKeys([]);
      expect(result.isValid).toBe(true);
      expect(Object.keys(result.errors)).toHaveLength(0);
    });

    it('should accept array with empty keys (will be filtered out)', () => {
      const result = validateAdminKeys(['', '  ', '']);
      expect(result.isValid).toBe(true);
      expect(Object.keys(result.errors)).toHaveLength(0);
    });

    it('should accept array with valid keys', () => {
      const validKeys = [
        'base64:' + 'A'.repeat(44),
        'a'.repeat(64),
        '0x' + 'b'.repeat(64)
      ];
      const result = validateAdminKeys(validKeys);
      expect(result.isValid).toBe(true);
      expect(Object.keys(result.errors)).toHaveLength(0);
    });

    it('should detect invalid keys in array', () => {
      const invalidKeys = [
        'base64:' + 'A'.repeat(44), // Valid
        'a'.repeat(63), // Invalid - wrong length
        'g'.repeat(64) // Invalid - wrong characters
      ];
      const result = validateAdminKeys(invalidKeys);
      expect(result.isValid).toBe(false);
      expect(result.errors.adminKey_1).toBeDefined();
      expect(result.errors.adminKey_2).toBeDefined();
    });

    it('should skip empty keys when validating', () => {
      const keys = [
        '', // Empty - skipped
        'a'.repeat(64), // Valid
        '  ', // Empty - skipped
        'base64:' + 'A'.repeat(43) // Invalid
      ];
      const result = validateAdminKeys(keys);
      expect(result.isValid).toBe(false);
      // adminKey_3 because indices 0 and 2 are skipped
      expect(result.errors.adminKey_3).toBeDefined();
    });

    it('should provide error messages for each invalid key', () => {
      const invalidKeys = [
        'base64:' + 'A'.repeat(43), // Invalid length
        'g'.repeat(64), // Invalid characters
        'a'.repeat(63) // Invalid length
      ];
      const result = validateAdminKeys(invalidKeys);
      expect(result.isValid).toBe(false);
      expect(result.errors.adminKey_0).toContain('44 characters');
      expect(result.errors.adminKey_1).toContain('Invalid hex format');
      expect(result.errors.adminKey_2).toContain('64 characters');
    });

    it('should handle mixed valid and invalid keys', () => {
      const keys = [
        'a'.repeat(64), // Valid
        'base64:' + 'A'.repeat(43), // Invalid
        'b'.repeat(64), // Valid
        'g'.repeat(64) // Invalid
      ];
      const result = validateAdminKeys(keys);
      expect(result.isValid).toBe(false);
      expect(result.errors.adminKey_1).toBeDefined();
      expect(result.errors.adminKey_3).toBeDefined();
      expect(result.errors.adminKey_0).toBeUndefined();
      expect(result.errors.adminKey_2).toBeUndefined();
    });
  });
});

