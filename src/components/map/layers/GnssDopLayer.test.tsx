/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { PathOptions } from 'leaflet';
import GnssDopLayer from './GnssDopLayer';
import { gdopToColor, type GnssDopUiParams } from './gnssDopGeometry';
import apiService, { type DopGridResult } from '../../../services/api';

// Rectangle -> a div that surfaces its fill color + bounds; useMap returns a
// fake with getBounds so the layer can derive a bbox without a real Leaflet map;
// useMapEvents is a no-op (we drive refetch via prop changes, not map moves).
vi.mock('react-leaflet', () => ({
  Rectangle: ({ bounds, pathOptions }: { bounds: unknown; pathOptions?: PathOptions }) => (
    <div
      data-testid="dop-cell"
      data-fill={pathOptions?.fillColor}
      data-fill-opacity={String(pathOptions?.fillOpacity)}
      data-bounds={JSON.stringify(bounds)}
    />
  ),
  useMap: () => ({
    getBounds: () => ({
      getSouth: () => 29,
      getNorth: () => 31,
      getWest: () => -91,
      getEast: () => -89,
    }),
  }),
  useMapEvents: () => null,
}));

vi.mock('../../../services/api', () => ({
  default: { getDopGrid: vi.fn() },
}));

const getDopGrid = (apiService as unknown as { getDopGrid: ReturnType<typeof vi.fn> }).getDopGrid;

const PARAMS: GnssDopUiParams = { maskDeg: 5, timeMs: 1_700_000_000_000, constellations: ['gps'] };

function result(overrides: Partial<DopGridResult> = {}): DopGridResult {
  return {
    points: [
      { lat: 30.0, lon: -90.0, gdop: 1.2 }, // good
      { lat: 30.2, lon: -90.0, gdop: 8.5 }, // poor
      { lat: 30.4, lon: -90.0, gdop: null }, // no fix
    ],
    cellCount: 3,
    stepDeg: 0.2,
    requestedStepDeg: 0.2,
    clamped: false,
    timeMs: PARAMS.timeMs,
    elevationMaskDeg: 5,
    constellations: ['gps'],
    ...overrides,
  };
}

describe('GnssDopLayer', () => {
  beforeEach(() => {
    getDopGrid.mockReset();
  });

  it('renders one Rectangle per grid point once the fetch resolves', async () => {
    getDopGrid.mockResolvedValue(result());
    render(<GnssDopLayer visible params={PARAMS} debounceMs={0} />);
    const cells = await screen.findAllByTestId('dop-cell');
    expect(cells).toHaveLength(3);
  });

  it('colors cells by GDOP: low GDOP is green, high GDOP is red, and they differ', async () => {
    getDopGrid.mockResolvedValue(result());
    render(<GnssDopLayer visible params={PARAMS} debounceMs={0} />);
    const cells = await screen.findAllByTestId('dop-cell');
    const fills = cells.map((c) => c.getAttribute('data-fill'));
    expect(fills[0]).toBe(gdopToColor(1.2)); // good -> green ramp
    expect(fills[1]).toBe(gdopToColor(8.5)); // poor -> red ramp
    expect(fills[0]).not.toEqual(fills[1]);
    // The null-GDOP cell is the neutral gray, not a point on the good/poor ramp.
    expect(fills[2]).toBe(gdopToColor(null));
  });

  it('sends the bbox derived from the map bounds and the panel params', async () => {
    getDopGrid.mockResolvedValue(result());
    render(<GnssDopLayer visible params={PARAMS} debounceMs={0} />);
    await screen.findAllByTestId('dop-cell');
    expect(getDopGrid).toHaveBeenCalledWith(
      expect.objectContaining({
        bbox: { minLat: 29, minLon: -91, maxLat: 31, maxLon: -89 },
        timeMs: PARAMS.timeMs,
        elevationMaskDeg: 5,
        constellations: ['gps'],
      }),
    );
  });

  it('reports clamp + loading state up through onMeta', async () => {
    getDopGrid.mockResolvedValue(result({ clamped: true, stepDeg: 0.5, requestedStepDeg: 0.2 }));
    const onMeta = vi.fn();
    render(<GnssDopLayer visible params={PARAMS} onMeta={onMeta} debounceMs={0} />);
    await waitFor(() => expect(onMeta).toHaveBeenCalledWith(expect.objectContaining({ loading: true })));
    await waitFor(() =>
      expect(onMeta).toHaveBeenCalledWith(expect.objectContaining({ clamped: true, loading: false })),
    );
  });

  it('renders nothing and does not fetch while hidden', async () => {
    getDopGrid.mockResolvedValue(result());
    render(<GnssDopLayer visible={false} params={PARAMS} debounceMs={0} />);
    // Give any (incorrectly scheduled) debounce a chance to fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('dop-cell')).toBeNull();
    expect(getDopGrid).not.toHaveBeenCalled();
  });

  it('surfaces a fetch failure through onMeta.error without rendering cells', async () => {
    getDopGrid.mockRejectedValue(new Error('boom'));
    const onMeta = vi.fn();
    render(<GnssDopLayer visible params={PARAMS} onMeta={onMeta} debounceMs={0} />);
    await waitFor(() =>
      expect(onMeta).toHaveBeenCalledWith(expect.objectContaining({ error: 'boom', loading: false })),
    );
    expect(screen.queryByTestId('dop-cell')).toBeNull();
  });
});
