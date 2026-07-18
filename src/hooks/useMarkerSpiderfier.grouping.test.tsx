// @vitest-environment jsdom
/**
 * Real-OMS grouping regression tests for issue #4199 (Map Analysis spiderfy
 * click opening the popup of / selecting a nearby unrelated node instead of
 * fanning out the intended cluster).
 *
 * The other spiderfier test (`useMarkerSpiderfier.test.tsx`) mocks
 * `OverlappingMarkerSpiderfier` to test the hook's OWN bookkeeping, and its
 * header explicitly notes it "can't prove real fan geometry" — so it cannot
 * catch a regression in OMS's grouping decision itself. These tests exercise
 * the REAL vendored library against `SHARED_SPIDERFIER_OPTIONS` with a fake
 * Leaflet map whose `latLngToLayerPoint` is a fixed linear projection, so
 * `nearbyDistance` translates to a known pixel geometry.
 *
 * OMS decides a marker's group by comparing each registered marker's current
 * `getLatLng()` (projected to layer pixels) against the CLICKED marker's, and:
 *   - if the clicked marker is alone within `nearbyDistance` px -> fires 'click'
 *     (which the consumer turns into openPopup + select);
 *   - otherwise -> spiderfies the whole within-radius group.
 * The #4199 bug was that `nearbyDistance` was 50px — wide enough to sweep in a
 * genuinely-separate node ~40px away. These tests pin the corrected geometry.
 */
import { describe, it, expect } from 'vitest';
import L from 'leaflet';
import { OverlappingMarkerSpiderfier } from 'ts-overlapping-marker-spiderfier-leaflet';
import { SHARED_SPIDERFIER_OPTIONS } from './useMarkerSpiderfier';

// 0.001 degrees of lng == 1 layer pixel. Latitude flips sign so the projection
// is a plain, invertible linear map (enough for OMS's distance math).
const SCALE = 1000;

/** Fake Leaflet map: only the surface OMS touches, with a linear projection. */
function makeFakeMap(): L.Map {
  const map = {
    // OMS registers 'click'/'zoomend' -> unspiderfy in its constructor.
    addEventListener() {
      return map;
    },
    removeEventListener() {
      return map;
    },
    latLngToLayerPoint(ll: L.LatLng) {
      return L.point(ll.lng * SCALE, -ll.lat * SCALE);
    },
    layerPointToLatLng(pt: L.Point) {
      return L.latLng(-pt.y / SCALE, pt.x / SCALE);
    },
    hasLayer() {
      return true;
    },
    addLayer() {
      return map;
    },
    removeLayer() {
      return map;
    },
  };
  return map as unknown as L.Map;
}

/** A marker `px` pixels east of lng origin at the given lat-derived y (0 by default). */
function markerAtPx(xPx: number, yPx = 0): L.Marker {
  return L.marker([-yPx / SCALE, xPx / SCALE]);
}

interface ClickOutcome {
  /** The group OMS fanned out, or null if it fired a standalone 'click'. */
  spiderfied: L.Marker[] | null;
  /** The marker OMS treated as a standalone click, or null if it fanned. */
  clicked: L.Marker | null;
}

function buildOms(markers: L.Marker[], nearbyDistance?: number) {
  const oms = new OverlappingMarkerSpiderfier(
    makeFakeMap(),
    nearbyDistance == null
      ? SHARED_SPIDERFIER_OPTIONS
      : { ...SHARED_SPIDERFIER_OPTIONS, nearbyDistance },
  );
  for (const m of markers) oms.addMarker(m);
  return oms;
}

/** Simulate a real marker click (what OMS's own per-marker listener receives). */
function click(oms: OverlappingMarkerSpiderfier, marker: L.Marker): ClickOutcome {
  const outcome: ClickOutcome = { spiderfied: null, clicked: null };
  oms.addListener('spiderfy', (spiderfied: L.Marker[]) => {
    outcome.spiderfied = spiderfied;
  });
  oms.addListener('click', (m: L.Marker) => {
    outcome.clicked = m;
  });
  marker.fire('click', { target: marker });
  return outcome;
}

describe('OMS grouping geometry with SHARED_SPIDERFIER_OPTIONS (#4199)', () => {
  it('does not sweep an unrelated node ~40px away into a tight cluster', () => {
    const a = markerAtPx(0); // cluster
    const b = markerAtPx(5); // cluster (5px from a)
    const unrelated = markerAtPx(40); // separate node, 40px from the cluster
    const oms = buildOms([a, b, unrelated]);

    const { spiderfied } = click(oms, a);

    expect(spiderfied).not.toBeNull();
    expect(spiderfied).toContain(a);
    expect(spiderfied).toContain(b);
    // The regression: at the old 50px radius `unrelated` (40px away) was pulled
    // into the fan; at 20px it is correctly excluded.
    expect(spiderfied).not.toContain(unrelated);
    expect(spiderfied).toHaveLength(2);
  });

  it('clicking the unrelated node fans nothing and selects only itself', () => {
    const a = markerAtPx(0);
    const b = markerAtPx(5);
    const unrelated = markerAtPx(40);
    const oms = buildOms([a, b, unrelated]);

    const { spiderfied, clicked } = click(oms, unrelated);

    // Nothing within 20px of `unrelated` -> standalone 'click' on it only, never
    // a fan that drags in the far-away cluster.
    expect(spiderfied).toBeNull();
    expect(clicked).toBe(unrelated);
  });

  it('still fans exact-coincident markers (estimated-position / multi-source piles)', () => {
    const a = markerAtPx(0);
    const b = markerAtPx(0); // identical coordinates
    const oms = buildOms([a, b]);

    const { spiderfied } = click(oms, a);

    expect(spiderfied).not.toBeNull();
    expect(spiderfied).toHaveLength(2);
    expect(spiderfied).toContain(a);
    expect(spiderfied).toContain(b);
  });

  it('still fans a tight same-cell pile that overlaps within a marker width', () => {
    // Three obscured nodes whose within-cell offsets sit within ~15px at a low
    // zoom where their icons overlap.
    const a = markerAtPx(0);
    const b = markerAtPx(8, 6);
    const c = markerAtPx(14, -4);
    const oms = buildOms([a, b, c]);

    const { spiderfied } = click(oms, a);

    expect(spiderfied).not.toBeNull();
    expect(spiderfied).toHaveLength(3);
  });

  it('documents that the old 50px radius WOULD have grouped the unrelated node (why #4199 lowered it)', () => {
    const a = markerAtPx(0);
    const b = markerAtPx(5);
    const unrelated = markerAtPx(40);
    const oms = buildOms([a, b, unrelated], 50);

    const { spiderfied } = click(oms, a);

    expect(spiderfied).not.toBeNull();
    // At 50px the 40px-away node is (incorrectly) part of the fan — the bug.
    expect(spiderfied).toContain(unrelated);
    expect(spiderfied).toHaveLength(3);
  });
});

describe('SHARED_SPIDERFIER_OPTIONS.nearbyDistance (#4199 guard)', () => {
  it('is small enough to match genuine icon overlap, not a wide screen radius', () => {
    // Locks the fix: a value back up near the old 50px would re-open #4199.
    expect(SHARED_SPIDERFIER_OPTIONS.nearbyDistance).toBeLessThanOrEqual(25);
    // Still large enough to catch (near-)coincident markers reliably.
    expect(SHARED_SPIDERFIER_OPTIONS.nearbyDistance).toBeGreaterThanOrEqual(15);
  });
});
