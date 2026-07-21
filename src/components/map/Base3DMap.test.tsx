/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, StrictMode } from 'react';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { Base3DMap, type Node3DFeature, type Line3DFeature } from './Base3DMap';
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
    /** When true, the constructor throws like a real WebGL-init failure. */
    static throwOnConstruct = false;
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
      if (FakeMap.throwOnConstruct) {
        throw new Error('Failed to initialize WebGL');
      }
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

/** Filters `addLayer` mock calls down to line layers (id prefixed `lines-`). */
function lineLayerCalls(map: InstanceType<typeof FakeMap>) {
  return map.addLayer.mock.calls.filter(
    ([layer]) => typeof layer?.id === 'string' && layer.id.startsWith('lines-'),
  );
}

function currentFakeMap(): InstanceType<typeof FakeMap> {
  const m = FakeMap.instances[FakeMap.instances.length - 1];
  if (!m) throw new Error('no FakeMap instance constructed');
  return m;
}

// jsdom has no WebGL: HTMLCanvasElement#getContext('webgl'/'webgl2') returns
// null, which would trip the component's availability probe in every test.
// Default the probe to "available"; the WebGL-unavailable suite overrides it.
let getContextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  FakeMap.instances = [];
  FakeMap.throwOnConstruct = false;
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({} as unknown as RenderingContext);
});

