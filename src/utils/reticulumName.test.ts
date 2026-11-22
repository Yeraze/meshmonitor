import { describe, it, expect } from 'vitest';
import { sanitizeReticulumName, shortReticulumHash } from './reticulumName.js';

describe('sanitizeReticulumName', () => {
  it('cuts at NUL, collapses whitespace controls, trims', () => {
    expect(sanitizeReticulumName('Bob\u0000junk')).toBe('Bob');
    expect(sanitizeReticulumName('  a\tb\nc  ')).toBe('a b c');
  });
  it('drops names with control chars or U+FFFD', () => {
    expect(sanitizeReticulumName('a\u0007b')).toBeNull();
    expect(sanitizeReticulumName('a�b')).toBeNull();
  });
  it('returns null when empty or not a string', () => {
    expect(sanitizeReticulumName('   ')).toBeNull();
    expect(sanitizeReticulumName('\u0000x')).toBeNull();
    expect(sanitizeReticulumName(null)).toBeNull();
  });
  it('caps at 64 code points', () => {
    expect(Array.from(sanitizeReticulumName('😀'.repeat(100))!).length).toBe(64);
  });
});

describe('shortReticulumHash', () => {
  it('keeps 8 hex chars', () => {
    expect(shortReticulumHash('0123456789abcdef')).toBe('01234567…');
  });
});
