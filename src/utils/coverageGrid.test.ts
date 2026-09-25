import { describe, it, expect } from 'vitest';
import { binFixesToGrid } from './coverageGrid.js';
import type { CoverageFix } from './coverage.js';

function fix(packetKey: string, latitude: number, longitude: number, bestSnr: number | null, bestRssi: number | null = -80): CoverageFix {
  return {
    senderId: '!ssssssss',
    packetKey,
    latitude,
    longitude,
    receivedAt: 1_700_000_000_000,
    firstReceivedAt: 1_700_000_000_000,
    receptions: [],
    bestSnr,
    bestRssi,
  };
}

describe('binFixesToGrid', () => {
  it('returns an empty array for no fixes', () => {
    expect(binFixesToGrid([], 250, 'snr')).toEqual([]);
  });

  it('bins two nearby fixes into the same cell at a coarse cell size', () => {
    const fixes = [fix('p1', 40.00001, -80.00001, 5), fix('p2', 40.00002, -80.00002, 7)];
    const cells = binFixesToGrid(fixes, 1000, 'snr');
    expect(cells).toHaveLength(1);
    expect(cells[0].fixCount).toBe(2);
    expect(cells[0].medianValue).toBe(6);
  });

  it('bins two far-apart fixes into different cells', () => {
    const fixes = [fix('p1', 40.0, -80.0, 5), fix('p2', 41.0, -80.0, 7)];
    const cells = binFixesToGrid(fixes, 100, 'snr');
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.fixCount).toBe(1);
    }
  });

  it('cell bounds bracket every fix latitude/longitude it contains', () => {
    const fixes = [fix('p1', 40.123, -80.456, 5)];
    const cells = binFixesToGrid(fixes, 250, 'snr');
    expect(cells).toHaveLength(1);
    const cell = cells[0];
    expect(cell.south).toBeLessThanOrEqual(40.123);
    expect(cell.north).toBeGreaterThan(40.123);
    expect(cell.west).toBeLessThanOrEqual(-80.456);
    expect(cell.east).toBeGreaterThan(-80.456);
  });

  it('the longitude cell size widens with latitude (0 deg vs 60 deg)', () => {
    const equatorFixes = [fix('p1', 0, 0, 5)];
    const highLatFixes = [fix('p1', 60, 0, 5)];

    const equatorCell = binFixesToGrid(equatorFixes, 1000, 'snr')[0];
    const highLatCell = binFixesToGrid(highLatFixes, 1000, 'snr')[0];

    const equatorLonSpanDeg = equatorCell.east - equatorCell.west;
    const highLatLonSpanDeg = highLatCell.east - highLatCell.west;

    // cos(60deg) = 0.5, so the degree-span for the same metre cell size should
    // be roughly double at 60 degrees latitude vs the equator.
    expect(highLatLonSpanDeg).toBeCloseTo(equatorLonSpanDeg * 2, 3);

    // Latitude span (independent of longitude/latitude value) stays constant.
    const equatorLatSpanDeg = equatorCell.north - equatorCell.south;
    const highLatLatSpanDeg = highLatCell.north - highLatCell.south;
    expect(highLatLatSpanDeg).toBeCloseTo(equatorLatSpanDeg, 6);
  });

  it('a null-best-value fix still counts toward fixCount', () => {
    const fixes = [fix('p1', 40, -80, null), fix('p2', 40.00001, -80.00001, null)];
    const cells = binFixesToGrid(fixes, 1000, 'snr');
    expect(cells).toHaveLength(1);
    expect(cells[0].fixCount).toBe(2);
    expect(cells[0].medianValue).toBeNull();
  });

  it('medianValue is null only when EVERY fix in the cell is null, otherwise ignores the nulls', () => {
    const fixes = [fix('p1', 40, -80, null), fix('p2', 40.00001, -80.00001, 10)];
    const cells = binFixesToGrid(fixes, 1000, 'snr');
    expect(cells).toHaveLength(1);
    expect(cells[0].fixCount).toBe(2);
    expect(cells[0].medianValue).toBe(10);
  });

  it('selects bestRssi when metric is "rssi"', () => {
    const fixes = [fix('p1', 40, -80, 5, -90), fix('p2', 40.00001, -80.00001, 5, -70)];
    const cells = binFixesToGrid(fixes, 1000, 'rssi');
    expect(cells[0].medianValue).toBe(-80);
  });
});
