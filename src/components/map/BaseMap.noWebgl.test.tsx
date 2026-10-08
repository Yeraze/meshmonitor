/**
 * @vitest-environment jsdom
 *
 * A vector tileset in a browser with no WebGL2.
 *
 * Nothing map-related is mocked here: real Leaflet, real react-leaflet, the
 * real `@maplibre/maplibre-gl-leaflet` adapter and the real `maplibre-gl`.
 * jsdom has no WebGL, so `new maplibregl.Map()` throws the genuine
 * `GPUInitializationError` — the exact failure that used to leave a
 * half-added layer on the map, throw "reading 'jumpTo'" on the next move and
 * "reading 'remove'" on unmount, and empty `#root`.
 */
import { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import L from 'leaflet';
import { BaseMap } from './BaseMap';
import {
  isVectorRenderingAvailable,
  setVectorRenderingForTests,
  resetVectorSupportForTests,
} from './vectorSupport';
import type { CustomTileset } from '../../config/tilesets';

vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock('../TilesetSelector', () => ({
  TilesetSelector: ({ selectedTilesetId }: { selectedTilesetId: string }) => (
    <div data-testid="tileset-selector">{selectedTilesetId}</div>
  ),
}));

const customVector: CustomTileset = {
  id: 'custom-vec',
  name: 'Self-hosted vector',
  url: 'https://tiles.example.com/{z}/{x}/{y}.pbf',
  attribution: 'x',
  maxZoom: 16,
  description: '',
  createdAt: 0,
  updatedAt: 0,
};

type Internals = L.Layer & { _url?: string; _glMap?: unknown; getMaplibreMap?: unknown };

function layersOf(map: L.Map) {
  const raster: string[] = [];
  let vector = 0;
  map.eachLayer((layer) => {
    const l = layer as Internals;
    if (typeof l.getMaplibreMap === 'function') vector += 1;
    else if (layer instanceof L.TileLayer) raster.push(l._url ?? '');
  });
  return { raster, vector };
}

/** Every Leaflet event the adapter binds: move, zoom and resize. */
function driveMap(map: L.Map) {
  map.fire('move');
  map.fire('zoomstart');
  map.fire('zoom');
  map.fire('zoomanim', { center: map.getCenter(), zoom: 4 });
  map.fire('zoomend');
  map.fire('resize', { oldSize: L.point(400, 300), newSize: L.point(390, 844) });
  map.setView([10, 10], 5, { animate: false });
  map.invalidateSize();
}

function renderMap(tilesetId: string, extra: Partial<Parameters<typeof BaseMap>[0]> = {}) {
  const mapRef = createRef<L.Map>();
  const utils = render(
    <div style={{ width: 400, height: 300 }}>
      <BaseMap center={[0, 0]} zoom={3} tilesetId={tilesetId} mapRef={mapRef} {...extra} />
    </div>,
  );
  return { mapRef, ...utils };
}

let getContext: ReturnType<typeof vi.spyOn>;
let consoleError: ReturnType<typeof vi.spyOn>;
let uncaught: unknown[];
const onWindowError = (e: ErrorEvent) => {
  uncaught.push(e.error ?? e.message);
};

beforeEach(() => {
  // Real probe, clean module state (setup.ts forces "available" by default).
  setVectorRenderingForTests(null);
  resetVectorSupportForTests();
  localStorage.clear();
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  uncaught = [];
  window.addEventListener('error', onWindowError);
});
afterEach(() => {
  cleanup();
  window.removeEventListener('error', onWindowError);
  getContext.mockRestore();
  consoleError.mockRestore();
});

describe('BaseMap with a vector tileset and no WebGL2 (probe fails)', () => {
  beforeEach(() => {
    getContext.mockReturnValue(null);
  });

  it('draws the raster twin, builds no GL layer, and logs no error', () => {
    const { mapRef } = renderMap('cartoPositron');
    const { raster, vector } = layersOf(mapRef.current!);
    expect(vector).toBe(0);
    expect(raster).toEqual(['https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png']);
    expect(document.querySelector('.leaflet-gl-layer')).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('shows the notice once and keeps the saved tileset selected', () => {
    const onTilesetChange = vi.fn();
    renderMap('cartoPositron', { showTilesetSelector: true, onTilesetChange });
    expect(screen.getAllByTestId('vector-fallback-notice')).toHaveLength(1);
    expect(screen.getByTestId('vector-fallback-notice').textContent).toContain('map.vector_unsupported_notice');
    // The fallback is per-render: the choice is neither changed nor reported.
    expect(screen.getByTestId('tileset-selector').textContent).toBe('cartoPositron');
    expect(onTilesetChange).not.toHaveBeenCalled();
  });

  it('move, zoom, resize and unmount do not throw', () => {
    const { mapRef, unmount } = renderMap('cartoPositron');
    expect(() => driveMap(mapRef.current!)).not.toThrow();
    expect(() => unmount()).not.toThrow();
    expect(uncaught).toEqual([]);
  });

  it('picks the dark raster for a dark vector style', () => {
    const { mapRef } = renderMap('cartoDarkMatter');
    expect(layersOf(mapRef.current!).raster).toEqual(['https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png']);
    cleanup();
    const again = renderMap('cartoVoyagerDark');
    expect(layersOf(again.mapRef.current!).raster).toEqual(['https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png']);
  });

  it('keeps the CARTO key on the raster twin', () => {
    const { mapRef } = renderMap('cartoVoyager', { cartoApiKey: 'k123' });
    const [url] = layersOf(mapRef.current!).raster;
    expect(url).toContain('rastertiles/voyager');
    expect(url).toContain('key=k123');
  });

  it('falls back to the default OSM raster for a custom .pbf tileset', () => {
    const { mapRef } = renderMap('custom-vec', { customTilesets: [customVector] });
    expect(layersOf(mapRef.current!).raster).toEqual(['https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png']);
    // The map still has a finite zoom ceiling (#5516).
    expect(Number.isFinite(mapRef.current!.getMaxZoom())).toBe(true);
  });

  it('leaves a raster tileset alone: no notice', () => {
    const { mapRef } = renderMap('osm');
    expect(layersOf(mapRef.current!).raster).toEqual(['https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png']);
    expect(screen.queryByTestId('vector-fallback-notice')).toBeNull();
  });

  it('two maps on one page show one notice between them', () => {
    render(
      <>
        <div style={{ width: 400, height: 300 }}>
          <BaseMap center={[0, 0]} zoom={3} tilesetId="cartoPositron" />
        </div>
        <div style={{ width: 400, height: 300 }}>
          <BaseMap center={[0, 0]} zoom={3} tilesetId="cartoDarkMatter" />
        </div>
      </>,
    );
    expect(screen.getAllByTestId('vector-fallback-notice')).toHaveLength(1);
  });

  it('the notice can be closed and does not come back on the next map', () => {
    renderMap('cartoPositron');
    fireEvent.click(screen.getByRole('button', { name: 'map.vector_notice_dismiss' }));
    expect(screen.queryByTestId('vector-fallback-notice')).toBeNull();
    cleanup();
    const { mapRef } = renderMap('cartoPositron');
    expect(screen.queryByTestId('vector-fallback-notice')).toBeNull();
    // Still the raster map.
    expect(layersOf(mapRef.current!).raster).toHaveLength(1);
  });
});

describe('BaseMap when the probe passes but MapLibre cannot get a context', () => {
  beforeEach(() => {
    // The probe sees a context; MapLibre's own canvas then gets none, so the
    // real constructor throws the real GPUInitializationError.
    getContext.mockReturnValueOnce({ getExtension: () => null } as never).mockReturnValue(null);
  });

  it('catches the real GPUInitializationError and falls back to raster', () => {
    const { mapRef } = renderMap('cartoPositron');

    const failures = consoleError.mock.calls.filter((c) => c[0] === 'Failed to create MapLibre GL layer:');
    expect(failures).toHaveLength(1);
    expect((failures[0][1] as Error).name).toBe('GPUInitializationError');

    const { raster, vector } = layersOf(mapRef.current!);
    expect(vector).toBe(0);
    expect(raster).toEqual(['https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png']);
    // The adapter's container is not left behind in the tile pane.
    expect(document.querySelector('.leaflet-gl-layer')).toBeNull();
    expect(screen.getAllByTestId('vector-fallback-notice')).toHaveLength(1);
    expect(isVectorRenderingAvailable()).toBe(false);
  });

  it('move, zoom, resize and unmount do not throw after the failure', () => {
    const { mapRef, unmount } = renderMap('cartoPositron');
    expect(() => driveMap(mapRef.current!)).not.toThrow();
    expect(() => unmount()).not.toThrow();
    expect(uncaught).toEqual([]);
  });

  it('does not try again on the next map', () => {
    renderMap('cartoPositron');
    cleanup();
    consoleError.mockClear();
    const { mapRef } = renderMap('cartoDarkMatter');
    expect(consoleError).not.toHaveBeenCalled();
    expect(layersOf(mapRef.current!)).toEqual({
      raster: ['https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
      vector: 0,
    });
  });
});

describe('BaseMap error boundary', () => {
  function Boom(): never {
    throw new Error('layer exploded');
  }

  it('shows a panel in the map box and leaves the page around it mounted', () => {
    setVectorRenderingForTests(true);
    const { container } = render(
      <div>
        <h1>Nodes</h1>
        <div style={{ width: 400, height: 300 }}>
          <BaseMap center={[0, 0]} zoom={3}>
            <Boom />
          </BaseMap>
        </div>
        <button>Save</button>
      </div>,
    );
    expect(screen.getByTestId('map-unavailable')).toBeTruthy();
    expect(screen.getByText('layer exploded')).toBeTruthy();
    expect(container.querySelector('.leaflet-container')).toBeNull();
    // The rest of the page is still there.
    expect(screen.getByRole('heading', { name: 'Nodes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('"Try again" renders the map once the fault is gone', () => {
    setVectorRenderingForTests(true);
    let broken = true;
    const Flaky = () => {
      if (broken) throw new Error('first render fails');
      return null;
    };
    const { container } = render(
      <div style={{ width: 400, height: 300 }}>
        <BaseMap center={[0, 0]} zoom={3}>
          <Flaky />
        </BaseMap>
      </div>,
    );
    expect(screen.getByTestId('map-unavailable')).toBeTruthy();
    broken = false;
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'map.unavailable_retry' }));
    });
    expect(screen.queryByTestId('map-unavailable')).toBeNull();
    expect(container.querySelector('.leaflet-container')).not.toBeNull();
  });
});
