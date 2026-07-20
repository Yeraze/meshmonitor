/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Base3DMap, type Node3DFeature } from './Base3DMap';
import type { Basemap3DSource } from '../../config/basemap3d';

// ---------------------------------------------------------------------------
// Fake maplibre-gl (spec §4: no real WebGL in jsdom). Records constructor
// options and on/addSource/addLayer/setTerrain/addControl/getSource/remove
// calls; `load` is fired manually via `triggerLoad()`.
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

// `vi.mock` factories are hoisted above the rest of the module, so the
// classes they reference must be created via `vi.hoisted` rather than plain
// top-level `class` declarations (which are hoisted but stay in the
// temporal dead zone until their declaration point).
const { FakeMap, FakeNavigationControl, FakeAttributionControl } = vi.hoisted(() => {
  class FakeMap {
    static instances: FakeMap[] = [];
    options: any;
    handlers: Record<string, Listener> = {};
    layerHandlers: Record<string, Listener> = {};
    sources: Record<string, any> = {};
    layerIds = new Set<string>();
    removeCalled = false;

    addControl = vi.fn();
    addSource = vi.fn((id: string, source: any) => {
      this.sources[id] = source.type === 'geojson' ? { ...source, setData: vi.fn() } : source;
    });
    addLayer = vi.fn((layer: any) => {
      this.layerIds.add(layer.id);
    });
    setTerrain = vi.fn();
    getSource = vi.fn((id: string) => this.sources[id]);
    getLayer = vi.fn((id: string) => (this.layerIds.has(id) ? {} : undefined));
    removeLayer = vi.fn((id: string) => {
      this.layerIds.delete(id);
    });
    removeSource = vi.fn((id: string) => {
      delete this.sources[id];
    });
    getCanvas = vi.fn(() => ({ style: {} as CSSStyleDeclaration }));
    remove = vi.fn(() => {
      this.removeCalled = true;
    });

    constructor(options: any) {
      this.options = options;
      FakeMap.instances.push(this);
    }

    on(type: string, arg2: unknown, arg3?: Listener) {
      if (typeof arg2 === 'function') {
        this.handlers[type] = arg2 as Listener;
      } else if (typeof arg3 === 'function') {
        this.layerHandlers[`${type}:${String(arg2)}`] = arg3;
      }
      return this;
    }

    triggerLoad() {
      this.handlers.load?.();
    }
  }

  class FakeNavigationControl {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
  }

  class FakeAttributionControl {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
  }

  return { FakeMap, FakeNavigationControl, FakeAttributionControl };
});

vi.mock('maplibre-gl', () => ({
  default: {
    Map: FakeMap,
    NavigationControl: FakeNavigationControl,
    AttributionControl: FakeAttributionControl,
  },
}));

// ---------------------------------------------------------------------------

const basemap: Basemap3DSource = {
  tiles: ['https://a.tile.osm.example/{z}/{x}/{y}.png'],
  attribution: 'OSM contributors',
  maxZoom: 19,
  usedFallback: false,
};

const terrainTileUrl = '/api/elevation/tiles/{z}/{x}/{y}';

const nodes: Node3DFeature[] = [
  { key: 'node-1', lat: 40.0, lng: -105.0, label: 'N1' },
  { key: 'node-2', lat: 40.1, lng: -105.1, label: 'N2' },
];

function currentFakeMap(): InstanceType<typeof FakeMap> {
  const m = FakeMap.instances[FakeMap.instances.length - 1];
  if (!m) throw new Error('no FakeMap instance constructed');
  return m;
}

beforeEach(() => {
  FakeMap.instances = [];
});

afterEach(() => {
  cleanup();
});

