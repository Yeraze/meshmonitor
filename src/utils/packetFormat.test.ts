import { describe, it, expect } from 'vitest';
import { getPortnumName, PORTNUM_NAMES } from './packetFormat';

describe('getPortnumName', () => {
  it('names common portnums', () => {
    expect(getPortnumName(1)).toBe('TEXT_MESSAGE');
    expect(getPortnumName(3)).toBe('POSITION');
    expect(getPortnumName(67)).toBe('TELEMETRY');
    expect(getPortnumName(70)).toBe('TRACEROUTE');
  });

  it('falls back to PORT_<n> for unknown portnums', () => {
    expect(getPortnumName(9999)).toBe('PORT_9999');
  });

  it('returns UNKNOWN for null/undefined', () => {
    expect(getPortnumName(undefined)).toBe('UNKNOWN');
    expect(getPortnumName(null)).toBe('UNKNOWN');
  });

  it('exposes a name map that includes 0 = UNKNOWN', () => {
    expect(PORTNUM_NAMES[0]).toBe('UNKNOWN');
  });
});
