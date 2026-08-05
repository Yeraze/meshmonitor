// @vitest-environment jsdom
/**
 * Issue #4551: the zoom gate must key off marker DENSITY, not zoom alone.
 *
 * Before this, `zoomGateThreshold` (z13) made every below-threshold marker
 * click a "zoom in first" detour, so an isolated node 200km from anything
 * else needed a zoom-in/zoom-out cycle just to open its popup — identical
 * treatment to a 50-node pile. `isMarkerGated` narrows the gate: below the
 * threshold a click is withheld only when another tracked marker sits within
 * `nearbyDistance` screen pixels.
 *
 * These tests drive the hook through the same registration path the real
 * consumers use (a layout effect, mirroring react-leaflet's <Marker ref>
 * firing during commit).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useLayoutEffect, useRef } from 'react';
import { render } from '@testing-library/react';

const { FakeOMS } = vi.hoisted(() => {
  class FakeOMS {
    markers: unknown[] = [];
    listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(
      public map: unknown,
      public opts: unknown,
    ) {}
    addMarker(m: unknown) { this.markers.push(m); }
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
    clearMarkers() { this.markers = []; }
    spiderListener() {}
  }
  return { FakeOMS };
});

/**
 * Fake Leaflet map with a real-enough projection: a linear lat/lng -> pixel
 * mapping whose scale doubles per zoom level, exactly as a slippy-map
 * projection does. That keeps the "markers separate as you zoom in" property
 * the gate depends on, without pulling in Leaflet's full CRS machinery.
 *
 * At zoom 10 the scale is 1024 px per degree, so 0.01 degrees apart = ~10px
 * (inside the 20px nearbyDistance) and 1 degree apart = 1024px (well outside).
 */
const { createFakeMap } = vi.hoisted(() => {
  function createFakeMap(initialZoom: number, opts: { project?: boolean } = {}) {
    let zoom = initialZoom;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const map: Record<string, unknown> = {
      getZoom: () => zoom,
      setView: vi.fn((_latlng: unknown, z: number) => { zoom = z; }),
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handler);
      },
      off: (event: string, handler: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(handler);
      },
      zoomTo: (z: number) => {
        listeners.get('zoomstart')?.forEach(h => h());
        zoom = z;
        listeners.get('zoomend')?.forEach(h => h());
      },
    };
    // `project: false` simulates a map that cannot project (the defensive
    // branch in `isMarkerGated`).
    if (opts.project !== false) {
      map.latLngToLayerPoint = (ll: { lat: number; lng: number }) => {
        const scale = Math.pow(2, zoom);
        return { x: ll.lng * scale, y: -ll.lat * scale };
      };
    }
    return map;
  }
  return { createFakeMap };
});

let currentFakeMap: ReturnType<typeof createFakeMap> = createFakeMap(10);

vi.mock('react-leaflet', () => ({
  useMap: () => currentFakeMap,
}));
vi.mock('ts-overlapping-marker-spiderfier-leaflet', () => ({
  OverlappingMarkerSpiderfier: FakeOMS,
}));

import L from 'leaflet';
import { useMarkerSpiderfier, SHARED_SPIDERFIER_OPTIONS, DEFAULT_ZOOM_GATE_THRESHOLD } from './useMarkerSpiderfier';

// #4551 moved `zoomGateThreshold` out of SHARED_SPIDERFIER_OPTIONS — the layer
// resolves it from the `mapZoomGateThreshold` setting and passes it down. These
// tests target the hook directly, so they supply it themselves.
const GATED_OPTIONS = { ...SHARED_SPIDERFIER_OPTIONS, zoomGateThreshold: DEFAULT_ZOOM_GATE_THRESHOLD };

let api: ReturnType<typeof useMarkerSpiderfier> | null = null;

