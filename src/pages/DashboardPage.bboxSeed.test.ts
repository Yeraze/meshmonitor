/**
 * Focused tests for the helpers that seed the mqtt_bridge geofence bbox
 * from currently-detected node positions. Lives in its own file (rather
 * than DashboardPage.test.tsx) because the helpers are pure and don't
 * need the JSDOM / React render stack.
 */
import { describe, it, expect } from 'vitest';
import { boundsFromDetectedNodes, bboxToFormStrings } from './DashboardPage.bboxSeed';

describe('boundsFromDetectedNodes', () => {
  it('returns null when no nodes report a position', () => {
    expect(boundsFromDetectedNodes([])).toBeNull();
    expect(
      boundsFromDetectedNodes([
        { latitude: undefined, longitude: undefined },
        { latitude: null, longitude: null },
      ]),
    ).toBeNull();
  });

  it('skips nodes with the (0,0) "no fix" sentinel', () => {
    // Without skipping (0,0), a single un-positioned node would balloon
    // the bbox out to the middle of the ocean — defeating the whole point.
    expect(
      boundsFromDetectedNodes([{ latitude: 0, longitude: 0 }]),
    ).toBeNull();
    expect(
      boundsFromDetectedNodes([
        { latitude: 0, longitude: 0 },
        { latitude: 44.5, longitude: -78.5 },
      ]),
    ).toEqual({
      minLat: 44.5 - 0.05,
      maxLat: 44.5 + 0.05,
      minLng: -78.5 - 0.05,
      maxLng: -78.5 + 0.05,
    });
  });

  it('encloses a multi-node cluster with 10% padding', () => {
    const bbox = boundsFromDetectedNodes([
      { latitude: 43, longitude: -80 },
      { latitude: 45, longitude: -77 },
      { latitude: 44, longitude: -78.5 },
    ]);
    // Range: lat 43→45 (2°), lng -80→-77 (3°). 10% padding = 0.2° lat / 0.3° lng.
    expect(bbox).not.toBeNull();
    expect(bbox!.minLat).toBeCloseTo(43 - 0.2, 5);
    expect(bbox!.maxLat).toBeCloseTo(45 + 0.2, 5);
    expect(bbox!.minLng).toBeCloseTo(-80 - 0.3, 5);
    expect(bbox!.maxLng).toBeCloseTo(-77 + 0.3, 5);
  });

  it('applies the minimum 0.05° padding for a single (non-zero) node', () => {
    const bbox = boundsFromDetectedNodes([{ latitude: 44.0, longitude: -78.0 }]);
    // Single node → range is 0; padding clamps to 0.05° minimum each side.
    expect(bbox).toEqual({
      minLat: 43.95,
      maxLat: 44.05,
      minLng: -78.05,
      maxLng: -77.95,
    });
  });

  it('ignores partial position rows (only one of lat/lng present)', () => {
    expect(
      boundsFromDetectedNodes([
        { latitude: 44.5 },
        { longitude: -78.5 },
      ] as Array<{ latitude?: number; longitude?: number }>),
    ).toBeNull();
  });
});

describe('bboxToFormStrings', () => {
  it('rounds each axis to 5 decimal places', () => {
    expect(
      bboxToFormStrings({
        minLat: 43.123456789,
        maxLat: 44.987654321,
        minLng: -80.111111111,
        maxLng: -77.999999999,
      }),
    ).toEqual({
      minLat: '43.12346',
      maxLat: '44.98765',
      minLng: '-80.11111',
      maxLng: '-78.00000',
    });
  });
});
