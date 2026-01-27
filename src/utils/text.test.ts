import { describe, it, expect } from 'vitest';
import { getUtf8ByteLength, formatByteCount, isEmoji } from './text';

describe('text utilities', () => {
  describe('getUtf8ByteLength', () => {
    it('should count ASCII characters as 1 byte each', () => {
      expect(getUtf8ByteLength('hello')).toBe(5);
      expect(getUtf8ByteLength('a')).toBe(1);
      expect(getUtf8ByteLength('')).toBe(0);
    });

    it('should count spaces and punctuation correctly', () => {
      expect(getUtf8ByteLength('hello world')).toBe(11);
      expect(getUtf8ByteLength('hello, world!')).toBe(13);
    });

    it('should count multi-byte Unicode characters correctly', () => {
      // Chinese characters are typically 3 bytes each in UTF-8
      expect(getUtf8ByteLength('中')).toBe(3);
      expect(getUtf8ByteLength('中文')).toBe(6);
    });

    it('should count emoji correctly', () => {
      // Simple emoji are typically 4 bytes
      expect(getUtf8ByteLength('😀')).toBe(4);
      // Compound emoji (with ZWJ) are longer
      expect(getUtf8ByteLength('👨‍👩‍👧')).toBeGreaterThan(4);
    });

    it('should handle mixed ASCII and Unicode', () => {
      expect(getUtf8ByteLength('hello 世界')).toBe(12); // 6 ASCII + 6 Chinese
      expect(getUtf8ByteLength('hi 😀')).toBe(7); // 3 ASCII + 4 emoji
    });
  });

  describe('formatByteCount', () => {
    it('should format byte count with default max', () => {
      const result = formatByteCount(50);
      expect(result.text).toBe('50/200');
      expect(result.className).toBe('byte-counter');
    });

    it('should format byte count with custom max', () => {
      const result = formatByteCount(75, 100);
      expect(result.text).toBe('75/100');
      expect(result.className).toBe('byte-counter');
    });

    it('should add warning class at 90% or more', () => {
      const result90 = formatByteCount(180, 200);
      expect(result90.className).toBe('byte-counter byte-counter-warning');

      const result95 = formatByteCount(95, 100);
      expect(result95.className).toBe('byte-counter byte-counter-warning');
    });

    it('should add over class at 100% or more', () => {
      const resultExact = formatByteCount(200, 200);
      expect(resultExact.className).toBe('byte-counter byte-counter-over');

      const resultOver = formatByteCount(250, 200);
      expect(resultOver.className).toBe('byte-counter byte-counter-over');
    });

    it('should handle edge cases', () => {
      const resultZero = formatByteCount(0, 200);
      expect(resultZero.text).toBe('0/200');
      expect(resultZero.className).toBe('byte-counter');

      const resultOne = formatByteCount(1, 1);
      expect(resultOne.className).toBe('byte-counter byte-counter-over');
    });
  });

  describe('isEmoji', () => {
    it('should return true for single emoji', () => {
      expect(isEmoji('😀')).toBe(true);
      expect(isEmoji('🎉')).toBe(true);
      expect(isEmoji('❤')).toBe(true);
      expect(isEmoji('👍')).toBe(true);
    });

    it('should return true for two surrogate pair emoji', () => {
      // Two emoji like 😀😀 are still all-emoji strings
      expect(isEmoji('😀😀')).toBe(true);
      expect(isEmoji('🎉🎊')).toBe(true);
    });

    it('should return false for text', () => {
      expect(isEmoji('hello')).toBe(false);
      expect(isEmoji('abc')).toBe(false);
      expect(isEmoji('A')).toBe(false);
    });

    it('should return false for mixed emoji and text', () => {
      expect(isEmoji('hi😀')).toBe(false);
      expect(isEmoji('😀hi')).toBe(false);
      expect(isEmoji('a😀b')).toBe(false);
    });

    it('should return false for empty or null-ish values', () => {
      expect(isEmoji('')).toBe(false);
      expect(isEmoji(null as unknown as string)).toBe(false);
      expect(isEmoji(undefined as unknown as string)).toBe(false);
    });

    it('should return true for more than 2 emoji', () => {
      expect(isEmoji('😀😀😀')).toBe(true);
      expect(isEmoji('🎉🎊🎁')).toBe(true);
    });

    it('should handle number emoji based on string length', () => {
      // Number emoji like 1️⃣ are complex sequences with length > 2
      // The function checks string length, not grapheme count
      expect(isEmoji('1️⃣')).toBe(false); // length is 3 (digit + variation selector + keycap)
      expect(isEmoji('🔢')).toBe(true);   // single emoji, length 2
    });
  });
});
