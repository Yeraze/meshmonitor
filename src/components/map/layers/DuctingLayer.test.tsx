/**
 * @vitest-environment jsdom
 *
 * Ducting overlay layer (#5734): which cells get a fill, which tone, how dark,
 * and where.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PathOptions } from 'leaflet';
import DuctingLayer, { DuctingCells } from './DuctingLayer';
import {
  DUCTING_MAX_OPACITY,
  DUCTING_MIN_OPACITY,
  SUPER_REFRACTIVE_OPACITY,
  ductingCellBounds,
  ductingCellStyle,
} from './ductingGeometry';
import styles from './DuctingLayer.module.css';
import type { DuctingForecast } from '../../../hooks/useDuctingForecast';

vi.mock('react-leaflet', () => ({
  Rectangle: ({ bounds, pathOptions, interactive }: { bounds: unknown; pathOptions?: PathOptions; interactive?: boolean }) => (
    <div
      data-testid="ducting-cell"
      data-class={pathOptions?.className}
      data-fill-opacity={String(pathOptions?.fillOpacity)}
      data-stroke={String(pathOptions?.stroke)}
      data-interactive={String(interactive)}
      data-bounds={JSON.stringify(bounds)}
    />
  ),
}));

const mocks = vi.hoisted(() => ({ enabled: true, data: undefined as unknown, args: [] as Array<[number, boolean]> }));
vi.mock('../../../hooks/useDuctingForecast', () => ({
  useDuctingEnabled: () => mocks.enabled,
  useDuctingForecast: (h: number, e: boolean) => {
    mocks.args.push([h, e]);
    return { data: mocks.data };
  },
}));

/** 2 x 3 grid, north row first: one cell of every class, plus a gap. */
const FORECAST: DuctingForecast = {
  bbox: { minLat: 27, maxLat: 28, minLon: -83, maxLon: -82.5 },
  cycle: '2026-10-20T12:00:00.000Z',
  forecastHour: 3,
  validTime: '2026-10-20T15:00:00.000Z',
  grid: { lat1: 28, lon1: -83, dLat: 0.25, dLon: 0.25, ni: 3, nj: 2 },
  class: ['normal', 'sub-refractive', 'super-refractive', 'ducting', 'ducting', null],
  ductStrengthM: [0, 0, 0, 0, 40, null],
  minGradientNPerKm: [-40, 10, -100, -170, -300, null],
  layerBaseM: [0, 0, 0, 0, 0, null],
  layerTopM: [100, 100, 100, 100, 100, null],
  summary: { 'sub-refractive': 1, normal: 1, 'super-refractive': 1, ducting: 2 },
};

describe('ductingCellStyle', () => {
  it('leaves normal, sub-refractive and unknown cells clear', () => {
    expect(ductingCellStyle('normal', 0)).toBeNull();
    expect(ductingCellStyle('sub-refractive', 0)).toBeNull();
    expect(ductingCellStyle(null, null)).toBeNull();
  });

  it('gives super-refraction one light tint', () => {
    expect(ductingCellStyle('super-refractive', 0)).toEqual({ tone: 'super', fillOpacity: SUPER_REFRACTIVE_OPACITY });
  });

  it('darkens a duct with its strength, up to a cap', () => {
    expect(ductingCellStyle('ducting', 0)!.fillOpacity).toBe(DUCTING_MIN_OPACITY);
    const mid = ductingCellStyle('ducting', 10)!.fillOpacity;
    expect(mid).toBeGreaterThan(DUCTING_MIN_OPACITY);
    expect(mid).toBeLessThan(DUCTING_MAX_OPACITY);
    expect(ductingCellStyle('ducting', 20)!.fillOpacity).toBe(DUCTING_MAX_OPACITY);
    expect(ductingCellStyle('ducting', 500)!.fillOpacity).toBe(DUCTING_MAX_OPACITY);
    expect(ductingCellStyle('ducting', null)!.fillOpacity).toBe(DUCTING_MIN_OPACITY);
  });

  it('keeps every fill semi-transparent so nodes stay readable', () => {
    for (const s of [ductingCellStyle('super-refractive', 0), ductingCellStyle('ducting', 1e6)]) {
      expect(s!.fillOpacity).toBeLessThanOrEqual(0.6);
    }
  });
});

describe('ductingCellBounds', () => {
  it('centres each cell on its grid point, rows running south', () => {
    expect(ductingCellBounds(FORECAST.grid, 0)).toEqual([[27.875, -83.125], [28.125, -82.875]]);
    // Row 1, column 2.
    expect(ductingCellBounds(FORECAST.grid, 5)).toEqual([[27.625, -82.625], [27.875, -82.375]]);
  });
});

describe('DuctingCells', () => {
  it('draws only super-refractive and ducting cells, each with its tone class', () => {
    render(<DuctingCells forecast={FORECAST} />);
    const cells = screen.getAllByTestId('ducting-cell');
    expect(cells.map((c) => c.dataset.class)).toEqual([styles.super, styles.duct, styles.duct]);
    expect(cells.map((c) => Number(c.dataset.fillOpacity))).toEqual([
      SUPER_REFRACTIVE_OPACITY,
      DUCTING_MIN_OPACITY,
      DUCTING_MAX_OPACITY,
    ]);
    expect(JSON.parse(cells[0].dataset.bounds!)).toEqual(ductingCellBounds(FORECAST.grid, 2));
  });

  it('draws no outline and takes no clicks', () => {
    render(<DuctingCells forecast={FORECAST} />);
    for (const c of screen.getAllByTestId('ducting-cell')) {
      expect(c.dataset.stroke).toBe('false');
      expect(c.dataset.interactive).toBe('false');
    }
  });
});

describe('DuctingLayer', () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.data = FORECAST;
    mocks.args = [];
  });

  it('asks for the step on view and draws it', () => {
    render(<DuctingLayer hoursAhead={24} />);
    expect(mocks.args.at(-1)).toEqual([24, true]);
    expect(screen.getAllByTestId('ducting-cell')).toHaveLength(3);
  });

  it('fetches and draws nothing while the admin switch is off', () => {
    mocks.enabled = false;
    render(<DuctingLayer hoursAhead={0} />);
    expect(mocks.args.every(([, e]) => e === false)).toBe(true);
    expect(screen.queryByTestId('ducting-cell')).not.toBeInTheDocument();
  });
});
