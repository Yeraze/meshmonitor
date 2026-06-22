/**
 * @vitest-environment jsdom
 *
 * Covers the shared spiderfy primitive used by ALL three map surfaces
 * (per-source NodesTab map, Map Analysis, Unified/Dashboard map) — issue #3612.
 *
 * The real OverlappingMarkerSpiderfier needs a live Leaflet map, so we mock
 * `useMarkerSpiderfier` and assert that:
 *   1. SpiderfierController feeds it the SHARED tuning (so every map fans out
 *      identically — notably the 50px nearbyDistance that catches co-located /
 *      estimated-position nodes the library's 20px default misses), and
 *   2. its imperative ref methods are exposed to callers (the marker ref bridge).
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createRef } from 'react';
import { SHARED_SPIDERFIER_OPTIONS } from '../hooks/useMarkerSpiderfier';

const addMarker = vi.fn();
const removeMarker = vi.fn();
const addListener = vi.fn();
const removeListener = vi.fn();
const getSpiderfier = vi.fn();
const useMarkerSpiderfierMock = vi.fn(() => ({
  addMarker,
  removeMarker,
  addListener,
  removeListener,
  getSpiderfier,
}));

vi.mock('../hooks/useMarkerSpiderfier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useMarkerSpiderfier')>();
  return {
    ...actual,
    useMarkerSpiderfier: (...args: unknown[]) => useMarkerSpiderfierMock(...(args as [])),
  };
});

import { SpiderfierController, type SpiderfierControllerRef } from './SpiderfierController';

describe('SHARED_SPIDERFIER_OPTIONS', () => {
  it('uses the tuned 50px nearbyDistance from the per-source reference (not the 20px default)', () => {
    // 50px is what lets co-located / estimated-position nodes group + spread.
    expect(SHARED_SPIDERFIER_OPTIONS.nearbyDistance).toBe(50);
    expect(SHARED_SPIDERFIER_OPTIONS.keepSpiderfied).toBe(true);
    expect(SHARED_SPIDERFIER_OPTIONS.circleFootSeparation).toBe(50);
    expect(SHARED_SPIDERFIER_OPTIONS.spiralFootSeparation).toBe(50);
  });
});

describe('SpiderfierController', () => {
  it('initializes the spiderfier with the SHARED tuning', () => {
    render(<SpiderfierController />);
    expect(useMarkerSpiderfierMock).toHaveBeenCalledWith(SHARED_SPIDERFIER_OPTIONS);
  });

  it('exposes the imperative add/remove API the marker ref bridge depends on', () => {
    const ref = createRef<SpiderfierControllerRef>();
    render(<SpiderfierController ref={ref} />);
    expect(ref.current).toBeTruthy();

    const marker = {} as never;
    ref.current!.addMarker(marker, 'src:42');
    expect(addMarker).toHaveBeenCalledWith(marker, 'src:42');

    ref.current!.removeMarker(marker);
    expect(removeMarker).toHaveBeenCalledWith(marker);
  });

  it('accepts an optional zoomLevel without requiring it', () => {
    // Map Analysis / Dashboard mount it with no zoom prop; NodesTab passes one.
    expect(() => render(<SpiderfierController zoomLevel={12} />)).not.toThrow();
  });
});
