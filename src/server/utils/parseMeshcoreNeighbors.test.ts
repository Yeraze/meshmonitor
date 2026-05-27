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
