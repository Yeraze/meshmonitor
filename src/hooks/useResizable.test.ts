/**
 * @vitest-environment jsdom
 *
 * useResizable clamped every resizable against `window.innerHeight * 0.8`,
 * including horizontal ones — capping a *width* against the viewport's
 * *height*. On a landscape phone that silently overrode whatever maxHeight the
 * caller asked for, which is the second half of the "node list won't go full
 * width on mobile" bug (the first half being NodesTab's own 50% ceiling).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import { useResizable } from './useResizable';

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, writable: true, configurable: true });
}

/** Drag the handle by `delta` px along the resize axis and return the new size. */
function drag(
  result: { current: ReturnType<typeof useResizable> },
  from: number,
  delta: number,
  axis: 'x' | 'y',
) {
  const pos = axis === 'x' ? { clientX: from, clientY: 0 } : { clientX: 0, clientY: from };
  act(() => {
    result.current.handleMouseDown({
      ...pos,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as React.MouseEvent);
  });
  const to = axis === 'x' ? from + delta : from - delta; // vertical grows upward
  act(() => {
    window.dispatchEvent(new MouseEvent('mousemove', {
      clientX: axis === 'x' ? to : 0,
      clientY: axis === 'y' ? to : 0,
    }));
  });
  return result.current.size;
}

const ORIGINAL = { w: window.innerWidth, h: window.innerHeight };

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  setViewport(ORIGINAL.w, ORIGINAL.h);
  vi.restoreAllMocks();
});

describe('useResizable — horizontal clamping uses viewport WIDTH', () => {
  it('lets a landscape phone drag a sidebar past 0.8 * viewport height', () => {
    // 844x390 landscape. The old ceiling was 390*0.8 = 312px, so a caller
    // asking for 844 could never exceed 312 — full width was unreachable.
    setViewport(844, 390);
    const { result } = renderHook(() => useResizable({
      id: 'test-landscape',
      defaultHeight: 300,
      minHeight: 200,
      maxHeight: 844,
      direction: 'horizontal',
    }));

    const size = drag(result, 300, 500, 'x');
    expect(size).toBeGreaterThan(390 * 0.8);
    expect(size).toBe(800); // 300 + 500, under the 844 ceiling
  });

  it('still refuses to exceed the viewport width', () => {
    setViewport(390, 844);
    const { result } = renderHook(() => useResizable({
      id: 'test-portrait-ceiling',
      defaultHeight: 300,
      minHeight: 200,
      maxHeight: 390,
      direction: 'horizontal',
    }));

    expect(drag(result, 300, 5000, 'x')).toBe(390);
  });

  it('honours a caller max below the viewport width (desktop 50% split)', () => {
    setViewport(1920, 1080);
    const { result } = renderHook(() => useResizable({
      id: 'test-desktop',
      defaultHeight: 380,
      minHeight: 200,
      maxHeight: 930,
      direction: 'horizontal',
    }));

    expect(drag(result, 380, 5000, 'x')).toBe(930);
  });

  it('never lets min win past the viewport when max < min on a tiny viewport', () => {
    setViewport(150, 800);
    const { result } = renderHook(() => useResizable({
      id: 'test-tiny',
      defaultHeight: 200,
      minHeight: 200,
      maxHeight: 100,
      direction: 'horizontal',
    }));

    expect(drag(result, 200, 500, 'x')).toBeLessThanOrEqual(150);
  });
});

describe('useResizable — the initial size is clamped to the current bounds', () => {
  it('clamps the persisted width that no longer fits, instead of overflowing', () => {
    // The real phone case: 380px desktop default inside a 342px container put
    // the drag handle at x=419 on a 390px-wide screen — off-screen, so the user
    // could not drag it back into range.
    setViewport(390, 844);
    localStorage.setItem('resizable_size_nodes-sidebar-width', '380');

    const { result } = renderHook(() => useResizable({
      id: 'nodes-sidebar-width',
      defaultHeight: 380,
      minHeight: 200,
      maxHeight: 342,
      direction: 'horizontal',
    }));

    expect(result.current.size).toBe(342);
    // The correction is persisted so it survives a reload.
    expect(localStorage.getItem('resizable_size_nodes-sidebar-width')).toBe('342');
  });

  it('clamps an unclamped default the same way', () => {
    setViewport(390, 844);
    const { result } = renderHook(() => useResizable({
      id: 'fresh-mobile',
      defaultHeight: 380,
      minHeight: 200,
      maxHeight: 342,
      direction: 'horizontal',
    }));
    expect(result.current.size).toBe(342);
  });

  it('leaves an in-range size untouched and does not write to storage', () => {
    setViewport(1920, 1080);
    localStorage.setItem('resizable_size_in-range', '500');
    const { result } = renderHook(() => useResizable({
      id: 'in-range',
      defaultHeight: 380,
      minHeight: 200,
      maxHeight: 930,
      direction: 'horizontal',
    }));
    expect(result.current.size).toBe(500);
    expect(localStorage.getItem('resizable_size_in-range')).toBe('500');
  });
});

describe('useResizable — vertical clamping is unchanged', () => {
  it('keeps the 0.8 * viewport height ceiling', () => {
    setViewport(1920, 1000);
    const { result } = renderHook(() => useResizable({
      id: 'test-vertical-ceiling',
      defaultHeight: 300,
      minHeight: 150,
      maxHeight: 5000, // deliberately above the guard
      direction: 'vertical',
    }));

    expect(drag(result, 500, 5000, 'y')).toBe(800); // 1000 * 0.8
  });

  it('honours a caller max below the guard', () => {
    setViewport(1920, 1000);
    const { result } = renderHook(() => useResizable({
      id: 'test-vertical-caller-max',
      defaultHeight: 280,
      minHeight: 120,
      maxHeight: 600,
      direction: 'vertical',
    }));

    expect(drag(result, 500, 5000, 'y')).toBe(600);
  });

  it('enforces the minimum', () => {
    setViewport(1920, 1000);
    const { result } = renderHook(() => useResizable({
      id: 'test-vertical-min',
      defaultHeight: 300,
      minHeight: 150,
      maxHeight: 600,
      direction: 'vertical',
    }));

    expect(drag(result, 500, -5000, 'y')).toBe(150);
  });
});