afterEach(() => {
  cleanup();
  getContextSpy.mockRestore();
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

  describe('lines (#3826 Phase 3 WP-1)', () => {
    it('adds no line layers when the lines prop is omitted (back-compat)', () => {
      render(
        <Base3DMap center={[40.0, -105.0]} zoom={12} basemap={basemap} terrainTileUrl={terrainTileUrl} nodes={nodes} />,
      );
      const map = currentFakeMap();
      act(() => {
        map.triggerLoad();
      });

      expect(lineLayerCalls(map)).toHaveLength(0);
    });

    it('adds a lines source and one line layer per distinct dash group on load', () => {
      const lines: Line3DFeature[] = [
        { key: 'mt:1', from: [40.0, -105.0], to: [40.1, -105.1], color: '#3fb1ce', opacity: 0.8, width: 2, dash: [2, 2] },
        { key: 'mc:1', from: [40.0, -105.0], to: [40.2, -105.2], color: '#06b6d4', opacity: 0.9, width: 3, dash: [3, 2] },
        { key: 'tr:1', from: [40.0, -105.0], to: [40.3, -105.3], color: '#22c55e', opacity: 1, width: 4 },
      ];
      render(
        <Base3DMap
          center={[40.0, -105.0]}
          zoom={12}
          basemap={basemap}
          terrainTileUrl={terrainTileUrl}
          nodes={nodes}
          lines={lines}
        />,
      );
      const map = currentFakeMap();
      act(() => {
        map.triggerLoad();
      });

      expect(map.addSource).toHaveBeenCalledWith('lines', expect.objectContaining({ type: 'geojson' }));
      const calls = lineLayerCalls(map);
      // Three distinct dash signatures: [2,2], [3,2], and solid (no dash).
      expect(calls).toHaveLength(3);
      for (const [layer] of calls) {
        expect(layer.type).toBe('line');
        expect(layer.source).toBe('lines');
        expect(layer.paint['line-color']).toEqual(['get', 'color']);
        expect(layer.paint['line-opacity']).toEqual(['get', 'opacity']);
        expect(layer.paint['line-width']).toEqual(['get', 'width']);
      }
      const dashed = calls.filter(([layer]) => layer.paint['line-dasharray'] !== undefined);
      const solid = calls.filter(([layer]) => layer.paint['line-dasharray'] === undefined);
      expect(dashed).toHaveLength(2);
      expect(solid).toHaveLength(1);
      expect(dashed.map(([layer]) => layer.paint['line-dasharray'])).toEqual(
        expect.arrayContaining([[2, 2], [3, 2]]),
      );
      // Line layers must be inserted below the node circle layer.
      for (const [, beforeId] of calls) {
        expect(beforeId).toBe('nodes-circle');
      }
    });

    it('groups lines with an identical dash pattern into a single layer', () => {
      const lines: Line3DFeature[] = [
        { key: 'a', from: [40.0, -105.0], to: [40.1, -105.1], color: '#fff', opacity: 1, width: 2, dash: [2, 2] },
        { key: 'b', from: [40.0, -105.0], to: [40.2, -105.2], color: '#000', opacity: 1, width: 2, dash: [2, 2] },
      ];
      render(
        <Base3DMap
          center={[40.0, -105.0]}
          zoom={12}
          basemap={basemap}
          terrainTileUrl={terrainTileUrl}
          nodes={nodes}
          lines={lines}
        />,
      );
      const map = currentFakeMap();
      act(() => {
        map.triggerLoad();
      });

      expect(lineLayerCalls(map)).toHaveLength(1);
    });

    it('calls onLineClick with the clicked feature key', () => {
      const onLineClick = vi.fn();
      const lines: Line3DFeature[] = [
        { key: 'mt:5', from: [40.0, -105.0], to: [40.1, -105.1], color: '#3fb1ce', opacity: 0.8, width: 2, dash: [2, 2] },
      ];
      render(
        <Base3DMap
          center={[40.0, -105.0]}
          zoom={12}
          basemap={basemap}
          terrainTileUrl={terrainTileUrl}
          nodes={nodes}
          lines={lines}
          onLineClick={onLineClick}
        />,
      );
      const map = currentFakeMap();
      act(() => {
        map.triggerLoad();
      });

      const [layer] = lineLayerCalls(map)[0];
      const clickHandler = map.layerHandlers[`click:${layer.id}`];
      expect(clickHandler).toBeDefined();
      clickHandler({ features: [{ properties: { key: 'mt:5' } }] });

      expect(onLineClick).toHaveBeenCalledWith('mt:5');
    });

    it('patches the lines source and reconciles dash-group layers when lines change', () => {
      const initialLines: Line3DFeature[] = [
        { key: 'a', from: [40.0, -105.0], to: [40.1, -105.1], color: '#fff', opacity: 1, width: 2, dash: [2, 2] },
      ];
      const { rerender } = render(
        <Base3DMap
          center={[40.0, -105.0]}
          zoom={12}
          basemap={basemap}
          terrainTileUrl={terrainTileUrl}
          nodes={nodes}
          lines={initialLines}
        />,
      );
      const map = currentFakeMap();
      act(() => {
        map.triggerLoad();
      });
      const [initialLayer] = lineLayerCalls(map)[0];
      const initialLayerId = initialLayer.id as string;

      // The lines-sync effect also runs once `loaded` flips true (source was
      // just created with the initial data) — clear those calls so the
      // assertions below isolate the prop-change-triggered update, mirroring
      // the equivalent `nodes` test above.
      const linesSource = map.getSource('lines');
      linesSource.setData.mockClear();
      map.addLayer.mockClear();
      map.removeLayer.mockClear();

      // New dash pattern ([3,2]) replaces the old one ([2,2]).
      const updatedLines: Line3DFeature[] = [
        { key: 'b', from: [40.0, -105.0], to: [40.2, -105.2], color: '#000', opacity: 1, width: 3, dash: [3, 2] },
      ];
      rerender(
        <Base3DMap
          center={[40.0, -105.0]}
          zoom={12}
          basemap={basemap}
          terrainTileUrl={terrainTileUrl}
          nodes={nodes}
          lines={updatedLines}
        />,
      );

      expect(linesSource.setData).toHaveBeenCalledTimes(1);
      const call = linesSource.setData.mock.calls[0][0];
      expect(call.features).toHaveLength(1);
      expect(call.features[0].properties.key).toBe('b');

      // A new layer is added for the newly-appearing [3,2] dash group.
      const newCalls = lineLayerCalls(map);
      expect(newCalls).toHaveLength(1);
      expect(newCalls[0][0].paint['line-dasharray']).toEqual([3, 2]);
      // The vanished [2,2] dash group's layer is removed.
      expect(map.removeLayer).toHaveBeenCalledWith(initialLayerId);
    });
  });

  describe('exaggeration seeding (#3826 Phase 3 WP-1)', () => {
    it('seeds the slider and the initial setTerrain call from initialExaggeration', () => {
      render(
        <Base3DMap
          center={[40.0, -105.0]}
          zoom={12}
          basemap={basemap}
          terrainTileUrl={terrainTileUrl}
          nodes={nodes}
          initialExaggeration={0.5}
        />,
      );
      const map = currentFakeMap();
      act(() => {
        map.triggerLoad();
      });

      expect(map.setTerrain).toHaveBeenCalledWith({ source: 'terrain-dem', exaggeration: 0.5 });
      const slider = screen.getByLabelText('Terrain exaggeration') as HTMLInputElement;
      expect(slider.value).toBe('0.5');
    });

    it('emits onExaggerationChange (in addition to setTerrain) when the slider changes', () => {
      const onExaggerationChange = vi.fn();
      const { getByLabelText } = render(
        <Base3DMap
          center={[40.0, -105.0]}
          zoom={12}
          basemap={basemap}
          terrainTileUrl={terrainTileUrl}
          nodes={nodes}
          onExaggerationChange={onExaggerationChange}
        />,
      );
      const map = currentFakeMap();
      act(() => {
        map.triggerLoad();
      });
      map.setTerrain.mockClear();

      const slider = getByLabelText('Terrain exaggeration') as HTMLInputElement;
      fireEvent.change(slider, { target: { value: '1.8' } });

      expect(map.setTerrain).toHaveBeenCalledWith({ source: 'terrain-dem', exaggeration: 1.8 });
      expect(onExaggerationChange).toHaveBeenCalledWith(1.8);
    });
  });

  describe('WebGL unavailable', () => {
    it('probe failure: no crash, no map constructed, fallback message, onUnsupported once', () => {
      getContextSpy.mockReturnValue(null);
      const onUnsupported = vi.fn();
      expect(() =>
        render(
          <Base3DMap
            center={[40.0, -105.0]}
            zoom={12}
            basemap={basemap}
            terrainTileUrl={terrainTileUrl}
            nodes={nodes}
            onUnsupported={onUnsupported}
          />,
        ),
      ).not.toThrow();

      expect(FakeMap.instances).toHaveLength(0);
      expect(screen.getByTestId('base-3d-map-unsupported')).toHaveTextContent(/requires WebGL/i);
      expect(onUnsupported).toHaveBeenCalledTimes(1);
    });

    it('constructor throw (probe passed): no crash, fallback message, onUnsupported once', () => {
      // Probe stays truthy (belt), but the real context creation fails (braces).
      FakeMap.throwOnConstruct = true;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onUnsupported = vi.fn();
      expect(() =>
        render(
          <Base3DMap
            center={[40.0, -105.0]}
            zoom={12}
            basemap={basemap}
            terrainTileUrl={terrainTileUrl}
            nodes={nodes}
            onUnsupported={onUnsupported}
          />,
        ),
      ).not.toThrow();

      expect(FakeMap.instances).toHaveLength(0);
      expect(screen.getByTestId('base-3d-map-unsupported')).toBeInTheDocument();
      expect(onUnsupported).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('StrictMode double-mount fires onUnsupported exactly once', () => {
      getContextSpy.mockReturnValue(null);
      const onUnsupported = vi.fn();
      render(
        <StrictMode>
          <Base3DMap
            center={[40.0, -105.0]}
            zoom={12}
            basemap={basemap}
            terrainTileUrl={terrainTileUrl}
            nodes={nodes}
            onUnsupported={onUnsupported}
          />
        </StrictMode>,
      );

      expect(screen.getByTestId('base-3d-map-unsupported')).toBeInTheDocument();
      expect(onUnsupported).toHaveBeenCalledTimes(1);
    });

    it('renders no exaggeration slider in the unsupported state', () => {
      getContextSpy.mockReturnValue(null);
      render(
        <Base3DMap center={[40.0, -105.0]} zoom={12} basemap={basemap} terrainTileUrl={terrainTileUrl} nodes={nodes} />,
      );
      expect(screen.queryByTestId('base-3d-map-exaggeration')).toBeNull();
    });
  });
});
