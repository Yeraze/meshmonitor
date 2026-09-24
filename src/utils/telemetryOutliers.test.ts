import { describe, it, expect } from 'vitest';
import {
  analyzeSeries,
  median,
  medianAbsoluteDeviation,
  validateOutlierCriteria,
  OUTLIER_K_DEFAULT,
  OUTLIER_MIN_SAMPLES,
  type OutlierCriteria,
  type OutlierSeriesPoint,
} from './telemetryOutliers';

const AUTO: OutlierCriteria = { auto: true, k: OUTLIER_K_DEFAULT, min: null, max: null };

function series(values: number[]): OutlierSeriesPoint[] {
  return values.map((value, i) => ({ id: i + 1, value, timestamp: 1_000 + i }));
}

/** 20 readings wobbling around 20 °C (MAD = 0.5). */
const TEMPS = [19.5, 20, 20.5, 20, 19.5, 20, 20.5, 20, 19.5, 20, 20.5, 20, 19.5, 20, 20.5, 20, 19.5, 20, 20.5, 20];

describe('median / MAD', () => {
  it('handles odd, even and empty input without mutating it', () => {
    const input = [3, 1, 2];
    expect(median(input)).toBe(2);
    expect(input).toEqual([3, 1, 2]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('computes the median absolute deviation', () => {
    // deviations from 3: 2,1,0,1,2 → median 1
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5], 3)).toBe(1);
    expect(medianAbsoluteDeviation([], 0)).toBeNull();
  });
});

describe('analyzeSeries', () => {
  it('flags a spike far beyond k·MAD and keeps ordinary noise', () => {
    const res = analyzeSeries(series([...TEMPS, 1000]), AUTO);
    expect(res.scaleKind).toBe('mad');
    expect(res.median).toBe(20);
    expect(res.mad).toBe(0.5);
    expect(res.flagged).toHaveLength(1);
    expect(res.flagged[0]).toMatchObject({ value: 1000, reason: 'auto', id: 21 });
  });

  it('uses a strict > k·MAD comparison, and k widens or narrows the band', () => {
    // median 20, MAD 0.5 → k=6 threshold 3: 23 is on the line (kept), 23.5 goes
    const res = analyzeSeries(series([...TEMPS, 23, 23.5]), AUTO);
    expect(res.flagged.map(p => p.value)).toEqual([23.5]);

    const loose = analyzeSeries(series([...TEMPS, 23.5]), { ...AUTO, k: 20 });
    expect(loose.flagged).toHaveLength(0);
    const tight = analyzeSeries(series([...TEMPS, 21.5]), { ...AUTO, k: 2 });
    expect(tight.flagged.map(p => p.value)).toEqual([21.5]);
  });

  it(`auto flags nothing below ${OUTLIER_MIN_SAMPLES} points, but bounds still apply`, () => {
    const short = series([20, 20.5, 19.5, 20, 1000]);
    const auto = analyzeSeries(short, AUTO);
    expect(auto.scaleKind).toBe('too_few');
    expect(auto.flagged).toHaveLength(0);

    const withMax = analyzeSeries(short, { ...AUTO, max: 100 });
    expect(withMax.flagged.map(p => p.reason)).toEqual(['above_max']);
  });

  it('MAD == 0 (flat series) flags nothing automatically, never the whole series', () => {
    // Powered node: battery 101 almost always, one glitch to 0, a few legit 95s.
    const values = [...Array(15).fill(101), 95, 95, 0];
    const res = analyzeSeries(series(values), AUTO);
    expect(res.mad).toBe(0);
    expect(res.scaleKind).toBe('flat');
    expect(res.flagged).toHaveLength(0);

    const allSame = analyzeSeries(series(Array(30).fill(4.2)), AUTO);
    expect(allSame.scaleKind).toBe('flat');
    expect(allSame.flagged).toHaveLength(0);

    // The documented remedy: a manual bound catches the glitch.
    const bounded = analyzeSeries(series(values), { ...AUTO, min: 1 });
    expect(bounded.flagged.map(p => p.value)).toEqual([0]);
  });

  it('bounds-only mode (auto off) removes strictly outside [min, max]', () => {
    const res = analyzeSeries(series([...TEMPS, -40, 60, 0, 50]), {
      auto: false,
      k: OUTLIER_K_DEFAULT,
      min: 0,
      max: 50,
    });
    expect(res.scaleKind).toBe('off');
    expect(res.flagged.map(p => [p.value, p.reason])).toEqual([
      [-40, 'below_min'],
      [60, 'above_max'],
    ]);
  });

  it('combined: a point goes when it is an auto outlier OR out of bounds', () => {
    const res = analyzeSeries(series([...TEMPS, 1000, 18]), { ...AUTO, min: 19 });
    expect(res.flagged.map(p => [p.value, p.reason])).toEqual([
      [1000, 'auto'],
      [18, 'below_min'],
    ]);
  });

  it('ignores non-finite values for the statistics and never flags them', () => {
    const pts = series([...TEMPS, 1000]);
    pts.push({ id: 99, value: Number.NaN, timestamp: 0 });
    const res = analyzeSeries(pts, AUTO);
    expect(res.sampleCount).toBe(21);
    expect(res.flagged.map(p => p.id)).toEqual([21]);
  });

  it('an empty series yields nulls and nothing flagged', () => {
    const res = analyzeSeries([], AUTO);
    expect(res).toMatchObject({ sampleCount: 0, median: null, mad: null, flagged: [] });
  });
});

describe('validateOutlierCriteria', () => {
  it('defaults to auto with k = 6', () => {
    expect(validateOutlierCriteria({})).toEqual({
      ok: true,
      criteria: { auto: true, k: 6, min: null, max: null },
    });
  });

  it.each([1, 21, 'six', Number.NaN])('rejects k = %s', (k) => {
    const res = validateOutlierCriteria({ k });
    expect(res).toMatchObject({ ok: false, code: 'INVALID_K' });
  });

  it('accepts k at both edges', () => {
    expect(validateOutlierCriteria({ k: 2 }).ok).toBe(true);
    expect(validateOutlierCriteria({ k: 20 }).ok).toBe(true);
  });

  it('rejects non-numeric bounds and min >= max', () => {
    expect(validateOutlierCriteria({ min: 'abc' })).toMatchObject({ ok: false, code: 'INVALID_BOUNDS' });
    expect(validateOutlierCriteria({ max: {} })).toMatchObject({ ok: false, code: 'INVALID_BOUNDS' });
    expect(validateOutlierCriteria({ min: 5, max: 5 })).toMatchObject({ ok: false, code: 'INVALID_BOUNDS' });
  });

  it('parses numeric strings and treats blank as absent', () => {
    expect(validateOutlierCriteria({ auto: false, min: '1.5', max: '' })).toEqual({
      ok: true,
      criteria: { auto: false, k: 6, min: 1.5, max: null },
    });
  });

  it('requires at least one criterion', () => {
    expect(validateOutlierCriteria({ auto: false })).toMatchObject({ ok: false, code: 'NO_CRITERIA' });
  });

  it('rejects a non-boolean auto', () => {
    expect(validateOutlierCriteria({ auto: 'yes' })).toMatchObject({ ok: false, code: 'INVALID_AUTO' });
  });
});
