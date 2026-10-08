/**
 * @vitest-environment jsdom
 *
 * VectorTileLayer with a WORKING GL map: the guards must be pass-throughs,
 * a lost context must be survived, and cleanup must be safe to run twice.
 *
 * Real Leaflet and react-leaflet. The MapLibre adapter is replaced by a fake
 * with the real adapter's shape (same handler names, same `_glMap` field,
 * `_update` throttled in `initialize`, `getMaplibreMap()`), built on a small
 * evented GL map so tests can fire `webglcontextlost`. The no-WebGL path runs
 * against the real adapter in `map/BaseMap.noWebgl.test.tsx`.
 */
import { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import L from 'leaflet';
import { MapContainer } from 'react-leaflet';
import { VectorTileLayer, CONTEXT_RESTORE_GRACE_MS } from './VectorTileLayer';
import { BaseMap } from './map/BaseMap';

type Listener = () => void;
class FakeGlMap {
  listeners = new Map<string, Set<Listener>>();
  jumpTo = vi.fn();
  remove = vi.fn();
  on(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
    return this;
  }
  off(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
    return this;
  }
  fire(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

const fake = vi.hoisted(() => ({ glMaps: [] as unknown[], layers: [] as unknown[] }));
const glMaps = fake.glMaps as FakeGlMap[];
type FakeLayer = L.Layer & {
  _glMap: FakeGlMap | null;
  _map: L.Map | null;
  _update: () => void;
  _pinchZoom: () => void;
  _zoomEnd: () => void;
  _resize: () => void;
};
const layers = fake.layers as FakeLayer[];

vi.mock('@maplibre/maplibre-gl-leaflet', async () => {
  const leaflet = (await import('leaflet')).default;
  const FakeAdapter = leaflet.Layer.extend({
    options: { updateInterval: 0 },
    initialize(this: Record<string, unknown>, options: Record<string, unknown>) {
      leaflet.setOptions(this, options);
      // As in the real adapter: the PROTOTYPE `_update` is throttled here.
      this._throttledUpdate = leaflet.Util.throttle(this._update as () => void, 0, this);
    },
    onAdd(this: Record<string, unknown>) {
      this._glMap = new FakeGlMap();
      fake.glMaps.push(this._glMap);
    },
    onRemove(this: { _glMap: FakeGlMap | null }) {
      this._glMap!.remove();
      this._glMap = null;
    },
    getEvents(this: Record<string, unknown>) {
      return { move: this._throttledUpdate, zoom: this._pinchZoom, zoomend: this._zoomEnd, resize: this._resize };
    },
    getMaplibreMap(this: { _glMap: FakeGlMap | null }) {
      return this._glMap;
    },
    _update(this: { _glMap: FakeGlMap }) {
      this._glMap.jumpTo({});
    },
    _pinchZoom(this: { _glMap: FakeGlMap }) {
      this._glMap.jumpTo({});
    },
    _zoomEnd(this: { _glMap: FakeGlMap }) {
      this._glMap.jumpTo({});
    },
    _transitionEnd(this: { _glMap: FakeGlMap }) {
      this._glMap.jumpTo({});
    },
    _resize(this: { _transitionEnd: () => void }) {
      this._transitionEnd();
    },
  });
  (leaflet as unknown as { maplibreGL: (o: unknown) => L.Layer }).maplibreGL = (o) => {
    const layer = new (FakeAdapter as unknown as new (o: unknown) => L.Layer)(o);
    fake.layers.push(layer);
    return layer;
  };
  return {};
});
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

function renderLayer(onUnavailable = vi.fn()) {
  const mapRef = createRef<L.Map>();
  const utils = render(
    <div style={{ width: 400, height: 300 }}>
      <MapContainer center={[0, 0]} zoom={3} ref={mapRef} style={{ width: 400, height: 300 }}>
        <VectorTileLayer url="https://x/{z}/{x}/{y}.pbf" maxZoom={16} onUnavailable={onUnavailable} />
      </MapContainer>
    </div>,
  );
  return { mapRef, onUnavailable, ...utils };
}

beforeEach(() => {
  glMaps.length = 0;
  layers.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('VectorTileLayer with a live GL map', () => {
  it('the guards pass through: Leaflet events still reach the GL map', () => {
    const { mapRef, onUnavailable } = renderLayer();
    const gl = glMaps[0];
    mapRef.current!.fire('move');
    mapRef.current!.fire('zoom');
    mapRef.current!.fire('zoomend');
    mapRef.current!.fire('resize');
    expect(gl.jumpTo).toHaveBeenCalledTimes(4);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(mapRef.current!.getMaxZoom()).toBe(16);
  });

  it('unmount removes the GL map once and drops the context listeners', () => {
    const { unmount } = renderLayer();
    const gl = glMaps[0];
    expect(gl.count('webglcontextlost')).toBe(1);
    expect(() => unmount()).not.toThrow();
    expect(gl.remove).toHaveBeenCalledTimes(1);
    expect(gl.count('webglcontextlost')).toBe(0);
    expect(gl.count('webglcontextrestored')).toBe(0);
  });

  it('a handler that fires after the GL map is gone does nothing', () => {
    const { mapRef } = renderLayer();
    const layer = layers[0];
    const map = mapRef.current!;
    map.removeLayer(layer);
    expect(layer._glMap).toBeNull();
    // A throttled or queued call that outlives the layer.
    expect(() => {
      layer._update();
      layer._pinchZoom();
      layer._zoomEnd();
      layer._resize();
    }).not.toThrow();
    // Removing twice is safe too.
    expect(() => layer.onRemove(map)).not.toThrow();
  });
});

describe('VectorTileLayer when the WebGL context is lost', () => {
  it('waits: a context that comes back keeps the vector layer', () => {
    vi.useFakeTimers();
    const { mapRef, onUnavailable } = renderLayer();
    glMaps[0].fire('webglcontextlost');
    vi.advanceTimersByTime(CONTEXT_RESTORE_GRACE_MS - 1);
    glMaps[0].fire('webglcontextrestored');
    vi.advanceTimersByTime(CONTEXT_RESTORE_GRACE_MS * 2);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(mapRef.current!.hasLayer(layers[0])).toBe(true);
  });

  it('gives up when the context does not come back, and removes the layer', () => {
    vi.useFakeTimers();
    const { mapRef, onUnavailable, unmount } = renderLayer();
    glMaps[0].fire('webglcontextlost');
    // A second loss event does not restart the clock.
    vi.advanceTimersByTime(CONTEXT_RESTORE_GRACE_MS - 1);
    glMaps[0].fire('webglcontextlost');
    vi.advanceTimersByTime(1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith('context-lost');
    expect(mapRef.current!.hasLayer(layers[0])).toBe(false);
    expect(glMaps[0].remove).toHaveBeenCalledTimes(1);
    // Cleanup after a failure is a no-op, not a second removal.
    expect(() => unmount()).not.toThrow();
    expect(glMaps[0].remove).toHaveBeenCalledTimes(1);
  });

  it('unmount during the wait cancels it', () => {
    vi.useFakeTimers();
    const { onUnavailable, unmount } = renderLayer();
    glMaps[0].fire('webglcontextlost');
    unmount();
    vi.advanceTimersByTime(CONTEXT_RESTORE_GRACE_MS * 2);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('BaseMap swaps that one map to raster, and tries vector again on a new tileset', () => {
    vi.useFakeTimers();
    const mapRef = createRef<L.Map>();
    const ui = (tilesetId: string) => (
      <div style={{ width: 400, height: 300 }}>
        <BaseMap center={[0, 0]} zoom={3} tilesetId={tilesetId} mapRef={mapRef} />
      </div>
    );
    const { rerender } = render(ui('cartoPositron'));
    expect(glMaps).toHaveLength(1);
    expect(screen.queryByTestId('vector-fallback-notice')).toBeNull();

    glMaps[0].fire('webglcontextlost');
    act(() => {
      vi.advanceTimersByTime(CONTEXT_RESTORE_GRACE_MS);
    });

    const rasterUrls: string[] = [];
    mapRef.current!.eachLayer((l) => {
      if (l instanceof L.TileLayer) rasterUrls.push((l as L.TileLayer & { _url: string })._url);
    });
    expect(rasterUrls).toEqual(['https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png']);
    expect(screen.getByTestId('vector-fallback-notice').textContent).toContain('map.vector_context_lost_notice');
    // No new GL map was built for the same tileset.
    expect(glMaps).toHaveLength(1);

    rerender(ui('cartoDarkMatter'));
    expect(glMaps).toHaveLength(2);
    expect(screen.queryByTestId('vector-fallback-notice')).toBeNull();
  });
});
