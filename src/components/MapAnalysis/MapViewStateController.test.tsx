/**
 * @vitest-environment jsdom
 *
 * MapViewStateController (#4371 A) — publishes the 2D map's live camera into
 * the shared `mapViewRef` so the 3D branch can mount at the same view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import { render } from '@testing-library/react';
import MapViewStateController from './MapViewStateController';
import type { MapViewState } from './MapAnalysisContext';

type MoveEndHandler = () => void;

let moveEndHandler: MoveEndHandler | null = null;
let center = { lat: 12, lng: 34 };
let zoom = 9;

const fakeMap = {
  on: vi.fn((event: string, handler: MoveEndHandler) => {
    if (event === 'moveend') moveEndHandler = handler;
  }),
  off: vi.fn(),
  getCenter: () => center,
  getZoom: () => zoom,
};

let mapMock: typeof fakeMap | null = fakeMap;
vi.mock('react-leaflet', () => ({
  useMap: () => mapMock,
}));

const mapViewRef = createRef<MapViewState | null>() as { current: MapViewState | null };
vi.mock('./MapAnalysisContext', () => ({
  useMapAnalysisCtx: () => ({ mapViewRef }),
}));

describe('MapViewStateController', () => {
  beforeEach(() => {
    moveEndHandler = null;
    fakeMap.on.mockClear();
    fakeMap.off.mockClear();
    mapMock = fakeMap;
    mapViewRef.current = null;
    center = { lat: 12, lng: 34 };
    zoom = 9;
  });

  it('seeds the shared ref at mount, before any pan', () => {
    render(<MapViewStateController />);
    expect(mapViewRef.current).toEqual({ center: [12, 34], zoom: 9, pitch: undefined, bearing: undefined });
  });

  it('republishes the live center/zoom on moveend', () => {
    render(<MapViewStateController />);
    center = { lat: -20, lng: 100 };
    zoom = 14;
    moveEndHandler?.();
    expect(mapViewRef.current).toMatchObject({ center: [-20, 100], zoom: 14 });
  });

  it('preserves a pitch/bearing recorded by a previous 3D session (Leaflet has neither)', () => {
    mapViewRef.current = { center: [0, 0], zoom: 3, pitch: 55, bearing: 120 };
    render(<MapViewStateController />);
    expect(mapViewRef.current).toEqual({ center: [12, 34], zoom: 9, pitch: 55, bearing: 120 });
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<MapViewStateController />);
    unmount();
    expect(fakeMap.off).toHaveBeenCalledWith('moveend', expect.any(Function));
  });

  it('is a no-op when useMap() has no map (suites that stub it to null)', () => {
    mapMock = null;
    expect(() => render(<MapViewStateController />)).not.toThrow();
    expect(mapViewRef.current).toBeNull();
  });

  it('renders nothing', () => {
    const { container } = render(<MapViewStateController />);
    expect(container.innerHTML).toBe('');
  });
});
