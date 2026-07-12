/**
 * @vitest-environment jsdom
 *
 * MapCenterController: zoom clamp (#4046 item 2) + duration scaling (item 3).
 * The pure math itself is covered by mapZoomAnimation.test.ts — this suite
 * proves the component wires that math into `map.setView` correctly and
 * respects the configurable `targetZoom` prop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import L from 'leaflet';
import {
  DEFAULT_TARGET_ZOOM,
  computeZoomAnimationDuration,
} from '../utils/mapZoomAnimation';

let currentZoom = 10;
const setViewMock = vi.fn();

vi.mock('react-leaflet', () => ({
  useMap: () => ({
    getContainer: () => ({ clientHeight: 800 }),
    getZoom: () => currentZoom,
    project: () => L.point(100, 100),
    unproject: (point: L.Point) => L.latLng(point.y, point.x),
    setView: setViewMock,
  }),
}));

import { MapCenterController } from './MapCenterController';

describe('MapCenterController (#4046 items 2 + 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setViewMock.mockClear();
    currentZoom = 10;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('zooms in to the default target (17) when further out', () => {
    currentZoom = 5;
    render(<MapCenterController centerTarget={[1, 2]} onCenterComplete={vi.fn()} />);

    expect(setViewMock).toHaveBeenCalledTimes(1);
    const [, zoom] = setViewMock.mock.calls[0];
    expect(zoom).toBe(DEFAULT_TARGET_ZOOM);
  });

  it('never zooms out when already closer than the target', () => {
    currentZoom = 18;
    render(<MapCenterController centerTarget={[1, 2]} onCenterComplete={vi.fn()} />);

    const [, zoom] = setViewMock.mock.calls[0];
    expect(zoom).toBe(18); // clamp keeps the current (closer) zoom
  });

  it('respects a configured targetZoom prop instead of the default', () => {
    currentZoom = 5;
    render(<MapCenterController centerTarget={[1, 2]} onCenterComplete={vi.fn()} targetZoom={12} />);

    const [, zoom] = setViewMock.mock.calls[0];
    expect(zoom).toBe(12);
  });

  it('scales the animation duration by the zoom delta', () => {
    currentZoom = 3;
    render(<MapCenterController centerTarget={[1, 2]} onCenterComplete={vi.fn()} targetZoom={17} />);

    const [, , options] = setViewMock.mock.calls[0];
    const expectedDuration = computeZoomAnimationDuration(3, 17);
    expect(options.duration).toBeCloseTo(expectedDuration, 5);
    expect(options.animate).toBe(true);
  });

  it('calls onCenterComplete after the (scaled) animation duration elapses', () => {
    currentZoom = 3;
    const onCenterComplete = vi.fn();
    render(<MapCenterController centerTarget={[1, 2]} onCenterComplete={onCenterComplete} targetZoom={17} />);

    const duration = computeZoomAnimationDuration(3, 17);
    act(() => {
      vi.advanceTimersByTime(duration * 1000 + 49);
    });
    expect(onCenterComplete).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(5);
    });
    expect(onCenterComplete).toHaveBeenCalledTimes(1);
  });

  it('does nothing when centerTarget is null', () => {
    render(<MapCenterController centerTarget={null} onCenterComplete={vi.fn()} />);
    expect(setViewMock).not.toHaveBeenCalled();
  });
});