describe('Base3DMap', () => {
  it('constructs the map with lng/lat-converted center, zoom, and basemap tiles', () => {
    render(
      <Base3DMap center={[40.0, -105.0]} zoom={12} basemap={basemap} terrainTileUrl={terrainTileUrl} nodes={nodes} />,
    );
    const map = currentFakeMap();
    // MapLibre takes [lng, lat]; the prop is [lat, lng].
    expect(map.options.center).toEqual([-105.0, 40.0]);
    expect(map.options.zoom).toBe(12);
    expect(map.options.style.sources['basemap-raster'].tiles).toEqual(basemap.tiles);
  });

  it('adds raster-dem terrain, hillshade, and node layers on load', () => {
    render(
      <Base3DMap center={[40.0, -105.0]} zoom={12} basemap={basemap} terrainTileUrl={terrainTileUrl} nodes={nodes} />,
    );
    const map = currentFakeMap();
    act(() => {
      map.triggerLoad();
    });

    expect(map.addSource).toHaveBeenCalledWith(
      'terrain-dem',
      expect.objectContaining({ type: 'raster-dem', tiles: [terrainTileUrl], encoding: 'terrarium' }),
    );
    expect(map.setTerrain).toHaveBeenCalledWith({ source: 'terrain-dem', exaggeration: 1.3 });
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({ id: 'terrain-hillshade', type: 'hillshade' }));
    expect(map.addSource).toHaveBeenCalledWith('nodes', expect.objectContaining({ type: 'geojson' }));
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({ id: 'nodes-circle', type: 'circle' }));
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({ id: 'nodes-label', type: 'symbol' }));
  });

  it('calls onNodeClick with the clicked feature key', () => {
    const onNodeClick = vi.fn();
    render(
      <Base3DMap
        center={[40.0, -105.0]}
        zoom={12}
        basemap={basemap}
        terrainTileUrl={terrainTileUrl}
        nodes={nodes}
        onNodeClick={onNodeClick}
      />,
    );
    const map = currentFakeMap();
    act(() => {
      map.triggerLoad();
    });

    const clickHandler = map.layerHandlers['click:nodes-circle'];
    expect(clickHandler).toBeDefined();
    clickHandler({ features: [{ properties: { key: 'node-1' } }] });

    expect(onNodeClick).toHaveBeenCalledWith('node-1');
  });

  it('updates terrain exaggeration via setTerrain when the slider changes', () => {
    const { getByLabelText } = render(
      <Base3DMap center={[40.0, -105.0]} zoom={12} basemap={basemap} terrainTileUrl={terrainTileUrl} nodes={nodes} />,
    );
    const map = currentFakeMap();
    act(() => {
      map.triggerLoad();
    });
    map.setTerrain.mockClear();

    const slider = getByLabelText('Terrain exaggeration') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '1.8' } });

    expect(map.setTerrain).toHaveBeenCalledWith({ source: 'terrain-dem', exaggeration: 1.8 });
  });

  it('calls map.remove() on unmount', () => {
    const { unmount } = render(
      <Base3DMap center={[40.0, -105.0]} zoom={12} basemap={basemap} terrainTileUrl={terrainTileUrl} nodes={nodes} />,
    );
    const map = currentFakeMap();
    act(() => {
      map.triggerLoad();
    });

    unmount();

    expect(map.remove).toHaveBeenCalled();
  });

  it('is StrictMode-safe: double-mount/unmount leaves no dangling map', () => {
    const { unmount } = render(
      <Base3DMap center={[40.0, -105.0]} zoom={12} basemap={basemap} terrainTileUrl={terrainTileUrl} nodes={nodes} />,
    );
    // Simulate React 19 StrictMode's dev double-invoke of the mount effect
    // by unmounting and remounting: each mount must get a fresh map and
    // each unmount must tear its own down cleanly (no shared/leaked state).
    const firstMap = currentFakeMap();
    unmount();
    expect(firstMap.remove).toHaveBeenCalledTimes(1);

    const second = render(
      <Base3DMap center={[40.0, -105.0]} zoom={12} basemap={basemap} terrainTileUrl={terrainTileUrl} nodes={nodes} />,
    );
    const secondMap = currentFakeMap();
    expect(secondMap).not.toBe(firstMap);
    second.unmount();
    expect(secondMap.remove).toHaveBeenCalledTimes(1);
  });

  it('patches the nodes source data when the nodes prop changes', () => {
    const { rerender } = render(
      <Base3DMap center={[40.0, -105.0]} zoom={12} basemap={basemap} terrainTileUrl={terrainTileUrl} nodes={nodes} />,
    );
    const map = currentFakeMap();
    act(() => {
      map.triggerLoad();
    });

    // The nodes-sync effect also runs once `loaded` flips true (source was
    // just created with the initial data) — clear that call so the
    // assertion below isolates the prop-change-triggered update.
    const nodesSource = map.getSource('nodes');
    nodesSource.setData.mockClear();

    const updatedNodes: Node3DFeature[] = [...nodes, { key: 'node-3', lat: 40.2, lng: -105.2, label: 'N3' }];
    rerender(
      <Base3DMap
        center={[40.0, -105.0]}
        zoom={12}
        basemap={basemap}
        terrainTileUrl={terrainTileUrl}
        nodes={updatedNodes}
      />,
    );

    expect(nodesSource.setData).toHaveBeenCalledTimes(1);
    const call = nodesSource.setData.mock.calls[0][0];
    expect(call.features).toHaveLength(3);
    expect(call.features[2].properties.key).toBe('node-3');
  });
});
