import { describe, it, expect } from 'vitest';
import { getPolarGridRings, getSectorEndpoint } from './polarGrid';

describe('getPolarGridRings', () => {
  describe('ring count', () => {
    for (let zoom = 3; zoom <= 18; zoom++) {
      it(`zoom ${zoom} returns 4-6 rings`, () => {
        const rings = getPolarGridRings(zoom, 'km');
        expect(rings.length).toBeGreaterThanOrEqual(4);
        expect(rings.length).toBeLessThanOrEqual(6);
      });
    }
  });

  describe('monotonically increasing radii', () => {
    for (let zoom = 3; zoom <= 18; zoom++) {
      it(`zoom ${zoom} has monotonically increasing radii`, () => {
        const rings = getPolarGridRings(zoom, 'km');
        for (let i = 1; i < rings.length; i++) {
          expect(rings[i].radiusMeters).toBeGreaterThan(rings[i - 1].radiusMeters);
        }
      });
    }
  });

  describe('unit labels - metric (km)', () => {
    it('low zoom uses km labels', () => {
      // zoom 3 -> 500km intervals, all labels should be km
      const rings = getPolarGridRings(3, 'km');
      expect(rings.every(r => r.label.endsWith('km'))).toBe(true);
    });

    it('medium zoom uses km labels', () => {
      // zoom 10 -> 5km intervals
      const rings = getPolarGridRings(10, 'km');
      expect(rings.every(r => r.label.endsWith('km'))).toBe(true);
    });

    it('high zoom uses m labels for sub-km rings', () => {
      // zoom 18 -> 20m intervals, all labels should be m (not km)
      const rings = getPolarGridRings(18, 'km');
      expect(rings.every(r => r.label.endsWith('m') && !r.label.endsWith('km'))).toBe(true);
    });

    it('zoom 14 first ring uses m label (500m)', () => {
      // zoom 14 -> 500m intervals; first ring is 500m (sub-km), gets 'm' label
      const rings = getPolarGridRings(14, 'km');
      expect(rings[0].label).toBe('500m');
      // second ring is 1000m = 1km, gets 'km' label
      expect(rings[1].label).toBe('1km');
    });
  });

  describe('unit labels - imperial (mi)', () => {
    it('low zoom uses mi labels', () => {
      const rings = getPolarGridRings(3, 'mi');
      expect(rings.every(r => r.label.endsWith('mi'))).toBe(true);
    });

    it('high zoom uses ft labels for sub-mile rings', () => {
      // zoom 18 -> very small intervals in ft
      const rings = getPolarGridRings(18, 'mi');
      expect(rings.every(r => r.label.endsWith('ft'))).toBe(true);
    });

    it('medium zoom with mile-scale uses mi labels', () => {
      const rings = getPolarGridRings(10, 'mi');
      // 5km intervals ~ 3.1 miles, should be mi
      expect(rings.every(r => r.label.endsWith('mi'))).toBe(true);
    });
  });

  describe('label values', () => {
    it('labels contain numeric values', () => {
      const rings = getPolarGridRings(12, 'km');
      for (const ring of rings) {
        const match = ring.label.match(/^[\d.]+/);
        expect(match).not.toBeNull();
        expect(parseFloat(match![0])).toBeGreaterThan(0);
      }
    });

    it('km label at zoom 12 shows 1km intervals', () => {
      const rings = getPolarGridRings(12, 'km');
      // zoom 12 -> 1km interval, first ring should be "1km"
      expect(rings[0].label).toBe('1km');
    });

    it('metric label at zoom 3 starts at 500km', () => {
      const rings = getPolarGridRings(3, 'km');
      expect(rings[0].label).toBe('500km');
    });
  });

  describe('radiusMeters values', () => {
    it('are all positive', () => {
      for (let zoom = 3; zoom <= 18; zoom++) {
        const rings = getPolarGridRings(zoom, 'km');
        expect(rings.every(r => r.radiusMeters > 0)).toBe(true);
      }
    });

    it('zoom 3 first ring is 500000m (500km)', () => {
      const rings = getPolarGridRings(3, 'km');
      expect(rings[0].radiusMeters).toBe(500000);
    });

    it('zoom 18 first ring is 20m', () => {
      const rings = getPolarGridRings(18, 'km');
      expect(rings[0].radiusMeters).toBe(20);
    });
  });
});

describe('getSectorEndpoint', () => {
  const center = { lat: 40.0, lng: -74.0 };

  it('north (0°) increases latitude', () => {
    const result = getSectorEndpoint(center, 0, 1000);
    expect(result.lat).toBeGreaterThan(center.lat);
    expect(result.lng).toBeCloseTo(center.lng, 3);
  });

  it('south (180°) decreases latitude', () => {
    const result = getSectorEndpoint(center, 180, 1000);
    expect(result.lat).toBeLessThan(center.lat);
    expect(result.lng).toBeCloseTo(center.lng, 3);
  });

  it('east (90°) increases longitude', () => {
    const result = getSectorEndpoint(center, 90, 1000);
    expect(result.lng).toBeGreaterThan(center.lng);
    expect(result.lat).toBeCloseTo(center.lat, 3);
  });

  it('west (270°) decreases longitude', () => {
    const result = getSectorEndpoint(center, 270, 1000);
    expect(result.lng).toBeLessThan(center.lng);
    expect(result.lat).toBeCloseTo(center.lat, 3);
  });

  it('zero distance returns center', () => {
    const result = getSectorEndpoint(center, 45, 0);
    expect(result.lat).toBeCloseTo(center.lat, 6);
    expect(result.lng).toBeCloseTo(center.lng, 6);
  });

  it('1km north moves roughly 0.009 degrees latitude', () => {
    const result = getSectorEndpoint(center, 0, 1000);
    const deltaLat = result.lat - center.lat;
    expect(deltaLat).toBeGreaterThan(0.008);
    expect(deltaLat).toBeLessThan(0.010);
  });

  it('is geodesically accurate for 100km', () => {
    // 100km north from lat 0 should reach ~0.899 degrees
    const equator = { lat: 0, lng: 0 };
    const result = getSectorEndpoint(equator, 0, 100000);
    expect(result.lat).toBeCloseTo(0.8993, 2);
    expect(result.lng).toBeCloseTo(0, 5);
  });
});
