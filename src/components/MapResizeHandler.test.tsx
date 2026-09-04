/**
 * @vitest-environment jsdom
 *
 * Issue #5054: rotating a phone left the map drawing tiles for the
 * pre-rotation box, and rotating back did not recover it, because nothing in
 * the app watched the viewport — only three call sites passed an internal
 * layout `trigger`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import MapResizeHandler, { MAP_RESIZE_SETTLE_MS } from './MapResizeHandler';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Container the fake map reports; sized so tests can drive a "resize". */
let container: HTMLDivElement;
let invalidateSize: ReturnType<typeof vi.fn>;

// Stable identity, like the real useMap(): a fresh object per render would
// re-run every effect keyed on `map` and hide a missing-memo bug.
const fakeMap = {
  invalidateSize: (...args: unknown[]) => invalidateSize(...args),
  getContainer: () => container,
};

vi.mock('react-leaflet', () => ({
  useMap: () => fakeMap,
}));

/**
 * Minimal ResizeObserver stand-in. jsdom has none, and the real one would not
 * fire anyway since jsdom does no layout — so the test drives the callback
 * directly, which is exactly the signal a real rotation delivers.
 */
type RoCallback = () => void;
const observers: { cb: RoCallback; targets: Element[]; disconnected: boolean }[] = [];

class FakeResizeObserver {
  private entry: { cb: RoCallback; targets: Element[]; disconnected: boolean };
  constructor(cb: RoCallback) {
    this.entry = { cb, targets: [], disconnected: false };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.targets.push(el);
    // Real observers deliver an initial observation on observe().
    this.entry.cb();
  }
  unobserve() {}
  disconnect() {
    this.entry.disconnected = true;
  }
}

/** Fire every live observer, as a viewport change would. */
const fireObservers = () => {
  for (const o of observers) {
    if (!o.disconnected) o.cb();
  }
};

/** Resize the container the way a rotation does, then notify the observer. */
const setContainerSize = (width: number, height: number) => {
  Object.defineProperty(container, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: height, configurable: true });
  fireObservers();
};

const settle = () => act(() => { vi.advanceTimersByTime(MAP_RESIZE_SETTLE_MS + 10); });

beforeEach(() => {
  vi.useFakeTimers();
  observers.length = 0;
  invalidateSize = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  setContainerSize(390, 700);
  observers.length = 0; // the size seed above predates any observer
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  container.remove();
});

// ---------------------------------------------------------------------------

describe('MapResizeHandler — viewport-driven invalidation (#5054)', () => {
  it('invalidates the map when the container box changes', () => {
    render(<MapResizeHandler />);

    // Initial observation must NOT invalidate — mount behaviour is unchanged.
    settle();
    expect(invalidateSize).not.toHaveBeenCalled();

    // Portrait → landscape.
    setContainerSize(700, 390);
    expect(invalidateSize).not.toHaveBeenCalled(); // debounced, not immediate
    settle();
    expect(invalidateSize).toHaveBeenCalledTimes(1);
  });

  it('recovers on the way back to portrait — the part #5054 says never healed', () => {
    render(<MapResizeHandler />);
    settle();

    setContainerSize(700, 390);
    settle();
    expect(invalidateSize).toHaveBeenCalledTimes(1);

    setContainerSize(390, 700);
    settle();
    expect(invalidateSize).toHaveBeenCalledTimes(2);
  });

  it('coalesces a rotation burst into a single invalidateSize', () => {
    render(<MapResizeHandler />);
    settle();
    invalidateSize.mockClear();

    // iOS reports several in-between boxes while the viewport transitions.
    setContainerSize(600, 500);
    setContainerSize(680, 420);
    setContainerSize(700, 390);
    act(() => { window.dispatchEvent(new Event('orientationchange')); });

    settle();
    expect(invalidateSize).toHaveBeenCalledTimes(1);
  });

  it('ignores an observer callback that reports the same box', () => {
    render(<MapResizeHandler />);
    settle();
    invalidateSize.mockClear();

    fireObservers(); // same dimensions
    settle();
    expect(invalidateSize).not.toHaveBeenCalled();
  });

  it('does not invalidate after unmount', () => {
    const { unmount } = render(<MapResizeHandler />);
    settle();
    invalidateSize.mockClear();

    setContainerSize(700, 390);
    unmount(); // timer is still pending here
    settle();

    expect(invalidateSize).not.toHaveBeenCalled();
    expect(observers.every(o => o.disconnected)).toBe(true);
  });

  it('does not invalidate once the container has left the document', () => {
    render(<MapResizeHandler />);
    settle();
    invalidateSize.mockClear();

    setContainerSize(700, 390);
    container.remove();
    settle();

    expect(invalidateSize).not.toHaveBeenCalled();
  });

  it('falls back to window resize when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(<MapResizeHandler />);

    act(() => { window.dispatchEvent(new Event('resize')); });
    settle();
    expect(invalidateSize).toHaveBeenCalledTimes(1);
  });

  it('still responds to orientationchange with no container box change', () => {
    render(<MapResizeHandler />);
    settle();
    invalidateSize.mockClear();

    act(() => { window.dispatchEvent(new Event('orientationchange')); });
    settle();
    expect(invalidateSize).toHaveBeenCalledTimes(1);
  });
});

describe('MapResizeHandler — caller-driven trigger prop', () => {
  it('invalidates when the trigger changes', () => {
    const { rerender } = render(<MapResizeHandler trigger="a" />);
    settle();
    expect(invalidateSize).toHaveBeenCalledTimes(1); // mount fire, as before

    rerender(<MapResizeHandler trigger="b" />);
    settle();
    expect(invalidateSize).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate when the trigger is unchanged', () => {
    const { rerender } = render(<MapResizeHandler trigger="a" />);
    settle();
    invalidateSize.mockClear();

    rerender(<MapResizeHandler trigger="a" />);
    settle();
    expect(invalidateSize).not.toHaveBeenCalled();
  });

  it('stays dormant on mount when no trigger is passed', () => {
    render(<MapResizeHandler />);
    settle();
    expect(invalidateSize).not.toHaveBeenCalled();
  });

  it('debounces a trigger change and a viewport change together', () => {
    const { rerender } = render(<MapResizeHandler trigger="a" />);
    settle();
    invalidateSize.mockClear();

    rerender(<MapResizeHandler trigger="b" />);
    setContainerSize(700, 390);
    settle();
    expect(invalidateSize).toHaveBeenCalledTimes(1);
  });
});
