/**
 * @vitest-environment jsdom
 */
import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
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

// One stable map object: the controller keys its effects on it (#5959).
const mapMock = {
  getContainer: () => container,
  mouseEventToLatLng: (e: MouseEvent) => ({ lat: e.clientY, lng: e.clientX }),
  latLngToContainerPoint: ([lat, lng]: [number, number]) => ({ x: lng, y: lat }),
  dragging: { enable: vi.fn(), disable: vi.fn() },
};

vi.mock('react-leaflet', () => ({
  useMap: () => mapMock,
  // Renders inside the map container (portal) so a release over a ring
  // counts as "on the map"; the ref exposes getElement() like Leaflet's.
  CircleMarker: React.forwardRef(function CircleMarker(
    { center, pathOptions }: { center: [number, number]; pathOptions: { fillOpacity: number; color: string } },
    ref: React.Ref<{ getElement: () => HTMLElement | null }>,
  ) {
    const el = React.useRef<HTMLDivElement>(null);
    React.useImperativeHandle(ref, () => ({ getElement: () => el.current }));
    return ReactDOM.createPortal(
      <div
        ref={el}
        data-testid="link-ring"
        data-lat={center[0]}
        data-lng={center[1]}
        data-filled={pathOptions.fillOpacity > 0}
        data-color={pathOptions.color}
      />,
      container,
    );
  }),
  Polyline: ({
    positions,
    pathOptions,
    children,
  }: {
    positions: [number, number][];
    pathOptions: { color: string };
    children?: React.ReactNode;
  }) => (
    <div data-testid="link-line" data-positions={JSON.stringify(positions)} data-color={pathOptions.color}>
      {children}
    </div>
  ),
  Pane: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="link-label">{children}</div>
  ),
}));

