// @vitest-environment jsdom
/**
 * Regression test for the spiderfier marker-registration timing bug
 * (issue #3612 follow-up: spiderfy not working on Map Analysis / Unified maps).
 *
 * React invokes a <Marker ref> callback during the commit phase, which runs
 * BEFORE the hook's init `useEffect` that creates the OverlappingMarkerSpiderfier.
 * Any marker present at first mount therefore tries to register while the
 * spiderfier is still null. The hook must buffer those markers and flush them
 * once the spiderfier exists — otherwise they're silently dropped and their
 * overlapping pile never fans out.
 *
 * We register the marker in a `useLayoutEffect`, which runs before the hook's
 * passive `useEffect` — reproducing the exact commit-phase ordering a real
 * <Marker ref> produces. A lightweight fake spiderfier records the markers it
 * receives (the fix under test is the hook's buffer/flush, not OMS internals).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useLayoutEffect, useRef } from 'react';
import { render } from '@testing-library/react';

// Fake OverlappingMarkerSpiderfier — records what it's handed, no Leaflet map
// needed. Defined via vi.hoisted so the hoisted vi.mock factory can reference it.
const { FakeOMS } = vi.hoisted(() => {
  class FakeOMS {
    markers: unknown[] = [];
    nearbyDistance = 0;
    constructor(
      public map: unknown,
      public opts: unknown,
    ) {}
    addMarker(m: unknown) {
      this.markers.push(m);
    }
    removeMarker(m: unknown) {
      const i = this.markers.indexOf(m);
      if (i >= 0) this.markers.splice(i, 1);
    }
    addListener() {}
    removeListener() {}
    clearMarkers() {
      this.markers = [];
    }
  }
  return { FakeOMS };
});

// A stable, truthy stub map is all the hook needs (it only checks `if (!map)`).
vi.mock('react-leaflet', () => {
  const stub = {};
  return { useMap: () => stub };
});
vi.mock('ts-overlapping-marker-spiderfier-leaflet', () => ({
  OverlappingMarkerSpiderfier: FakeOMS,
}));

import L from 'leaflet';
import { useMarkerSpiderfier, SHARED_SPIDERFIER_OPTIONS } from './useMarkerSpiderfier';

let api: ReturnType<typeof useMarkerSpiderfier> | null = null;

/**
 * Mirrors the real consumers: registers a marker in a layout effect (pre-init
 * timing) just as react-leaflet's <Marker ref> fires during commit.
 */
function Harness({ nodeId }: { nodeId: string }) {
  const hook = useMarkerSpiderfier(SHARED_SPIDERFIER_OPTIONS);
  api = hook;
  const markerRef = useRef<L.Marker>(L.marker([0.0005, 0.0005]));
  useLayoutEffect(() => {
    hook.addMarker(markerRef.current, nodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe('useMarkerSpiderfier registration timing (#3612)', () => {
  beforeEach(() => {
    api = null;
  });
  afterEach(() => {
    api = null;
  });

  it('registers a marker that mounted before the spiderfier was created', () => {
    render(<Harness nodeId="node-1" />);

    const oms = api!.getSpiderfier() as unknown as FakeOMS;
    expect(oms).toBeInstanceOf(FakeOMS);
    // The marker registered during the layout phase (before the init effect)
    // must have been buffered and flushed — not dropped.
    expect(oms.markers.length).toBe(1);
  });

  it('does not duplicate a marker re-registered with the same id after init', () => {
    const { rerender } = render(<Harness nodeId="node-1" />);
    const oms = api!.getSpiderfier() as unknown as FakeOMS;
    expect(oms.markers.length).toBe(1);

    // Re-register the SAME marker/id after init (normal re-render). Must dedupe.
    api!.addMarker(oms.markers[0] as L.Marker, 'node-1');
    rerender(<Harness nodeId="node-1" />);

    expect(oms.markers.length).toBe(1);
  });
});
