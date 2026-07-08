/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { MeasurePoint } from '../utils/measureDistance';

// Real container element the controller attaches its capture-phase listener to.
// `mouseEventToLatLng` maps clientX/clientY straight to lng/lat so a synthetic
// click at (x,y) resolves to { lat: y, lng: x }.
const container = document.createElement('div');
container.style.cursor = '';

vi.mock('react-leaflet', () => ({
  useMap: () => ({
    getContainer: () => container,
    mouseEventToLatLng: (e: MouseEvent) => ({ lat: e.clientY, lng: e.clientX }),
  }),
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

// Points laid out along one latitude so nearest-by-distance ≈ nearest clientX.
const POINTS: MeasurePoint[] = [
  { id: 'a', lat: 100, lng: 100, label: 'A' },
  { id: 'b', lat: 100, lng: 500, label: 'B' },
  { id: 'c', lat: 100, lng: 900, label: 'C' },
];

// Click at pixel (x,y) on a given element inside the container (defaults to the
// container itself). Capture-phase listener picks it up regardless of target.
function clickAt(x: number, y: number, target: EventTarget = container) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
}

describe('MeasureDistanceController', () => {
  beforeEach(() => {
    container.style.cursor = '';
    unit = 'km';
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    container.innerHTML = '';
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
    clickAt(110, 100); // nearest A
    clickAt(890, 100); // nearest C

    const line = screen.getByTestId('measure-line');
    expect(JSON.parse(line.getAttribute('data-positions')!)).toEqual([
      [100, 100],
      [100, 900],
    ]);
    expect(screen.getByTestId('measure-label').textContent).toMatch(/km$/);
  });

  it('registers a click that lands on a marker element (not just the background)', () => {
    render(<MeasureDistanceController active points={POINTS} />);
    // Simulate a click whose DOM target is a marker icon nested in the container.
    const marker = document.createElement('div');
    marker.className = 'leaflet-marker-icon';
    container.appendChild(marker);
    clickAt(110, 100, marker);
    clickAt(510, 100, marker); // nearest B
    const line = screen.getByTestId('measure-line');
    expect(JSON.parse(line.getAttribute('data-positions')!)).toEqual([
      [100, 100],
      [100, 500],
    ]);
  });

  it('ignores clicks on leaflet controls', () => {
    render(<MeasureDistanceController active points={POINTS} />);
    const zoom = document.createElement('div');
    zoom.className = 'leaflet-control';
    container.appendChild(zoom);
    clickAt(110, 100, zoom);
    expect(screen.queryByTestId('measure-ring')).toBeNull();
  });

  it('honors the miles preference', () => {
    unit = 'mi';
    render(<MeasureDistanceController active points={POINTS} />);
    clickAt(110, 100);
    clickAt(510, 100);
    expect(screen.getByTestId('measure-label').textContent).toMatch(/mi$/);
  });

  it('a third click restarts the measurement from a new anchor', () => {
    render(<MeasureDistanceController active points={POINTS} />);
    clickAt(110, 100); // A
    clickAt(890, 100); // C -> completed pair
    expect(screen.queryByTestId('measure-line')).not.toBeNull();

    clickAt(510, 100); // restart with B as the new anchor A
    expect(screen.queryByTestId('measure-line')).toBeNull();
    expect(screen.getAllByTestId('measure-ring')).toHaveLength(1);
  });

  it('ignores re-picking the same node as the first anchor', () => {
    render(<MeasureDistanceController active points={POINTS} />);
    clickAt(110, 100); // A
    clickAt(120, 100); // still nearest A -> ignored, no pair
    expect(screen.queryByTestId('measure-line')).toBeNull();
    expect(screen.getAllByTestId('measure-ring')).toHaveLength(1);
  });

  it('sets a crosshair cursor while active and restores it on exit', () => {
    const { rerender } = render(<MeasureDistanceController active points={POINTS} />);
    expect(container.style.cursor).toBe('crosshair');
    rerender(<MeasureDistanceController active={false} points={POINTS} />);
    expect(container.style.cursor).toBe('');
  });

  it('Escape clears the measurement and calls onExit', () => {
    const onExit = vi.fn();
    render(<MeasureDistanceController active points={POINTS} onExit={onExit} />);
    clickAt(110, 100);
    clickAt(890, 100);
    expect(screen.queryByTestId('measure-line')).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('measure-line')).toBeNull();
  });
});