let unit: 'km' | 'mi' = 'km';
vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
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
      verdict={props.verdict}
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
    // Unmount first: the ring mocks portal into `container`.
    cleanup();
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
    // The drawn line's B longitude is unwrapped into A's 360-degree window
    // (#4111 Phase 3 WP-3 antimeridian fix) — A=100, C=900 differ by 800, so
    // the rendered position is 900 - 2*360 = 180 (the "line" test fixture
    // isn't real geography, but the unwrap math is deterministic for any
    // input). The tooltip label still uses the true (non-unwrapped) endpoints.
    expect(JSON.parse(line.getAttribute('data-positions')!)).toEqual([
      [100, 100],
      [100, 180],
    ]);
    expect(screen.getByTestId('link-label').textContent).toMatch(/km$/);
  });

  it('a third click does nothing once both endpoints are set (#5959)', () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    clickAt(105, 100); // A
    clickAt(895, 100); // C -> completed pair
    expect(onPick).toHaveBeenCalledTimes(2);

    clickAt(505, 100);
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId('link-ring')).toHaveLength(2);
    expect(screen.queryByTestId('link-line')).not.toBeNull();
  });

  describe('gesture guard (#5959)', () => {
    function pointer(type: string, x: number, y: number, pointerId = 1, target: EventTarget = container) {
      act(() => {
        const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
        Object.defineProperty(ev, 'pointerId', { value: pointerId });
        target.dispatchEvent(ev);
      });
    }

    it('ignores the click that ends a pan', () => {
      const onPick = vi.fn();
      render(<Harness onPick={onPick} />);
      pointer('pointerdown', 300, 300);
      pointer('pointermove', 340, 300);
      pointer('pointerup', 340, 300, 1, window);
      clickAt(340, 300);
      expect(onPick).not.toHaveBeenCalled();
    });

    it('still picks when the pointer barely moved', () => {
      const onPick = vi.fn();
      render(<Harness onPick={onPick} />);
      pointer('pointerdown', 300, 300);
      pointer('pointermove', 303, 301);
      pointer('pointerup', 303, 301, 1, window);
      clickAt(303, 301);
      expect(onPick).toHaveBeenCalledTimes(1);
    });

    it('ignores a pinch (two pointers down)', () => {
      const onPick = vi.fn();
      render(<Harness onPick={onPick} />);
      pointer('pointerdown', 300, 300, 1);
      pointer('pointerdown', 320, 300, 2);
      pointer('pointerup', 300, 300, 1, window);
      pointer('pointerup', 320, 300, 2, window);
      clickAt(300, 300);
      expect(onPick).not.toHaveBeenCalled();
    });

    it('ignores a Shift click (box zoom)', () => {
      const onPick = vi.fn();
      render(<Harness onPick={onPick} />);
      act(() => {
        container.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 300, clientY: 300, shiftKey: true }),
        );
      });
      expect(onPick).not.toHaveBeenCalled();
    });

    it('holding Space navigates only, with a grab cursor', () => {
      const onPick = vi.fn();
      render(<Harness onPick={onPick} />);
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
      });
      expect(container.style.cursor).toBe('grab');
      clickAt(300, 300);
      expect(onPick).not.toHaveBeenCalled();

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ' }));
      });
      expect(container.style.cursor).toBe('crosshair');
      clickAt(300, 300);
      expect(onPick).toHaveBeenCalledTimes(1);
    });
  });

  describe('dragging an endpoint (#5959)', () => {
    function pointerAt(type: string, target: EventTarget, x: number, y: number) {
      act(() => {
        const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
        Object.defineProperty(e, 'pointerId', { value: 7 });
        Object.defineProperty(e, 'pointerType', { value: 'mouse' });
        target.dispatchEvent(e);
      });
    }
    const ring = (i: number) => screen.getAllByTestId('link-ring')[i];

    it('moves B and snaps the drop to a nearby node', () => {
      const onPick = vi.fn();
      render(<Harness onPick={onPick} />);
      clickAt(105, 100); // A = node a
      clickAt(300, 300); // B = arbitrary point
      pointerAt('pointerdown', ring(1), 300, 300);
      expect(mapMock.dragging.disable).toHaveBeenCalled();
      pointerAt('pointermove', container, 480, 110);
      expect(ring(1).getAttribute('data-lng')).toBe('480');
      pointerAt('pointerup', container, 495, 104); // within the snap radius of node b (100,500)
      const last = onPick.mock.calls.at(-1)![0] as LinkEndpoint[];
      expect(last[0].id).toBe('a');
      expect(last[1]).toMatchObject({ id: 'b', isNode: true });
      expect(mapMock.dragging.enable).toHaveBeenCalled();
      // The click that follows the release does not pick.
      clickAt(495, 104);
      expect(onPick.mock.calls.at(-1)![0]).toBe(last);
    });

    it('leaves the endpoint in place when released outside the map', () => {
      const onPick = vi.fn();
      render(<Harness onPick={onPick} />);
      clickAt(105, 100);
      clickAt(300, 300);
      const calls = onPick.mock.calls.length;
      pointerAt('pointerdown', ring(1), 300, 300);
      pointerAt('pointermove', container, 600, 600);
      pointerAt('pointerup', document.body, 600, 600);
      expect(onPick.mock.calls.length).toBe(calls);
      expect(ring(1).getAttribute('data-lng')).toBe('300');
    });

    it("refuses a drop onto the other endpoint's node", () => {
      const onPick = vi.fn();
      render(<Harness onPick={onPick} />);
      clickAt(105, 100); // A = node a
      clickAt(505, 100); // B = node b
      const calls = onPick.mock.calls.length;
      pointerAt('pointerdown', ring(1), 500, 100);
      pointerAt('pointerup', container, 102, 100); // onto node a
      expect(onPick.mock.calls.length).toBe(calls);
    });
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

  describe('verdict coloring (#4111 Phase 3 WP-3)', () => {
    it('defaults to amber (pending) when no verdict is supplied', () => {
      render(<Harness />);
      clickAt(105, 100);
      clickAt(895, 100);
      expect(screen.getByTestId('link-line').getAttribute('data-color')).toBe('#f59e0b');
      for (const ring of screen.getAllByTestId('link-ring')) {
        expect(ring.getAttribute('data-color')).toBe('#f59e0b');
      }
    });

    it('defaults to amber (pending) when verdict is explicitly null', () => {
      render(<Harness verdict={null} />);
      clickAt(105, 100);
      clickAt(895, 100);
      expect(screen.getByTestId('link-line').getAttribute('data-color')).toBe('#f59e0b');
    });

    it.each([
      ['clear', '#22c55e'],
      ['marginal', '#f59e0b'],
      ['obstructed', '#ef4444'],
    ] as const)('colors the line and rings %s -> %s', (verdict, color) => {
      render(<Harness verdict={verdict} />);
      clickAt(105, 100);
      clickAt(895, 100);
      expect(screen.getByTestId('link-line').getAttribute('data-color')).toBe(color);
      for (const ring of screen.getAllByTestId('link-ring')) {
        expect(ring.getAttribute('data-color')).toBe(color);
      }
    });
  });

  describe('antimeridian unwrap (#4111 Phase 3 WP-3)', () => {
    it('draws the short way across +/-180 instead of the long way around', () => {
      const antimeridianPoints: LinkEndpoint[] = [
        { id: 'east', lat: 100, lng: 179, label: 'East', isNode: true },
        { id: 'west', lat: 100, lng: -179, label: 'West', isNode: true },
      ];
      render(<Harness points={antimeridianPoints} />);
      // East point sits at container (179,100); West at (-179,100) — click
      // directly on each so the snap logic resolves them unambiguously.
      clickAt(179, 100);
      clickAt(-179, 100);
      const line = screen.getByTestId('link-line');
      const positions = JSON.parse(line.getAttribute('data-positions')!);
      expect(positions[0]).toEqual([100, 179]);
      // -179 unwrapped into A's (179) 360-degree window is 181, not -179 —
      // a short 2-degree hop instead of the 358-degree long way around.
      expect(positions[1][1]).toBeCloseTo(181, 5);
    });
  });
});
