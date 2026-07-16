/**
 * @vitest-environment jsdom
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { LinkEndpoint } from '../../utils/linkProfile';

// Real container element the controller attaches its capture-phase listener to.
// `mouseEventToLatLng` maps clientX/clientY straight to lng/lat so a synthetic
// click at (x,y) resolves to { lat: y, lng: x }. `latLngToContainerPoint` maps
// a [lat,lng] pair straight back to a container-space {x,y} point (inverse of
// the above), so a node at lat=100,lng=100 sits at screen (100,100) — letting
// the SNAP_PX threshold tests use plain pixel offsets.
const container = document.createElement('div');
container.style.cursor = '';
// jsdom's getBoundingClientRect() defaults to all-zero, matching the (0,0)
// origin `mouseEventToLatLng`/`latLngToContainerPoint` assume below.

vi.mock('react-leaflet', () => ({
  useMap: () => ({
    getContainer: () => container,
    mouseEventToLatLng: (e: MouseEvent) => ({ lat: e.clientY, lng: e.clientX }),
    latLngToContainerPoint: ([lat, lng]: [number, number]) => ({ x: lng, y: lat }),
  }),
  CircleMarker: ({ center, pathOptions }: { center: [number, number]; pathOptions: { fillOpacity: number } }) => (
    <div
      data-testid="link-ring"
      data-lat={center[0]}
      data-lng={center[1]}
      data-filled={pathOptions.fillOpacity > 0}
    />
  ),
  Polyline: ({ positions, children }: { positions: [number, number][]; children?: React.ReactNode }) => (
    <div data-testid="link-line" data-positions={JSON.stringify(positions)}>{children}</div>
  ),
  Tooltip: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="link-label">{children}</div>
  ),
}));

let unit: 'km' | 'mi' = 'km';
vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ distanceUnit: unit }),
}));

import LinkProfileController, { type LinkProfileControllerProps } from './LinkProfileController';

// Candidate node endpoints laid out along one latitude so nearest-by-distance
// (great-circle) agrees with nearest-by-clientX for these test coordinates.
const POINTS: LinkEndpoint[] = [
  { id: 'a', lat: 100, lng: 100, label: 'A', isNode: true },
  { id: 'b', lat: 100, lng: 500, label: 'B', isNode: true },
  { id: 'c', lat: 100, lng: 900, label: 'C', isNode: true },
];

/** Controlled-component harness mirroring how MapAnalysisCanvas (WP-D) wires
 * the controller to `linkEndpoints`/`setLinkEndpoints` in MapAnalysisContext. */
function Harness(props: Partial<LinkProfileControllerProps> & { points?: LinkEndpoint[] }) {
  const [endpoints, setEndpoints] = useState<LinkEndpoint[]>(props.endpoints ?? []);
  return (
    <LinkProfileController
      active={props.active ?? true}
      points={props.points ?? POINTS}
      endpoints={endpoints}
      onPick={(next) => {
        setEndpoints(next);
        props.onPick?.(next);
      }}
      onExit={props.onExit}
    />
  );
}

function clickAt(x: number, y: number, target: EventTarget = container) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
}

describe('LinkProfileController', () => {
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
    render(<Harness active={false} />);
    expect(screen.queryByTestId('link-ring')).toBeNull();
  });

  it('renders nothing (but is still active) with zero candidate nodes — arbitrary points still work', () => {
    render(<Harness points={[]} />);
    expect(screen.queryByTestId('link-ring')).toBeNull();
    clickAt(300, 300);
    expect(screen.getAllByTestId('link-ring')).toHaveLength(1);
  });

  it('snaps a click within SNAP_PX of a node to that node (isNode:true, filled marker)', () => {
    render(<Harness />);
    clickAt(105, 100); // 5px from node "a" at (100,100) — inside the 24px threshold
    const ring = screen.getByTestId('link-ring');
    expect(ring.getAttribute('data-lat')).toBe('100');
    expect(ring.getAttribute('data-lng')).toBe('100');
    expect(ring.getAttribute('data-filled')).toBe('true');
  });

  it('treats a click far from any node as an arbitrary point (isNode:false, hollow marker)', () => {
    render(<Harness />);
    clickAt(300, 300); // >24px from every candidate node
    const ring = screen.getByTestId('link-ring');
    expect(ring.getAttribute('data-lat')).toBe('300');
    expect(ring.getAttribute('data-lng')).toBe('300');
    expect(ring.getAttribute('data-filled')).toBe('false');
  });

  it('A-then-B sequence draws a connecting line and label', () => {
    render(<Harness />);
    clickAt(105, 100); // near A
    clickAt(895, 100); // near C
    const line = screen.getByTestId('link-line');
    expect(JSON.parse(line.getAttribute('data-positions')!)).toEqual([
      [100, 100],
      [100, 900],
    ]);
    expect(screen.getByTestId('link-label').textContent).toMatch(/km$/);
  });

  it('a third click restarts the pair from a new endpoint A', () => {
    render(<Harness />);
    clickAt(105, 100); // A
    clickAt(895, 100); // C -> completed pair
    expect(screen.queryByTestId('link-line')).not.toBeNull();

    clickAt(505, 100); // restart with B as the new anchor A
    expect(screen.queryByTestId('link-line')).toBeNull();
    expect(screen.getAllByTestId('link-ring')).toHaveLength(1);
  });

  it('ignores re-picking the same node as the first endpoint', () => {
    render(<Harness />);
    clickAt(105, 100); // A (node "a")
    clickAt(110, 100); // still snaps to node "a" -> ignored, no pair
    expect(screen.queryByTestId('link-line')).toBeNull();
    expect(screen.getAllByTestId('link-ring')).toHaveLength(1);
  });

  it('honors the miles preference in the connecting line label', () => {
    unit = 'mi';
    render(<Harness />);
    clickAt(105, 100);
    clickAt(505, 100);
    expect(screen.getByTestId('link-label').textContent).toMatch(/mi$/);
  });

  it('sets a crosshair cursor while active and restores it on exit', () => {
    const { rerender } = render(<Harness active />);
    expect(container.style.cursor).toBe('crosshair');
    rerender(<Harness active={false} />);
    expect(container.style.cursor).toBe('');
  });

  it('ignores clicks on leaflet controls', () => {
    render(<Harness />);
    const zoom = document.createElement('div');
    zoom.className = 'leaflet-control';
    container.appendChild(zoom);
    clickAt(105, 100, zoom);
    expect(screen.queryByTestId('link-ring')).toBeNull();
  });

  it('Escape clears the pair and calls onExit', () => {
    const onExit = vi.fn();
    render(<Harness onExit={onExit} />);
    clickAt(105, 100);
    clickAt(895, 100);
    expect(screen.queryByTestId('link-line')).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('link-line')).toBeNull();
    expect(screen.queryByTestId('link-ring')).toBeNull();
  });

  it('calls onPick with the same shape the parent context expects', () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    clickAt(105, 100);
    expect(onPick).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'a', lat: 100, lng: 100, isNode: true }),
    ]);
  });
});
