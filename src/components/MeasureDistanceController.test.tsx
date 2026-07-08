/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { MeasurePoint } from '../utils/measureDistance';

// Capture the click handler registered via useMapEvents so the test can fire
// synthetic map clicks. Stub the leaflet primitives to plain DOM so we can
// assert what the controller renders without a real map.
let clickHandler: ((e: { latlng: { lat: number; lng: number } }) => void) | null = null;
const containerStyle: { cursor: string } = { cursor: '' };

vi.mock('react-leaflet', () => ({
  useMap: () => ({ getContainer: () => ({ style: containerStyle }) }),
  useMapEvents: (handlers: { click: (e: { latlng: { lat: number; lng: number } }) => void }) => {
    clickHandler = handlers.click;
    return {};
  },
  CircleMarker: ({ center }: { center: [number, number] }) => (
    <div data-testid="measure-ring" data-lat={center[0]} data-lng={center[1]} />
  ),
  Polyline: ({ positions, children }: { positions: [number, number][]; children?: React.ReactNode }) => (
    <div data-testid="measure-line" data-positions={JSON.stringify(positions)}>{children}</div>
  ),
  Tooltip: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="measure-label">{children}</div>
  ),
}));

let unit: 'km' | 'mi' = 'km';
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ distanceUnit: unit }),
}));

import MeasureDistanceController from './MeasureDistanceController';

const POINTS: MeasurePoint[] = [
  { id: 'a', lat: 40.0, lng: -105.0, label: 'A' },
  { id: 'b', lat: 40.5, lng: -105.0, label: 'B' },
  { id: 'c', lat: 41.0, lng: -105.0, label: 'C' },
];

function click(lat: number, lng: number) {
  act(() => clickHandler?.({ latlng: { lat, lng } }));
}

describe('MeasureDistanceController', () => {
  beforeEach(() => {
    clickHandler = null;
    containerStyle.cursor = '';
    unit = 'km';
  });

  it('renders nothing when inactive', () => {
    render(<MeasureDistanceController active={false} points={POINTS} />);
    expect(screen.queryByTestId('measure-ring')).toBeNull();
  });

  it('renders nothing with fewer than two points', () => {
    render(<MeasureDistanceController active points={[POINTS[0]]} />);
    expect(screen.queryByTestId('measure-ring')).toBeNull();
  });

  it('snaps two clicks to nearest nodes and draws a labeled line', () => {
    render(<MeasureDistanceController active points={POINTS} />);
    // Click near A, then near C -> line A..C, ~111 km.
    click(39.9, -105.0);
    click(41.1, -105.0);

    const line = screen.getByTestId('measure-line');
    expect(JSON.parse(line.getAttribute('data-positions')!)).toEqual([
      [40.0, -105.0],
      [41.0, -105.0],
    ]);
    const label = screen.getByTestId('measure-label').textContent ?? '';
    expect(label).toMatch(/km$/);
    expect(parseFloat(label)).toBeCloseTo(111.2, 0);
  });

  it('honors the miles preference', () => {
    unit = 'mi';
    render(<MeasureDistanceController active points={POINTS} />);
    click(39.9, -105.0);
    click(40.6, -105.0); // nearest to B
    expect(screen.getByTestId('measure-label').textContent).toMatch(/mi$/);
  });

  it('a third click restarts the measurement from a new anchor', () => {
    render(<MeasureDistanceController active points={POINTS} />);
    click(39.9, -105.0); // A
    click(41.1, -105.0); // C -> completed pair
    expect(screen.queryByTestId('measure-line')).not.toBeNull();

    click(40.6, -105.0); // restart with B as the new anchor A
    expect(screen.queryByTestId('measure-line')).toBeNull();
    // one ring for the new anchor
    expect(screen.getAllByTestId('measure-ring')).toHaveLength(1);
  });

  it('sets a crosshair cursor while active and restores it on exit', () => {
    const { rerender } = render(<MeasureDistanceController active points={POINTS} />);
    expect(containerStyle.cursor).toBe('crosshair');
    rerender(<MeasureDistanceController active={false} points={POINTS} />);
    expect(containerStyle.cursor).toBe('');
  });

  it('Escape clears the measurement and calls onExit', () => {
    const onExit = vi.fn();
    render(<MeasureDistanceController active points={POINTS} onExit={onExit} />);
    click(39.9, -105.0);
    click(41.1, -105.0);
    expect(screen.queryByTestId('measure-line')).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('measure-line')).toBeNull();
  });
});
