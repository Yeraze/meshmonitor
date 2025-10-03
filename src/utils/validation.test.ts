import { describe, it, expect } from 'vitest';
import {
  sanitizeTextInput,
  validateChannel,
  validateNodeId,
  validateHours,
  validateIntervalMinutes
} from './validation';

describe('Validation Utilities', () => {
  describe('sanitizeTextInput', () => {
    it('should remove control characters', () => {
      const input = 'Hello\x00World\x1F!';
      const result = sanitizeTextInput(input);
      expect(result).toBe('HelloWorld!');
    });

    it('should remove null bytes', () => {
      const input = 'Test\x00Message';
      const result = sanitizeTextInput(input);
      expect(result).toBe('TestMessage');
    });

    it('should trim whitespace', () => {
      const input = '  Hello World  ';
      const result = sanitizeTextInput(input);
      expect(result).toBe('Hello World');
    });

    it('should handle normal text without modification', () => {
      const input = 'Normal message text';
      const result = sanitizeTextInput(input);
      expect(result).toBe('Normal message text');
    });

    it('should preserve Unicode characters', () => {
      const input = 'Hello 世界 🌍';
      const result = sanitizeTextInput(input);
      expect(result).toBe('Hello 世界 🌍');
    });

    it('should limit length to 1000 characters', () => {
      const longInput = 'a'.repeat(1500);
      const result = sanitizeTextInput(longInput);
      expect(result.length).toBe(1000);
    });

    it('should handle empty string', () => {
      expect(sanitizeTextInput('')).toBe('');
    });

    it('should handle non-string input gracefully', () => {
      // @ts-ignore - Testing runtime behavior
      expect(sanitizeTextInput(null)).toBe('');
      // @ts-ignore - Testing runtime behavior
      expect(sanitizeTextInput(undefined)).toBe('');
      // @ts-ignore - Testing runtime behavior
      expect(sanitizeTextInput(123)).toBe('');
    });

    it('should handle strings with only control characters', () => {
      const input = '\x00\x01\x1F';
      const result = sanitizeTextInput(input);
      expect(result).toBe('');
    });

    it('should preserve newlines but remove other control chars', () => {
      // Note: \n is \x0A which is in the control character range
      const input = 'Line1\nLine2\x00Bad';
      const result = sanitizeTextInput(input);
      expect(result).toBe('Line1Line2Bad');
    });

    it('should handle maximum length with trimming', () => {
      // Input: ' ' + 1001 a's + ' ' = 1003 chars total
      // After limiting to 1000: ' ' + 999 a's = 1000 chars
      // After trimming: 999 a's = 999 chars
      const input = ' ' + 'a'.repeat(1001) + ' ';
      const result = sanitizeTextInput(input);
      expect(result.length).toBe(999);
      expect(result).toBe('a'.repeat(999));
    });
  });

  describe('validateChannel', () => {
    it('should accept valid channel numbers 0-7', () => {
      expect(validateChannel(0)).toBe(0);
      expect(validateChannel(1)).toBe(1);
      expect(validateChannel(7)).toBe(7);
    });

    it('should return undefined for undefined input', () => {
      expect(validateChannel(undefined)).toBeUndefined();
    });

    it('should throw error for negative numbers', () => {
      expect(() => validateChannel(-1)).toThrow('Invalid channel number');
    });

    it('should throw error for channels > 7', () => {
      expect(() => validateChannel(8)).toThrow('Invalid channel number');
      expect(() => validateChannel(100)).toThrow('Invalid channel number');
    });

    it('should throw error for non-integers', () => {
      expect(() => validateChannel(1.5)).toThrow('Invalid channel number');
      expect(() => validateChannel(3.14)).toThrow('Invalid channel number');
    });

    it('should throw error for NaN', () => {
      expect(() => validateChannel(NaN)).toThrow('Invalid channel number');
    });

    it('should throw error for Infinity', () => {
      expect(() => validateChannel(Infinity)).toThrow('Invalid channel number');
    });
  });

  describe('validateNodeId', () => {
    it('should accept valid node IDs', () => {
      expect(validateNodeId('!abc12345')).toBe('!abc12345');
      expect(validateNodeId('!DEADBEEF')).toBe('!DEADBEEF');
      expect(validateNodeId('!00000000')).toBe('!00000000');
      expect(validateNodeId('!ffffffff')).toBe('!ffffffff');
    });

    it('should return undefined for undefined input', () => {
      expect(validateNodeId(undefined)).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      expect(validateNodeId('')).toBeUndefined();
    });

    it('should throw error for missing exclamation mark', () => {
      expect(() => validateNodeId('abc12345')).toThrow('Invalid node ID format');
    });

    it('should throw error for wrong length', () => {
      expect(() => validateNodeId('!abc123')).toThrow('Invalid node ID format');
      expect(() => validateNodeId('!abc123456')).toThrow('Invalid node ID format');
    });

    it('should throw error for non-hex characters', () => {
      expect(() => validateNodeId('!abcdefgh')).toThrow('Invalid node ID format');
      expect(() => validateNodeId('!xyz12345')).toThrow('Invalid node ID format');
    });

    it('should accept mixed case hex', () => {
      expect(validateNodeId('!AbCdEf12')).toBe('!AbCdEf12');
      expect(validateNodeId('!aAbBcCdD')).toBe('!aAbBcCdD');
    });

    it('should throw error for special characters', () => {
      expect(() => validateNodeId('!abc@1234')).toThrow('Invalid node ID format');
      expect(() => validateNodeId('!abc-1234')).toThrow('Invalid node ID format');
    });
  });

  describe('validateHours', () => {
    it('should accept valid hour values', () => {
      expect(validateHours(0)).toBe(0);
      expect(validateHours(24)).toBe(24);
      expect(validateHours(168)).toBe(168); // 1 week
      expect(validateHours(8760)).toBe(8760); // 1 year
    });

    it('should throw error for negative values', () => {
      expect(() => validateHours(-1)).toThrow('Invalid hours value');
    });

    it('should throw error for values > 8760', () => {
      expect(() => validateHours(8761)).toThrow('Invalid hours value');
      expect(() => validateHours(10000)).toThrow('Invalid hours value');
    });

    it('should throw error for non-integers', () => {
      expect(() => validateHours(24.5)).toThrow('Invalid hours value');
      expect(() => validateHours(1.1)).toThrow('Invalid hours value');
    });

    it('should throw error for NaN', () => {
      expect(() => validateHours(NaN)).toThrow('Invalid hours value');
    });

    it('should throw error for Infinity', () => {
      expect(() => validateHours(Infinity)).toThrow('Invalid hours value');
    });

    it('should accept boundary values', () => {
      expect(validateHours(0)).toBe(0);
      expect(validateHours(8760)).toBe(8760);
    });
  });

  describe('validateIntervalMinutes', () => {
    it('should accept valid interval values', () => {
      expect(validateIntervalMinutes(1)).toBe(1);
      expect(validateIntervalMinutes(5)).toBe(5);
      expect(validateIntervalMinutes(60)).toBe(60); // 1 hour
      expect(validateIntervalMinutes(1440)).toBe(1440); // 24 hours
    });

    it('should throw error for 0', () => {
      expect(() => validateIntervalMinutes(0)).toThrow('Invalid interval');
    });

    it('should throw error for negative values', () => {
      expect(() => validateIntervalMinutes(-1)).toThrow('Invalid interval');
    });

    it('should throw error for values > 1440', () => {
      expect(() => validateIntervalMinutes(1441)).toThrow('Invalid interval');
      expect(() => validateIntervalMinutes(2000)).toThrow('Invalid interval');
    });

    it('should throw error for non-integers', () => {
      expect(() => validateIntervalMinutes(5.5)).toThrow('Invalid interval');
      expect(() => validateIntervalMinutes(1.1)).toThrow('Invalid interval');
    });

    it('should throw error for NaN', () => {
      expect(() => validateIntervalMinutes(NaN)).toThrow('Invalid interval');
    });

    it('should throw error for Infinity', () => {
      expect(() => validateIntervalMinutes(Infinity)).toThrow('Invalid interval');
    });

    it('should accept common interval values', () => {
      expect(validateIntervalMinutes(3)).toBe(3); // 3 minutes
      expect(validateIntervalMinutes(15)).toBe(15); // 15 minutes
      expect(validateIntervalMinutes(30)).toBe(30); // 30 minutes
    });

    it('should accept boundary values', () => {
      expect(validateIntervalMinutes(1)).toBe(1);
      expect(validateIntervalMinutes(1440)).toBe(1440);
    });
  });
});
