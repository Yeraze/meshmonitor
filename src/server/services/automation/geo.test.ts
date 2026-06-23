import { describe, it, expect } from 'vitest';
import { haversineKm, geofenceFires } from './geo.js';

describe('haversineKm', () => {
  it('is 0 for the same point and ~111km per degree of latitude', () => {
    expect(haversineKm(0, 0, 0, 0)).toBe(0);
    expect(haversineKm(0, 0, 1, 0)).toBeGreaterThan(110);
    expect(haversineKm(0, 0, 1, 0)).toBeLessThan(112);
  });
});

describe('geofenceFires', () => {
  it('never fires on the baseline (no prior state)', () => {
    expect(geofenceFires(undefined, true, 'enter')).toBe(false);
    expect(geofenceFires(undefined, false, 'exit')).toBe(false);
    expect(geofenceFires(undefined, true, 'dwell')).toBe(false);
  });

  it('enter = outside → inside', () => {
    expect(geofenceFires(false, true, 'enter')).toBe(true);
    expect(geofenceFires(true, true, 'enter')).toBe(false);
    expect(geofenceFires(false, false, 'enter')).toBe(false);
  });

  it('exit = inside → outside', () => {
    expect(geofenceFires(true, false, 'exit')).toBe(true);
    expect(geofenceFires(false, false, 'exit')).toBe(false);
    expect(geofenceFires(true, true, 'exit')).toBe(false);
  });

  it('dwell = inside → still inside', () => {
    expect(geofenceFires(true, true, 'dwell')).toBe(true);
    expect(geofenceFires(false, true, 'dwell')).toBe(false);
    expect(geofenceFires(true, false, 'dwell')).toBe(false);
  });
});
