/**
 * Shared map-click picker (#4727).
 *
 * Now serves BOTH the Terrain Link Profile and the Site Planner, so a change
 * here silently changes two tools. The behaviours pinned are the ones a user
 * would feel: snapping is screen-space (so it feels identical at every zoom),
 * Leaflet controls stay clickable while a pick tool is active, and a snapped
 * result keeps the node's identity rather than degrading to a bare coordinate.
 */
import { describe, it, expect } from 'vitest';
import { resolvePickedPoint, MAP_PICK_SNAP_PX } from './mapClickPicker';

/** Minimal Leaflet-map stand-in: 1 degree == 100 px, origin at (0,0). */
function fakeMap(overrides: Record<string, unknown> = {}) {
  return {
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    mouseEventToLatLng: (e: MouseEvent) => ({ lat: e.clientY / 100, lng: e.clientX / 100 }),
    latLngToContainerPoint: ([lat, lng]: [number, number]) => ({ x: lng * 100, y: lat * 100 }),
    ...overrides,
  } as any;
}

const evt = (x: number, y: number, target: unknown = null) =>
  ({ clientX: x, clientY: y, target }) as unknown as MouseEvent;

const NODE = { id: 'node-a', lat: 1, lng: 1, name: 'Hilltop' };

describe('resolvePickedPoint', () => {
  it('snaps to a node within the threshold and keeps its identity', () => {
    // Degrading a snapped node to a bare coordinate would lose the name the
    // panel shows and the node the caller expects.
    const picked = resolvePickedPoint(fakeMap(), evt(100 + 5, 100 + 5), [NODE]);
    expect(picked).toMatchObject({ id: 'node-a', name: 'Hilltop', isNode: true });
  });

  it('treats a click beyond the threshold as an arbitrary point', () => {
    const picked = resolvePickedPoint(fakeMap(), evt(100 + MAP_PICK_SNAP_PX + 10, 100), [NODE]);
    expect(picked?.isNode).toBe(false);
    expect(picked?.id).not.toBe('node-a');
  });

  it('measures the threshold in SCREEN pixels, not degrees', () => {
    // The same geographic offset must snap when zoomed in and not when zoomed
    // out — a fixed metre radius would be unhittable at low zoom.
    const zoomedOut = fakeMap({ latLngToContainerPoint: ([lat, lng]: [number, number]) => ({ x: lng * 1, y: lat * 1 }) });
    const zoomedIn = fakeMap({ latLngToContainerPoint: ([lat, lng]: [number, number]) => ({ x: lng * 10_000, y: lat * 10_000 }) });

    // Click at the node's own screen position snaps under either projection…
    expect(resolvePickedPoint(zoomedOut, evt(1, 1), [NODE])?.isNode).toBe(true);
    // …but a click 50px away from a far-apart node does not.
    expect(resolvePickedPoint(zoomedIn, evt(10_050, 10_000), [NODE])?.isNode).toBe(false);
  });

  it('returns null for clicks on Leaflet controls so they keep working', () => {
    // Without this the capture-phase listener swallows zoom/attribution
    // clicks and the map becomes unusable while a tool is active.
    const control = { closest: (sel: string) => (sel === '.leaflet-control' ? {} : null) };
    expect(resolvePickedPoint(fakeMap(), evt(100, 100, control), [NODE])).toBeNull();
  });

  it('works with no candidate nodes at all', () => {
    // Siting a repeater where nothing is deployed yet is the Site Planner's
    // whole purpose.
    const picked = resolvePickedPoint(fakeMap(), evt(250, 250), []);
    expect(picked).toMatchObject({ isNode: false });
    expect(picked?.lat).toBeCloseTo(2.5, 6);
    expect(picked?.lng).toBeCloseTo(2.5, 6);
  });

  it('honours an explicit threshold override', () => {
    const far = evt(100 + 40, 100);
    expect(resolvePickedPoint(fakeMap(), far, [NODE])?.isNode).toBe(false);
    expect(resolvePickedPoint(fakeMap(), far, [NODE], 60)?.isNode).toBe(true);
  });

  it('picks the nearest of several candidates', () => {
    const near = { id: 'near', lat: 1, lng: 1 };
    const far = { id: 'far', lat: 5, lng: 5 };
    expect(resolvePickedPoint(fakeMap(), evt(100, 100), [far, near])?.id).toBe('near');
  });
});
