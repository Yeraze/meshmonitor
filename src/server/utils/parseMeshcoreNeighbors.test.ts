import { describe, it, expect } from 'vitest';
import { parseMeshcoreNeighborsResponse } from './parseMeshcoreNeighbors.js';

describe('parseMeshcoreNeighborsResponse', () => {
  it('parses a single neighbor line', () => {
    const result = parseMeshcoreNeighborsResponse('a1b2c3d4:120:40');
    expect(result).toEqual([
      { pubkeyPrefix: 'a1b2c3d4', lastHeardSecondsAgo: 120, snr: 10 },
    ]);
  });

  it('parses multiple neighbor lines', () => {
    const result = parseMeshcoreNeighborsResponse(
      'a1b2c3d4:120:40\ne5f6a7b8:3600:-8',
    );
    expect(result).toEqual([
      { pubkeyPrefix: 'a1b2c3d4', lastHeardSecondsAgo: 120, snr: 10 },
      { pubkeyPrefix: 'e5f6a7b8', lastHeardSecondsAgo: 3600, snr: -2 },
    ]);
  });

  it('returns empty array for -none-', () => {
    expect(parseMeshcoreNeighborsResponse('-none-')).toEqual([]);
  });

  it('returns null for not supported', () => {
    expect(parseMeshcoreNeighborsResponse('not supported')).toBeNull();
  });

  it('returns empty array for empty string', () => {
    expect(parseMeshcoreNeighborsResponse('')).toEqual([]);
  });

  it('returns empty array for whitespace-only', () => {
    expect(parseMeshcoreNeighborsResponse('  \n  ')).toEqual([]);
  });

  it('skips malformed lines', () => {
    const result = parseMeshcoreNeighborsResponse(
      'a1b2c3d4:120:40\nbadline\ne5f6a7b8:3600:-8',
    );
    expect(result).toEqual([
      { pubkeyPrefix: 'a1b2c3d4', lastHeardSecondsAgo: 120, snr: 10 },
      { pubkeyPrefix: 'e5f6a7b8', lastHeardSecondsAgo: 3600, snr: -2 },
    ]);
  });

  it('skips lines with invalid pubkey prefix', () => {
    const result = parseMeshcoreNeighborsResponse('ZZZZZZZZ:120:40');
    expect(result).toEqual([]);
  });

  it('skips lines with non-numeric fields', () => {
    const result = parseMeshcoreNeighborsResponse('a1b2c3d4:abc:40');
    expect(result).toEqual([]);
  });

  it('handles negative SNR values', () => {
    const result = parseMeshcoreNeighborsResponse('a1b2c3d4:60:-20');
    expect(result).toEqual([
      { pubkeyPrefix: 'a1b2c3d4', lastHeardSecondsAgo: 60, snr: -5 },
    ]);
  });

  it('normalizes uppercase pubkey to lowercase', () => {
    const result = parseMeshcoreNeighborsResponse('A1B2C3D4:120:40');
    expect(result).toEqual([
      { pubkeyPrefix: 'a1b2c3d4', lastHeardSecondsAgo: 120, snr: 10 },
    ]);
  });

  it('handles Windows-style line endings', () => {
    const result = parseMeshcoreNeighborsResponse('a1b2c3d4:120:40\r\ne5f6a7b8:60:20');
    expect(result).toEqual([
      { pubkeyPrefix: 'a1b2c3d4', lastHeardSecondsAgo: 120, snr: 10 },
      { pubkeyPrefix: 'e5f6a7b8', lastHeardSecondsAgo: 60, snr: 5 },
    ]);
  });
});

describe('parseMeshcoreNeighborsResponse — local serial CLI replies (#5500)', () => {
  it('parses a multi-line reply whose first line carries the "  -> " marker', () => {
    expect(parseMeshcoreNeighborsResponse('  -> ABCD1234:12:40\nEF015678:300:-8\n0A0B0C0D:4000:22')).toEqual([
      { pubkeyPrefix: 'abcd1234', lastHeardSecondsAgo: 12, snr: 10 },
      { pubkeyPrefix: 'ef015678', lastHeardSecondsAgo: 300, snr: -2 },
      { pubkeyPrefix: '0a0b0c0d', lastHeardSecondsAgo: 4000, snr: 5.5 },
    ]);
  });

  it('returns [] for "  -> -none-"', () => {
    expect(parseMeshcoreNeighborsResponse('  -> -none-')).toEqual([]);
  });

  it('skips the echo and garbage lines instead of half-parsing them', () => {
    expect(
      parseMeshcoreNeighborsResponse('neighbors\n  -> ABCD1234:12:40\nABCD12:1:2\nZZZZ1234:1:2\nEF015678:30:4x\n\u0000junk\nEF015678:30:-4'),
    ).toEqual([
      { pubkeyPrefix: 'abcd1234', lastHeardSecondsAgo: 12, snr: 10 },
      { pubkeyPrefix: 'ef015678', lastHeardSecondsAgo: 30, snr: -1 },
    ]);
  });

  it('keeps every entry of a reply truncated at the firmware cap', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `${(0xa0000000 + i).toString(16).toUpperCase()}:${1000 + i}:-40`);
    const parsed = parseMeshcoreNeighborsResponse(`  -> ${lines.join('\n')}`);
    expect(parsed).toHaveLength(8);
    expect(parsed?.[0]).toEqual({ pubkeyPrefix: 'a0000000', lastHeardSecondsAgo: 1000, snr: -10 });
  });
});