/** Registers every given marker, mirroring the real <Marker ref> timing. */
function Harness({ coords, options = GATED_OPTIONS }: {
  coords: Array<[number, number]>;
  options?: typeof GATED_OPTIONS;
}) {
  const hook = useMarkerSpiderfier(options);
  api = hook;
  const markersRef = useRef<L.Marker[]>(coords.map(([lat, lng]) => L.marker([lat, lng])));
  useLayoutEffect(() => {
    markersRef.current.forEach((m, i) => hook.addMarker(m, `node-${i}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  markerBag = markersRef.current;
  return null;
}

let markerBag: L.Marker[] = [];

describe('isMarkerGated — density-aware zoom gate (#4551)', () => {
  beforeEach(() => {
    api = null;
    markerBag = [];
  });
  afterEach(() => {
    api = null;
  });

  it('does NOT gate an isolated marker below the threshold — the reported bug', () => {
    // Two markers a full degree apart at z10 => 1024px. Far outside the 20px
    // nearbyDistance, so neither is ambiguous and the click should open the
    // popup directly instead of demanding a zoom-in first.
    currentFakeMap = createFakeMap(10); // below the z13 gate
    render(<Harness coords={[[0, 0], [0, 1]]} />);

    expect(api!.isAboveGateThreshold).toBe(false);
    expect(api!.isMarkerGated(markerBag[0])).toBe(false);
    expect(api!.isMarkerGated(markerBag[1])).toBe(false);
  });

  it('gates a crowded marker below the threshold — the behaviour #4046 wanted', () => {
    // 0.01 degrees apart at z10 => ~10px, inside the 20px radius.
    currentFakeMap = createFakeMap(10);
    render(<Harness coords={[[0, 0], [0, 0.01]]} />);

    expect(api!.isAboveGateThreshold).toBe(false);
    expect(api!.isMarkerGated(markerBag[0])).toBe(true);
    expect(api!.isMarkerGated(markerBag[1])).toBe(true);
  });

  it('gates only the crowded members of a mixed set', () => {
    // Two co-located markers plus one far away, all below the threshold.
    currentFakeMap = createFakeMap(10);
    render(<Harness coords={[[0, 0], [0, 0.005], [0, 5]]} />);

    expect(api!.isMarkerGated(markerBag[0])).toBe(true);
    expect(api!.isMarkerGated(markerBag[1])).toBe(true);
    expect(api!.isMarkerGated(markerBag[2])).toBe(false);
  });

  it('never gates a lone marker — it cannot match against itself', () => {
    currentFakeMap = createFakeMap(10);
    render(<Harness coords={[[0, 0]]} />);

    expect(api!.isMarkerGated(markerBag[0])).toBe(false);
  });

  it('never gates above the threshold, however crowded', () => {
    // Same co-located pair, but at z15 the layer is above the gate and OMS
    // handles the pile by spiderfying it.
    currentFakeMap = createFakeMap(15);
    render(<Harness coords={[[0, 0], [0, 0.000001]]} />);

    expect(api!.isAboveGateThreshold).toBe(true);
    expect(api!.isMarkerGated(markerBag[0])).toBe(false);
  });

  it('never gates when gating is disabled (threshold undefined)', () => {
    currentFakeMap = createFakeMap(2); // very far out
    render(
      <Harness
        coords={[[0, 0], [0, 0.000001]]}
        options={{ ...GATED_OPTIONS, zoomGateThreshold: undefined }}
      />
    );

    expect(api!.isMarkerGated(markerBag[0])).toBe(false);
  });

  it('honours a custom nearbyDistance', () => {
    // ~10px apart: inside a 20px radius, outside a 5px one.
    currentFakeMap = createFakeMap(10);
    render(
      <Harness
        coords={[[0, 0], [0, 0.01]]}
        options={{ ...GATED_OPTIONS, nearbyDistance: 5 }}
      />
    );

    expect(api!.isMarkerGated(markerBag[0])).toBe(false);
  });

  it('falls back to gating everything when the map cannot project', () => {
    // Defensive branch: without a projection we cannot measure crowding, so
    // preserve the pre-#4551 behaviour rather than letting a pile through.
    currentFakeMap = createFakeMap(10, { project: false });
    render(<Harness coords={[[0, 0], [0, 90]]} />);

    expect(api!.isMarkerGated(markerBag[0])).toBe(true);
  });

  it('re-evaluates after a zoom change without re-registering markers', () => {
    // Markers 0.05 degrees apart. At z10 that is ~51px (isolated); zooming out
    // to z8 shrinks it to ~13px (crowded). Same markers, opposite verdict —
    // this is why the check runs at click time rather than being cached.
    currentFakeMap = createFakeMap(10);
    render(<Harness coords={[[0, 0], [0, 0.05]]} />);

    expect(api!.isMarkerGated(markerBag[0])).toBe(false);

    (currentFakeMap.zoomTo as (z: number) => void)(8);
    expect(api!.isMarkerGated(markerBag[0])).toBe(true);
  });
});
