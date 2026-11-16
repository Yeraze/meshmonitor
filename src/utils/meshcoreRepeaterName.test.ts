import { describe, it, expect } from 'vitest';
import { parseRepeaterNameResponse } from './meshcoreRepeaterName.js';

describe('parseRepeaterNameResponse', () => {
  it('parses the two-prompt form the console emits for a named repeater', () => {
    expect(parseRepeaterNameResponse('  -> > LT-KM Seniava 44')).toBe('LT-KM Seniava 44');
  });

  it('parses the single-prompt form', () => {
    expect(parseRepeaterNameResponse('  -> LT-KM Seniava 44')).toBe('LT-KM Seniava 44');
  });

  it('parses a reply that arrives without any prompt prefix', () => {
    expect(parseRepeaterNameResponse('LT-KM Seniava 44')).toBe('LT-KM Seniava 44');
  });

  it('keeps the value when the echoed command shares the buffer', () => {
    expect(parseRepeaterNameResponse('get name\r\n  -> > LT-KM Seniava 44\r\n')).toBe(
      'LT-KM Seniava 44',
    );
  });

  it('ignores the "Unknown command" answer a booting console gives', () => {
    expect(parseRepeaterNameResponse('  -> Unknown command')).toBeNull();
  });

  it('uses the last usable line when a bare prompt follows the value', () => {
    expect(parseRepeaterNameResponse('  -> > LT-KM Seniava 44\n  -> ')).toBe('LT-KM Seniava 44');
  });

  it('strips one pair of surrounding quotes', () => {
    expect(parseRepeaterNameResponse('  -> > "LT-KM Seniava 44"')).toBe('LT-KM Seniava 44');
  });

  it('returns null for an empty reply', () => {
    expect(parseRepeaterNameResponse('')).toBeNull();
    expect(parseRepeaterNameResponse('   \r\n')).toBeNull();
  });

  it('returns null for missing replies', () => {
    expect(parseRepeaterNameResponse(null)).toBeNull();
    expect(parseRepeaterNameResponse(undefined)).toBeNull();
  });

  it('keeps names that merely contain prompt-looking characters', () => {
    expect(parseRepeaterNameResponse('  -> > LT-KM Seniava 44 > 2')).toBe('LT-KM Seniava 44 > 2');
  });
});
