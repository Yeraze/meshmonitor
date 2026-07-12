// @vitest-environment jsdom
/**
 * Tests for useMarkerSpiderfier:
 *  - issue #3612 follow-up: pre-init marker-registration buffering.
 *  - issue #4046 item 4: zoom-gated spiderfier registration (below a
 *    threshold, markers are withheld and clicks fall through to the
 *    "zoom in first" flow instead of spiderfying a large low-zoom pile).
 *  - issue #4046 item 1: re-spiderfy after zoom settles (tracks the
 *    last-spiderfied group and recomputes it fresh on zoomend).
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
 * receives (the fix under test is the hook's buffer/flush, not OMS internals)
 * but does implement enough of the real event-listener/`spiderListener`
 * surface for the gating/respiderfy tests below.
 *
 * NOTE (documented mock limitation): this fake OMS can't prove real fan
 * geometry (circle/spiral foot placement) — it only proves the hook's own
 * bookkeeping (which markers get registered/withheld, and that a recompute
 * is triggered). Real fan behavior needs browser validation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useLayoutEffect, useRef } from 'react';
import { render, act } from '@testing-library/react';

// Fake OverlappingMarkerSpiderfier — records what it's handed and supports
// the subset of the real event/listener API the hook depends on. Defined via
// vi.hoisted so the hoisted vi.mock factory can reference it.
const { FakeOMS } = vi.hoisted(() => {
  class FakeOMS {
    markers: unknown[] = [];
    nearbyDistance = 0;
    listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    spiderListenerCalls: unknown[] = [];
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
    addListener(event: string, handler: (...args: unknown[]) => void) {
      (this.listeners[event] ??= []).push(handler);
    }
    removeListener(event: string, handler: (...args: unknown[]) => void) {
      this.listeners[event] = (this.listeners[event] ?? []).filter(h => h !== handler);
    }
    trigger(event: string, ...args: unknown[]) {
      (this.listeners[event] ?? []).forEach(h => h(...args));
    }
    clearMarkers() {
      this.markers = [];
    }
    // Private in the real library, but this is exactly what its own
    // per-marker click handler calls — the hook reaches into it (via a
    // typed cast) for #4046 item 1's re-spiderfy. Recorded here so tests can
    // assert it was invoked with the expected anchor.
    spiderListener(marker: unknown) {
      this.spiderListenerCalls.push(marker);
    }
  }
  return { FakeOMS };
});

// A minimal but functional fake Leaflet Map: tracks zoom and dispatches
// 'zoomstart'/'zoomend' listeners so tests can simulate a zoom change the
// same way the hook observes it in the browser.
const { createFakeMap } = vi.hoisted(() => {
  function createFakeMap(initialZoom: number) {
    let zoom = initialZoom;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
      getZoom: () => zoom,
      setZoomSilently: (z: number) => { zoom = z; },
      setView: vi.fn((_latlng: unknown, z: number) => { zoom = z; }),
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handler);
      },
      off: (event: string, handler: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(handler);
      },
      fire: (event: string, ...args: unknown[]) => {
        listeners.get(event)?.forEach(h => h(...args));
      },
      // Simulates a full zoom transition: fires zoomstart, updates zoom,
      // then fires zoomend — mirroring real Leaflet's event order.
      zoomTo: (z: number) => {
        listeners.get('zoomstart')?.forEach(h => h());
        zoom = z;
        listeners.get('zoomend')?.forEach(h => h());
      },
    };
  }
  return { createFakeMap };
});

let currentFakeMap: ReturnType<typeof createFakeMap> = createFakeMap(15);

vi.mock('react-leaflet', () => ({
  useMap: () => currentFakeMap,
}));
vi.mock('ts-overlapping-marker-spiderfier-leaflet', () => ({
  OverlappingMarkerSpiderfier: FakeOMS,
}));

import L from 'leaflet';
import { useMarkerSpiderfier, SHARED_SPIDERFIER_OPTIONS, DEFAULT_ZOOM_GATE_THRESHOLD } from './useMarkerSpiderfier';

let api: ReturnType<typeof useMarkerSpiderfier> | null = null;

/**
 * Mirrors the real consumers: registers a marker in a layout effect (pre-init
 * timing) just as react-leaflet's <Marker ref> fires during commit.
 */
