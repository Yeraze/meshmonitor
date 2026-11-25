/**
 * @vitest-environment jsdom
 *
 * WalkaboutHexMap (#5891 P2). Leaflet cannot render in jsdom, so BaseMap and
 * react-leaflet are stubbed (CoverageMap.test pattern). `h3-js` is real.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { latLngToCell, cellToParent } from 'h3-js';

const { fitBoundsMock, setViewMock, mapEvents, hooks, zoomRef } = vi.hoisted(() => ({
  fitBoundsMock: vi.fn(),
  setViewMock: vi.fn(),
  mapEvents: { handlers: {} as Record<string, () => void> },
  hooks: {
    cells: vi.fn(),
    cellNodes: vi.fn(),
    track: vi.fn(),
  },
  zoomRef: { current: 14 },
}));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    overlayColors: {
      snrColors: { excellent: '#00aa01', good: '#00aa02', fair: '#00aa03', poor: '#00aa04', noData: '#00aa05' },
      walkaboutTrack: '#0000ff',
    },
    defaultMapCenterLat: 40,
    defaultMapCenterLon: -75,
    defaultMapCenterZoom: 11,
  }),
}));
vi.mock('../map/useBaseMapSettings', () => ({ useBaseMapSettings: () => ({}) }));
vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children, preferCanvas }: { children?: React.ReactNode; preferCanvas?: boolean }) => (
    <div data-testid="base-map" data-prefer-canvas={String(preferCanvas)}>{children}</div>
  ),
}));
vi.mock('react-leaflet', () => ({
  Polygon: ({ positions, pathOptions, eventHandlers }: any) => (
    <button
      data-testid="hex"
      data-fill={pathOptions.fillColor}
      data-points={positions.length}
      onClick={() => eventHandlers.click({ latlng: { lat: 40, lng: -75 } })}
    />
  ),
  Polyline: ({ positions, pathOptions }: any) => (
    <div data-testid="track" data-color={pathOptions.color} data-n={positions.length} />
  ),
  Popup: ({ children }: any) => <div data-testid="popup">{children}</div>,
  useMap: () => ({ setView: setViewMock, fitBounds: fitBoundsMock }),
  useMapEvents: (handlers: Record<string, () => void>) => {
    mapEvents.handlers = handlers;
    return { getZoom: () => zoomRef.current };
  },
}));
vi.mock('../../hooks/useWalkabout', () => ({
  useWalkaboutCells: (...a: unknown[]) => hooks.cells(...a),
  useWalkaboutCellNodes: (...a: unknown[]) => hooks.cellNodes(...a),
  useWalkaboutTrack: (...a: unknown[]) => hooks.track(...a),
}));

import WalkaboutHexMap from './WalkaboutHexMap';
import type { WalkaboutMapQuery, WalkaboutCellsResult, WalkaboutCellDto } from '../../types/walkabout';

const CELL_A = latLngToCell(40, -75, 9);
const CELL_B = latLngToCell(40.01, -75.01, 9);
const q: WalkaboutMapQuery = { kind: 'window', window: '7d' };

const cell = (c: string, p: Partial<WalkaboutCellDto> = {}): WalkaboutCellDto => ({
  cell: c, bestSnr: 3, receptionCount: 2, nodeCount: 1, sampleCount: 1, ...p,
});
const result = (cells: WalkaboutCellDto[], p: Partial<WalkaboutCellsResult> = {}): WalkaboutCellsResult => ({
  res: 9, windowStartAt: 0, windowEndAt: 1, cells, truncated: false, hiddenReceptionCount: 0,
  bounds: { bboxSouth: 40, bboxNorth: 40.01, bboxWest: -75.01, bboxEast: -75 }, ...p,
});
const setCells = (data: WalkaboutCellsResult | undefined, isPlaceholderData = false) =>
  hooks.cells.mockReturnValue({ data, isPlaceholderData, isLoading: !data, isError: false });

beforeEach(() => {
  vi.clearAllMocks();
  zoomRef.current = 14;
  hooks.cellNodes.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  hooks.track.mockReturnValue({ data: undefined });
  setCells(result([cell(CELL_A)]));
});

describe('WalkaboutHexMap', () => {
  it('composes BaseMap with canvas and draws one hex per cell, filled by bucket', () => {
    setCells(result([
      cell(CELL_A, { bestSnr: 1 }),
      cell(CELL_B, { bestSnr: -7 }),
      cell(latLngToCell(41, -75, 9), { bestSnr: null, receptionCount: 0 }),
      cell(latLngToCell(42, -75, 9), { bestSnr: null, receptionCount: 3 }),
    ]));
    render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(screen.getByTestId('base-map').dataset.preferCanvas).toBe('true');
    const hexes = screen.getAllByTestId('hex');
    expect(hexes.map((h) => h.dataset.fill)).toEqual(['#00aa01', '#00aa03', '#00aa04', '#00aa05']);
    expect(hexes[0].dataset.points).toBe('6');
  });

  it('starts at the res for the default zoom and refetches at a new res on zoomend', () => {
    render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(hooks.cells).toHaveBeenLastCalledWith('s', q, 7); // zoom 11
    zoomRef.current = 14;
    act(() => mapEvents.handlers.zoomend());
    expect(hooks.cells).toHaveBeenLastCalledWith('s', q, 9);
    zoomRef.current = 12;
    act(() => mapEvents.handlers.zoomend());
    expect(hooks.cells).toHaveBeenLastCalledWith('s', q, 8);
  });

  it('fits to bounds once per fitKey, not after a res change, not on placeholder data', () => {
    const { rerender } = render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k1" />);
    expect(fitBoundsMock).toHaveBeenCalledTimes(1);
    expect(fitBoundsMock.mock.calls[0][1]).toMatchObject({ maxZoom: 16 });

    zoomRef.current = 14;
    act(() => mapEvents.handlers.zoomend()); // res change
    setCells(result([cell(CELL_A)], { res: 9 }));
    rerender(<WalkaboutHexMap sourceId="s" query={q} fitKey="k1" />);
    expect(fitBoundsMock).toHaveBeenCalledTimes(1);

    // New window: old hexes may not drive the fit while placeholder.
    setCells(result([cell(CELL_A)], { bounds: { bboxSouth: 1, bboxNorth: 2, bboxWest: 1, bboxEast: 2 } }), true);
    rerender(<WalkaboutHexMap sourceId="s" query={q} fitKey="k2" />);
    expect(fitBoundsMock).toHaveBeenCalledTimes(1);
    setCells(result([cell(CELL_A)], { bounds: { bboxSouth: 1, bboxNorth: 2, bboxWest: 1, bboxEast: 2 } }), false);
    rerender(<WalkaboutHexMap sourceId="s" query={q} fitKey="k2" />);
    expect(fitBoundsMock).toHaveBeenCalledTimes(2);
  });

  it('fits once when placeholder data turns real under the same fitKey', () => {
    setCells(result([cell(CELL_A)]), true);
    const { rerender } = render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(fitBoundsMock).not.toHaveBeenCalled();
    setCells(result([cell(CELL_A)]), false);
    rerender(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(fitBoundsMock).toHaveBeenCalledTimes(1);
    setCells(result([cell(CELL_A)]), true); // user zoomed, uncached res
    rerender(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    setCells(result([cell(CELL_A)]), false);
    rerender(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(fitBoundsMock).toHaveBeenCalledTimes(1);
  });

  it('shows an error banner when the cells query fails', () => {
    hooks.cells.mockReturnValue({ data: undefined, isPlaceholderData: false, isLoading: false, isError: true });
    render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(screen.getByRole('alert').textContent).toMatch(/Could not load the walkabout map/);
  });

  it('closes an open popup when the query changes', () => {
    const { rerender } = render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    fireEvent.click(screen.getByTestId('hex'));
    expect(screen.getByTestId('popup')).toBeTruthy();
    rerender(<WalkaboutHexMap sourceId="s" query={{ kind: 'window', window: '24h' }} fitKey="k" />);
    expect(screen.queryByTestId('popup')).toBeNull();
  });

  it('does not fit when bounds is null', () => {
    setCells(result([], { bounds: null }));
    render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(fitBoundsMock).not.toHaveBeenCalled();
    expect(screen.getByText('No walkabout data in this window.')).toBeTruthy();
  });

  it('popup lists nodes with SNR and count; null long name falls back to the id', () => {
    hooks.cellNodes.mockReturnValue({
      isLoading: false, isError: false,
      data: {
        cell: CELL_A, truncated: false,
        nodes: [
          { protocol: 'meshtastic', nodeId: '!aabbccdd', nodeNum: 1, publicKey: null, longName: 'Alpha', shortName: 'A', bestSnr: 4.5, receptionCount: 7, lastHeardAt: 1 },
          { protocol: 'meshtastic', nodeId: '!11223344', nodeNum: 2, publicKey: null, longName: null, shortName: null, bestSnr: null, receptionCount: 1, lastHeardAt: 1 },
        ],
      },
    });
    render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(screen.queryByTestId('popup')).toBeNull();
    fireEvent.click(screen.getByTestId('hex'));
    expect(hooks.cellNodes).toHaveBeenLastCalledWith('s', q, CELL_A);
    expect(screen.getByText('2 nodes heard here')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('4.5 dB · ×7')).toBeTruthy();
    expect(screen.getByText('!11223344')).toBeTruthy();
    expect(screen.getByText('SNR — · ×1')).toBeTruthy();
  });

  it('sample-only cell says nothing was heard and fetches no nodes', () => {
    setCells(result([cell(CELL_A, { receptionCount: 0, bestSnr: null })]));
    render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    fireEvent.click(screen.getByTestId('hex'));
    expect(screen.getByText('Walked here, nothing heard')).toBeTruthy();
    expect(hooks.cellNodes).toHaveBeenLastCalledWith('s', q, null);
  });

  it('draws the track only in session mode', () => {
    hooks.track.mockReturnValue({ data: { sessionId: 'x', truncated: false, positions: [[1, 1], [2, 2]] } });
    const { rerender } = render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(hooks.track).toHaveBeenLastCalledWith('s', null);
    const sq: WalkaboutMapQuery = { kind: 'session', sessionId: 'x' };
    rerender(<WalkaboutHexMap sourceId="s" query={sq} fitKey="k" />);
    expect(hooks.track).toHaveBeenLastCalledWith('s', 'x');
    const track = screen.getByTestId('track');
    expect(track.dataset.color).toBe('#0000ff');
    expect(track.dataset.n).toBe('2');
  });

  it('shows hidden and truncated banners', () => {
    setCells(result([cell(CELL_A)], { hiddenReceptionCount: 12, truncated: true }));
    render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(screen.getByText(/12 receptions from nodes you cannot see/)).toBeTruthy();
    expect(screen.getByText(/Showing part of this window/)).toBeTruthy();
  });

  it('legend shows "Heard, no SNR" only when a cell is unknown', () => {
    const { unmount } = render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(screen.queryByText('Heard, no SNR')).toBeNull();
    expect(screen.getByTestId('walkabout-legend').querySelectorAll('[data-bucket]').length).toBe(4);
    unmount();
    setCells(result([cell(CELL_A, { bestSnr: null, receptionCount: 2 })]));
    render(<WalkaboutHexMap sourceId="s" query={q} fitKey="k" />);
    expect(screen.getByText('Heard, no SNR')).toBeTruthy();
  });

  it('res-7 outline of a cell is its parent (sanity: h3 real)', () => {
    expect(cellToParent(CELL_A, 7)).toBeTruthy();
  });
});
