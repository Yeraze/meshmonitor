import { describe, it, expect } from 'vitest';
import { formatFlightMatchDetails } from './flightMatchFormat.js';

const FULL = {
  hex: 'a1b2c3',
  callsign: 'UAL123',
  aircraftType: 'B738',
  registration: 'N12345',
  gsKt: 450.4,
  trackDeg: 269.6,
};

describe('formatFlightMatchDetails', () => {
  it('joins every part', () => {
    expect(formatFlightMatchDetails(FULL)).toBe('UAL123 · B738 · N12345 · 450 kt 270°');
  });

  it('leaves out missing parts', () => {
    expect(formatFlightMatchDetails({ ...FULL, aircraftType: null, gsKt: null })).toBe('UAL123 · N12345 · 270°');
    expect(formatFlightMatchDetails({ ...FULL, callsign: null, trackDeg: null })).toBe('B738 · N12345 · 450 kt');
  });

  it('falls back to the hex when nothing else is known', () => {
    expect(
      formatFlightMatchDetails({ hex: 'a1b2c3', callsign: null, aircraftType: null, registration: null, gsKt: null, trackDeg: null }),
    ).toBe('A1B2C3');
  });
});