function Harness({ nodeId, lat = 0.0005, lon = 0.0005, options = SHARED_SPIDERFIER_OPTIONS }: {
  nodeId: string;
  lat?: number;
  lon?: number;
  options?: typeof SHARED_SPIDERFIER_OPTIONS;
}) {
  const hook = useMarkerSpiderfier(options);
  api = hook;
  const markerRef = useRef<L.Marker>(L.marker([lat, lon]));
  useLayoutEffect(() => {
    hook.addMarker(markerRef.current, nodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe('useMarkerSpiderfier registration timing (#3612)', () => {
  beforeEach(() => {
    api = null;
    currentFakeMap = createFakeMap(15); // above the default z13 gate
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

describe('useMarkerSpiderfier zoom-gated registration (#4046 item 4)', () => {
  beforeEach(() => {
    api = null;
  });
  afterEach(() => {
    api = null;
  });

  it('withholds a marker from the spiderfier when mounted below the threshold', () => {
    currentFakeMap = createFakeMap(DEFAULT_ZOOM_GATE_THRESHOLD - 1);
    render(<Harness nodeId="node-1" />);

    const oms = api!.getSpiderfier() as unknown as FakeOMS;
    expect(oms.markers.length).toBe(0);
    expect(api!.isAboveGateThreshold).toBe(false);
  });

  it('registers markers with the spiderfier when mounted at/above the threshold', () => {
    currentFakeMap = createFakeMap(DEFAULT_ZOOM_GATE_THRESHOLD);
    render(<Harness nodeId="node-1" />);

    const oms = api!.getSpiderfier() as unknown as FakeOMS;
    expect(oms.markers.length).toBe(1);
    expect(api!.isAboveGateThreshold).toBe(true);
  });

  it('registers withheld markers once zoom crosses back above the threshold', () => {
    currentFakeMap = createFakeMap(DEFAULT_ZOOM_GATE_THRESHOLD - 1);
    render(<Harness nodeId="node-1" />);
    const oms = api!.getSpiderfier() as unknown as FakeOMS;
    expect(oms.markers.length).toBe(0);

    act(() => {
      currentFakeMap.zoomTo(DEFAULT_ZOOM_GATE_THRESHOLD);
    });

    expect(oms.markers.length).toBe(1);
    expect(api!.isAboveGateThreshold).toBe(true);
  });

  it('deregisters markers once zoom crosses below the threshold', () => {
    currentFakeMap = createFakeMap(DEFAULT_ZOOM_GATE_THRESHOLD);
    render(<Harness nodeId="node-1" />);
    const oms = api!.getSpiderfier() as unknown as FakeOMS;
    expect(oms.markers.length).toBe(1);

    act(() => {
      currentFakeMap.zoomTo(DEFAULT_ZOOM_GATE_THRESHOLD - 1);
    });

    expect(oms.markers.length).toBe(0);
    expect(api!.isAboveGateThreshold).toBe(false);
  });

  it('handleGatedClick centers and zooms in on the clicked marker (clamped, never zooms out)', () => {
    currentFakeMap = createFakeMap(5); // far zoomed out
    render(<Harness nodeId="node-1" options={{ ...SHARED_SPIDERFIER_OPTIONS, zoomGateTargetZoom: 17 }} />);

    const marker = L.marker([1, 2]);
    act(() => {
      api!.handleGatedClick(marker);
    });

    expect(currentFakeMap.setView).toHaveBeenCalledTimes(1);
    const [latlng, zoom] = currentFakeMap.setView.mock.calls[0];
    expect(latlng).toEqual(marker.getLatLng());
    expect(zoom).toBe(17); // clamped up from 5
  });

  it('handleGatedClick never zooms out below the current zoom', () => {
    currentFakeMap = createFakeMap(18); // already closer than the default target
    render(<Harness nodeId="node-1" />);

    const marker = L.marker([1, 2]);
    act(() => {
      api!.handleGatedClick(marker);
    });

    const [, zoom] = currentFakeMap.setView.mock.calls[0];
    expect(zoom).toBe(18); // clamp keeps current (already-closer) zoom
  });
});

describe('useMarkerSpiderfier re-spiderfy after zoom settles (#4046 item 1)', () => {
  beforeEach(() => {
    api = null;
    currentFakeMap = createFakeMap(15);
  });
  afterEach(() => {
    api = null;
  });

  it('re-triggers a fresh spiderfy computation for the last-spiderfied group on zoomend', () => {
    render(<Harness nodeId="node-1" />);
    const oms = api!.getSpiderfier() as unknown as FakeOMS;
    const marker = oms.markers[0];

    // Simulate OMS having spiderfied this marker's group.
    act(() => {
      oms.trigger('spiderfy', [marker], []);
    });

    act(() => {
      currentFakeMap.zoomTo(16);
    });

    // The vendored OMS's own zoomend listener would have called unspiderfy()
    // first in the real library; our fake doesn't model that internal wiring,
    // but the hook's zoomend handler should still re-invoke spiderListener
    // for the tracked anchor once above the gate.
    expect(oms.spiderListenerCalls).toEqual([marker]);
  });

  it('does not re-spiderfy after a deliberate (non-zoom) unspiderfy', () => {
    render(<Harness nodeId="node-1" />);
    const oms = api!.getSpiderfier() as unknown as FakeOMS;
    const marker = oms.markers[0];

    act(() => {
      oms.trigger('spiderfy', [marker], []);
      // A click-away unspiderfy — NOT preceded by our zoomstart handler.
      oms.trigger('unspiderfy', [marker], []);
    });

    act(() => {
      currentFakeMap.zoomTo(16);
    });

    expect(oms.spiderListenerCalls).toEqual([]);
  });

  it('does not re-spiderfy once the zoom has dropped below the gate threshold', () => {
    render(<Harness nodeId="node-1" />);
    const oms = api!.getSpiderfier() as unknown as FakeOMS;
    const marker = oms.markers[0];

    act(() => {
      oms.trigger('spiderfy', [marker], []);
    });

    act(() => {
      currentFakeMap.zoomTo(DEFAULT_ZOOM_GATE_THRESHOLD - 1);
    });

    expect(oms.spiderListenerCalls).toEqual([]);
    expect(oms.markers.length).toBe(0); // also deregistered per item 4
  });
});
