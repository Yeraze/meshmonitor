/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import MapAnalysisCanvas from './MapAnalysisCanvas';
import { MapAnalysisProvider, useMapAnalysisCtx, type MapViewState } from './MapAnalysisContext';
import { getHopColor } from '../../utils/mapIcons';
import { MIN_MARKER_OPACITY } from '../../utils/markerAgeOpacity';

// Stub react-leaflet — Vitest's jsdom doesn't provide all the DOM bits Leaflet needs.
vi.mock('react-leaflet', () => ({
  MapContainer: ({
    children,
    center,
    zoom,
  }: {
    children: React.ReactNode;
    center: [number, number];
    zoom: number;
  }) => (
    // center/zoom surfaced so the #4371 view-carryover tests can assert what
    // the 2D map mounted at.
    <div data-testid="map-container" data-center={center.join(',')} data-zoom={zoom}>
      {children}
    </div>
  ),
  TileLayer: () => <div data-testid="tile-layer" />,
  Marker: ({
    children,
    position,
  }: {
    children?: React.ReactNode;
    position: [number, number];
  }) => (
    <div data-testid="marker" data-pos={position.join(',')}>
      {children}
    </div>
  ),
  Popup: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="popup">{children}</div>
  ),
  Polyline: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="poly">{children}</div>
  ),
  Rectangle: () => <div data-testid="accuracy-rect" />,
  Pane: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  // Spiderfier (NodeMarkersLayer) calls useMap(); null makes the hook a no-op.
  useMap: () => null,
  // GnssDopLayer (#4729) subscribes to moveend/zoomend; no-op here (its fetch
  // is gated on `visible`, off by default, so it never dereferences the null map).
  useMapEvents: () => null,
}));

// MapAnalysisCanvas now composes BaseMap (#4047 Phase 7 WP10), which
// statically imports the MapLibre-backed VectorTileLayer. Mock it out (same
// as BaseMap.test.tsx) so this suite doesn't have to load the real
// `@maplibre/maplibre-gl-leaflet` module under jsdom — the 'osm' tileset used
// here is raster, so the vector branch is never exercised.
vi.mock('../VectorTileLayer', () => ({
  VectorTileLayer: () => <div data-testid="vector-tile" />,
}));

// FollowController's own behavior (Follow/Auto-zoom/pause) is covered by its
// dedicated FollowController.test.tsx; here it's a no-op so this suite can
// keep useMap() -> null (required by the spiderfier no-op path above).
vi.mock('./FollowController', () => ({
  default: () => null,
}));

vi.mock('../../hooks/useMapAnalysisData', () => ({
  useTraceroutes: () => ({
    items: [],
    isLoading: false,
    isError: false,
    error: null,
    progress: { loaded: 0, estimatedTotal: 0, percent: 100 },
  }),
  useNeighbors: () => ({ data: { items: [] }, isLoading: false }),
  usePositions: () => ({
    items: [],
    isLoading: false,
    progress: { loaded: 0, estimatedTotal: 0, percent: 100 },
  }),
  useCoverageGrid: () => ({ data: { cells: [], binSizeDeg: 0.01 }, isLoading: false }),
  useHopCounts: () => ({ data: { entries: [] }, isLoading: false }),
}));

vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
  useDashboardUnifiedData: () => ({
    nodes: [
      {
        nodeNum: 1,
        sourceId: 'a',
        longName: 'Alpha',
        shortName: 'A',
        position: { latitude: 30, longitude: -90 },
        // Reported by two sources — exercises the popup's multi-source list.
        sources: [
          { sourceId: 'a', sourceName: 'Alpha Src', protocol: 'Meshtastic' },
          { sourceId: 'b', sourceName: 'Beta Src', protocol: 'MeshCore' },
        ],
      },
    ],
    traceroutes: [],
    neighborInfo: [],
    channels: [],
    status: null,
    isLoading: false,
    isError: false,
  }),
  UNIFIED_SOURCE_ID: '__unified__',
}));

// Mutable so the vector-fallback test (#3826 Phase 2 WP-D) can swap in a
// vector-only custom tileset without a second describe-level mock factory.
let mapTilesetMock = 'osm';
let customTilesetsMock: Array<{
  id: string;
  name: string;
  url: string;
  attribution: string;
  maxZoom: number;
  description: string;
  createdAt: number;
  updatedAt: number;
  isVector?: boolean;
}> = [];

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({
    defaultMapCenterLat: 30,
    defaultMapCenterLon: -90,
    defaultMapCenterZoom: 10,
    mapTileset: mapTilesetMock,
    customTilesets: customTilesetsMock,
    setMapTileset: vi.fn(),
  }),
  // Used by DashboardNodePopup, which now renders inside the node marker popups.
  useDisplaySettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

// #3826 Phase 2 WP-D: capabilities gate for the force-2D guard. Mutable per
// test (mirrors the toolbar suite's `terrainCapabilities` mock).
let terrainCapabilitiesMock = { enabled: true, terrainTiles: true, isLoading: false };
vi.mock('../../hooks/useTerrainCapabilities', () => ({
  useTerrainCapabilities: () => terrainCapabilitiesMock,
}));

// #3826 Phase 3 WP-3: the two WP-2 3D line-data hooks are mocked directly so
// this suite can assert the canvas's merge/click/exaggeration wiring without
// exercising their internal data-fetch stack (that's use3DNeighborLines.test.ts
// / use3DTracerouteLines.test.ts's job). Mutable per test.
let neighborLines3DMock: {
  lines: Array<{ key: string; from: [number, number]; to: [number, number]; color: string; opacity: number; width: number; dash?: number[] }>;
  selectionByKey: Map<string, Record<string, unknown>>;
} = { lines: [], selectionByKey: new Map() };
let tracerouteLines3DMock: {
  lines: Array<{ key: string; from: [number, number]; to: [number, number]; color: string; opacity: number; width: number; dash?: number[] }>;
  selectionByKey: Map<string, Record<string, unknown>>;
} = { lines: [], selectionByKey: new Map() };
vi.mock('./use3DNeighborLines', () => ({
  use3DNeighborLines: () => neighborLines3DMock,
}));
vi.mock('./use3DTracerouteLines', () => ({
  use3DTracerouteLines: () => tracerouteLines3DMock,
}));

// Base3DMap wraps maplibre-gl directly (WebGL) — unusable under jsdom (see
// spec §4 test plan / Base3DMap.test.tsx, which mocks `maplibre-gl` itself).
// Here it's mocked at the component level: a stub that renders the mapped
// props so this suite can assert the 3D branch feeds it the right data,
// without needing a WebGL context.
vi.mock('../map/Base3DMap', () => ({
  Base3DMap: (props: {
    center: [number, number];
    zoom: number;
    pitch?: number;
    bearing?: number;
    nodes: Array<{ key: string; lat: number; lng: number; label?: string; color?: string; opacity?: number }>;
    basemap: { tiles: string[]; usedFallback: boolean };
    terrainTileUrl: string;
    onNodeClick?: (key: string) => void;
    onUnsupported?: () => void;
    lines?: Array<{ key: string }>;
    onLineClick?: (key: string) => void;
    initialExaggeration?: number;
    onExaggerationChange?: (v: number) => void;
    onViewChange?: (v: { center: [number, number]; zoom: number; pitch: number; bearing: number }) => void;
    onMapReady?: (map: unknown) => void;
  }) => (
    <div
      data-testid="base-3d-map"
      data-terrain-url={props.terrainTileUrl}
      data-line-keys={(props.lines ?? []).map((l) => l.key).join(',')}
      data-initial-exaggeration={props.initialExaggeration}
      data-center={props.center.join(',')}
      data-zoom={props.zoom}
      data-pitch={props.pitch ?? ''}
      data-bearing={props.bearing ?? ''}
      data-node-count={props.nodes.length}
    >
      {props.nodes.map((n) => (
        <button
          key={n.key}
          type="button"
          data-testid={`base-3d-node-${n.key}`}
          data-color={n.color}
          data-opacity={n.opacity}
          onClick={() => props.onNodeClick?.(n.key)}
        >
          {n.label}
        </button>
      ))}
      {(props.lines ?? []).map((l) => (
        <button
          key={l.key}
          type="button"
          data-testid={`base-3d-line-${l.key}`}
          onClick={() => props.onLineClick?.(l.key)}
        >
          {l.key}
        </button>
      ))}
      {/* Lets tests simulate the real component's WebGL-unavailable signal. */}
      <button
        type="button"
        data-testid="base-3d-trigger-unsupported"
        onClick={() => props.onUnsupported?.()}
      >
        trigger-unsupported
      </button>
      {/* Lets tests simulate the exaggeration slider changing. */}
      <button
        type="button"
        data-testid="base-3d-change-exaggeration"
        onClick={() => props.onExaggerationChange?.(1.9)}
      >
        change-exaggeration
      </button>
      {/* #4371: simulate the user panning/rotating the 3D camera. */}
      <button
        type="button"
        data-testid="base-3d-move-camera"
        onClick={() =>
          props.onViewChange?.({ center: [44.4, -111.1], zoom: 15, pitch: 25, bearing: 275 })
        }
      >
        move-camera
      </button>
      {/* #4371: simulate maplibre's `load` handing the map instance out. */}
      <button
        type="button"
        data-testid="base-3d-map-ready"
        onClick={() => props.onMapReady?.({ fake: 'maplibre-map' })}
      >
        map-ready
      </button>
    </div>
  ),
}));

// Follow3DController's own behavior is covered by Follow3DController.test.tsx;
// here it's a marker so this suite can assert the 3D branch mounts it and
// feeds it the map instance Base3DMap hands out (#4371 B).
vi.mock('./Follow3DController', () => ({
  default: ({ map }: { map: unknown }) => (
    <div data-testid="follow-3d-controller" data-has-map={String(map !== null)} />
  ),
}));

// The global setup.ts mock for react-i18next ignores `options.defaultValue`
// (it only interpolates `{{token}}` placeholders into the raw key), so it
// can't produce real English text for the popup family's `t(key, {
// defaultValue })` calls that DashboardNodePopup now goes through (#4047
// Phase 5 WP2). Override locally — mirrors
// src/components/map/popups/sections.test.tsx — so the "Seen by 2 sources"
// assertion below exercises the same English copy a real render produces.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      arg2?: string | Record<string, unknown>,
      arg3?: Record<string, unknown>,
    ) => {
      let options: Record<string, unknown> | undefined;
      let defaultValue: string | undefined;
      if (typeof arg2 === 'string') {
        defaultValue = arg2;
        options = arg3;
      } else {
        options = arg2;
        defaultValue = typeof options?.defaultValue === 'string' ? options.defaultValue : undefined;
      }
      let out = defaultValue ?? key;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return out;
    },
  }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MapAnalysisProvider>{children}</MapAnalysisProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

/** Reads live context state (selected target) so tests can assert onLineClick's dispatch. */
function SelectedProbe() {
  const ctx = useMapAnalysisCtx();
  return <div data-testid="selected-probe">{JSON.stringify(ctx.selected)}</div>;
}

/**
 * Seeds the shared camera ref (#4371 A) as if a map had already reported a
 * view, standing in for `MapViewStateController` — whose own publishing is
 * covered by MapViewStateController.test.tsx, and which is inert here because
 * this suite stubs `useMap()` to null.
 */
function ViewSeeder({ view }: { view: MapViewState }) {
  const { mapViewRef } = useMapAnalysisCtx();
  mapViewRef.current = view;
  return null;
}

/** Puts follow into its paused state so FollowResumeButton actually renders. */
function PauseFollow() {
  const { setFollowPaused } = useMapAnalysisCtx();
  React.useEffect(() => {
    setFollowPaused(true);
  }, [setFollowPaused]);
  return null;
}

/** Exposes a button to flip the GNSS DOP overlay mode, for the wiring test. */
function ToggleGnssDop() {
  const { gnssDopMode, setGnssDopMode } = useMapAnalysisCtx();
  return (
    <button type="button" data-testid="toggle-gnss-dop" onClick={() => setGnssDopMode(!gnssDopMode)}>
      toggle
    </button>
  );
}

describe('MapAnalysisCanvas', () => {
  beforeEach(() => {
    localStorage.clear();
    mapTilesetMock = 'osm';
    customTilesetsMock = [];
    terrainCapabilitiesMock = { enabled: true, terrainTiles: true, isLoading: false };
    neighborLines3DMock = { lines: [], selectionByKey: new Map() };
    tracerouteLines3DMock = { lines: [], selectionByKey: new Map() };
  });

  it('renders the map container and tile layer, and NOT Base3DMap, in 2d (default)', () => {
    render(<MapAnalysisCanvas />, { wrapper });
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
    expect(screen.getByTestId('tile-layer')).toBeInTheDocument();
    expect(screen.queryByTestId('base-3d-map')).toBeNull();
  });

  it('renders a marker per node when markers layer is enabled (default)', () => {
    render(<MapAnalysisCanvas />, { wrapper });
    expect(screen.getAllByTestId('marker').length).toBeGreaterThan(0);
  });

  it('node popup lists every source that reported the node', () => {
    render(<MapAnalysisCanvas />, { wrapper });
    // The rich DashboardNodePopup now renders inside the marker popup and shows
    // a "Seen by N sources" list for multi-source nodes (#2805 / Unified parity).
    expect(screen.getByText(/Seen by 2 sources/i)).toBeInTheDocument();
    expect(screen.getByText('Alpha Src')).toBeInTheDocument();
    expect(screen.getByText('Beta Src')).toBeInTheDocument();
  });

  // #4729: GNSS DOP overlay panel is off by default and shows once toggled on.
  describe('GNSS DOP overlay wiring', () => {
    it('does not render the DOP panel by default', () => {
      render(<MapAnalysisCanvas />, { wrapper });
      expect(screen.queryByTestId('gnss-dop-panel')).toBeNull();
    });

    it('renders the DOP panel when the mode is enabled, and hides it again when disabled', () => {
      render(
        <>
          <ToggleGnssDop />
          <MapAnalysisCanvas />
        </>,
        { wrapper },
      );
      expect(screen.queryByTestId('gnss-dop-panel')).toBeNull();
      fireEvent.click(screen.getByTestId('toggle-gnss-dop'));
      expect(screen.getByTestId('gnss-dop-panel')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('toggle-gnss-dop'));
      expect(screen.queryByTestId('gnss-dop-panel')).toBeNull();
    });
  });

  // #3826 Phase 2 WP-D: 3D branch.
  describe('3D view (viewMode=3d)', () => {
    const persist3d = () =>
      localStorage.setItem('mapAnalysis.config.v1', JSON.stringify({ version: 1, viewMode: '3d' }));

    it('renders Base3DMap (not BaseMap) fed the same node data, mapped to Node3DFeature', () => {
      persist3d();
      render(<MapAnalysisCanvas />, { wrapper });
      expect(screen.getByTestId('base-3d-map')).toBeInTheDocument();
      expect(screen.queryByTestId('map-container')).toBeNull();
      // node nodeNum:1 (Meshtastic, no isMeshCore) -> unifiedNodeKey 'mt:1';
      // label mapped from node.shortName ('A').
      const nodeBtn = screen.getByTestId('base-3d-node-mt:1');
      expect(nodeBtn).toHaveTextContent('A');
    });

    it('tints the 3D node with the 2D hop color and full opacity by default (#4808 follow-up)', () => {
      persist3d();
      render(<MapAnalysisCanvas />, { wrapper });
      const nodeBtn = screen.getByTestId('base-3d-node-mt:1');
      // hop-shading off + no hop data ⇒ hops=999 ⇒ the same neutral color the
      // 2D marker uses (getHopColor(999)); no time slider + empty selection ⇒
      // fully opaque, matching layers/NodeMarkersLayer.tsx's finalOpacity.
      expect(nodeBtn).toHaveAttribute('data-color', getHopColor(999));
      expect(nodeBtn).toHaveAttribute('data-opacity', '1');
    });

    it('fades a 3D node to the floor opacity when the time slider is on and the node has no lastHeard (#4808 follow-up)', () => {
      localStorage.setItem(
        'mapAnalysis.config.v1',
        JSON.stringify({
          version: 1,
          viewMode: '3d',
          // Window is enabled; the mock node carries no lastHeard, so the age
          // fade drops it to the floor — the same MIN_MARKER_OPACITY branch the
          // 2D layers/NodeMarkersLayer.tsx takes for a timestamp-less node.
          timeSlider: { enabled: true, windowStartMs: 10, windowEndMs: 20 },
        }),
      );
      render(<MapAnalysisCanvas />, { wrapper });
      const nodeBtn = screen.getByTestId('base-3d-node-mt:1');
      expect(nodeBtn).toHaveAttribute('data-opacity', String(MIN_MARKER_OPACITY));
    });

    it('clicking a 3D node marker resolves the node and does not throw for an unknown key', () => {
      persist3d();
      render(<MapAnalysisCanvas />, { wrapper });
      // onNodeClick is wired through to setSelected internally; the mock just
      // proves the callback fires without needing to inspect context state.
      expect(() => fireEvent.click(screen.getByTestId('base-3d-node-mt:1'))).not.toThrow();
    });

    it('builds the terrain tile URL from the same-origin elevation tile proxy path', () => {
      persist3d();
      render(<MapAnalysisCanvas />, { wrapper });
      expect(screen.getByTestId('base-3d-map')).toHaveAttribute(
        'data-terrain-url',
        expect.stringContaining('/api/elevation/tiles/{z}/{x}/{y}'),
      );
    });

    it('shows the non-blocking vector-fallback note when the current tileset is vector-only', () => {
      mapTilesetMock = 'custom-vector';
      customTilesetsMock = [
        {
          id: 'custom-vector',
          name: 'Custom Vector',
          url: 'https://example.com/{z}/{x}/{y}.pbf',
          attribution: '',
          maxZoom: 14,
          description: '',
          createdAt: 0,
          updatedAt: 0,
        },
      ];
      persist3d();
      render(<MapAnalysisCanvas />, { wrapper });
      expect(screen.getByText(/Showing default basemap in 3D/i)).toBeInTheDocument();
    });

    it('does NOT show the vector-fallback note for a raster tileset', () => {
      persist3d();
      render(<MapAnalysisCanvas />, { wrapper });
      expect(screen.queryByText(/Showing default basemap in 3D/i)).toBeNull();
    });

    it('force-2D guard: a persisted 3d viewMode falls back to BaseMap once capabilities resolve unavailable', () => {
      terrainCapabilitiesMock = { enabled: false, terrainTiles: false, isLoading: false };
      persist3d();
      render(<MapAnalysisCanvas />, { wrapper });
      expect(screen.queryByTestId('base-3d-map')).toBeNull();
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
      // The guard also corrects the persisted config so a later render (e.g.
      // navigating away and back) doesn't re-attempt 3D.
      const stored = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
      expect(stored.viewMode).toBe('2d');
    });

    it('does NOT force back to 2D while capabilities are still loading (avoids a flash to 2D)', () => {
      terrainCapabilitiesMock = { enabled: false, terrainTiles: false, isLoading: true };
      persist3d();
      render(<MapAnalysisCanvas />, { wrapper });
      expect(screen.getByTestId('base-3d-map')).toBeInTheDocument();
    });

    it('flips back to the 2D map when Base3DMap reports WebGL is unsupported', () => {
      persist3d();
      render(<MapAnalysisCanvas />, { wrapper });
      expect(screen.getByTestId('base-3d-map')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('base-3d-trigger-unsupported'));

      expect(screen.queryByTestId('base-3d-map')).toBeNull();
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
      // The corrected viewMode also persists so the next visit doesn't retry 3D.
      const stored = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
      expect(stored.viewMode).toBe('2d');
    });

    // #3826 Phase 3 WP-3: neighbor/traceroute line wiring + exaggeration.
    describe('3D line + exaggeration wiring (#3826 Phase 3 WP-3)', () => {
      it('feeds Base3DMap the merged neighbor + traceroute lines from the WP-2 hooks', () => {
        neighborLines3DMock = {
          lines: [
            { key: 'mt:1', from: [30, -90], to: [31, -91], color: '#06b6d4', opacity: 0.75, width: 2, dash: [2, 2] },
            { key: 'mc:7', from: [30, -90], to: [31, -91], color: '#06b6d4', opacity: 0.75, width: 3, dash: [3, 2] },
          ],
          selectionByKey: new Map(),
        };
        tracerouteLines3DMock = {
          lines: [{ key: 'tr:1-2', from: [30, -90], to: [31, -91], color: '#22c55e', opacity: 1, width: 2 }],
          selectionByKey: new Map(),
        };
        persist3d();
        render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.getByTestId('base-3d-map')).toHaveAttribute('data-line-keys', 'mt:1,mc:7,tr:1-2');
      });

      it('passes through empty lines when both WP-2 hooks report their layers off', () => {
        // beforeEach seeds both mocks empty — asserts empty state flows through untouched.
        persist3d();
        render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.getByTestId('base-3d-map')).toHaveAttribute('data-line-keys', '');
      });

      it('honors the neighbor-only toggle: neighbor lines present, no traceroute lines when that hook is empty', () => {
        neighborLines3DMock = {
          lines: [{ key: 'mt:1', from: [30, -90], to: [31, -91], color: '#06b6d4', opacity: 0.75, width: 2, dash: [2, 2] }],
          selectionByKey: new Map(),
        };
        persist3d();
        render(<MapAnalysisCanvas />, { wrapper });
        const keys = screen.getByTestId('base-3d-map').getAttribute('data-line-keys');
        expect(keys).toContain('mt:1');
        expect(keys).not.toContain('tr:');
      });

      it('honors the traceroute-only toggle: traceroute lines present, no neighbor lines when that hook is empty', () => {
        tracerouteLines3DMock = {
          lines: [{ key: 'tr:1-2', from: [30, -90], to: [31, -91], color: '#22c55e', opacity: 1, width: 2 }],
          selectionByKey: new Map(),
        };
        persist3d();
        render(<MapAnalysisCanvas />, { wrapper });
        const keys = screen.getByTestId('base-3d-map').getAttribute('data-line-keys');
        expect(keys).toContain('tr:1-2');
        expect(keys).not.toContain('mt:');
        expect(keys).not.toContain('mc:');
      });

      it('onLineClick dispatches setSelected with the meshcore neighbor payload for an "mc:" key', () => {
        const mcTarget = {
          type: 'neighbor',
          sourceId: 'a',
          publicKey: 'aa',
          neighborPublicKey: 'bb',
          nodeName: 'Alpha',
          neighborName: 'Beta',
          snr: 5,
          timestamp: 0,
          nodeNum: 0,
          neighborNum: 0,
        };
        neighborLines3DMock = {
          lines: [{ key: 'mc:7', from: [30, -90], to: [31, -91], color: '#06b6d4', opacity: 0.75, width: 3, dash: [3, 2] }],
          selectionByKey: new Map([['mc:7', mcTarget]]),
        };
        persist3d();
        render(
          <>
            <SelectedProbe />
            <MapAnalysisCanvas />
          </>,
          { wrapper },
        );
        fireEvent.click(screen.getByTestId('base-3d-line-mc:7'));
        expect(JSON.parse(screen.getByTestId('selected-probe').textContent ?? 'null')).toEqual(mcTarget);
      });

      it('onLineClick dispatches setSelected with the meshtastic neighbor payload for an "mt:" key', () => {
        const mtTarget = { type: 'neighbor', sourceId: 'a', nodeNum: 1, neighborNum: 2, snr: 5, timestamp: 0 };
        neighborLines3DMock = {
          lines: [{ key: 'mt:1', from: [30, -90], to: [31, -91], color: '#06b6d4', opacity: 0.75, width: 2, dash: [2, 2] }],
          selectionByKey: new Map([['mt:1', mtTarget]]),
        };
        persist3d();
        render(
          <>
            <SelectedProbe />
            <MapAnalysisCanvas />
          </>,
          { wrapper },
        );
        fireEvent.click(screen.getByTestId('base-3d-line-mt:1'));
        expect(JSON.parse(screen.getByTestId('selected-probe').textContent ?? 'null')).toEqual(mtTarget);
      });

      it('clicking a line with no matching selectionByKey entry does not throw or change the selection', () => {
        neighborLines3DMock = {
          lines: [{ key: 'mt:1', from: [30, -90], to: [31, -91], color: '#06b6d4', opacity: 0.75, width: 2, dash: [2, 2] }],
          selectionByKey: new Map(),
        };
        persist3d();
        render(
          <>
            <SelectedProbe />
            <MapAnalysisCanvas />
          </>,
          { wrapper },
        );
        expect(() => fireEvent.click(screen.getByTestId('base-3d-line-mt:1'))).not.toThrow();
        expect(screen.getByTestId('selected-probe').textContent).toBe('null');
      });

      it('passes config.exaggeration as initialExaggeration and persists onExaggerationChange via setExaggeration', () => {
        persist3d();
        render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.getByTestId('base-3d-map')).toHaveAttribute('data-initial-exaggeration', '1.3');

        fireEvent.click(screen.getByTestId('base-3d-change-exaggeration'));

        const stored = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
        expect(stored.exaggeration).toBe(1.9);
      });
    });

    // #4371 A: the view survives a mode switch instead of snapping back to the
    // Default Map Center (or, with none set, the [30, -90] fallback).
    describe('view-state carryover (#4371 A)', () => {
      it('2D mounts at the Default Map Center when no map has reported a view yet', () => {
        render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.getByTestId('map-container')).toHaveAttribute('data-center', '30,-90');
        expect(screen.getByTestId('map-container')).toHaveAttribute('data-zoom', '10');
      });

      it('3D mounts at the view the 2D map was showing, not the Default Map Center', () => {
        persist3d();
        render(
          <>
            <ViewSeeder view={{ center: [47.6, -122.3], zoom: 13 }} />
            <MapAnalysisCanvas />
          </>,
          { wrapper },
        );
        const map3d = screen.getByTestId('base-3d-map');
        expect(map3d).toHaveAttribute('data-center', '47.6,-122.3');
        expect(map3d).toHaveAttribute('data-zoom', '13');
      });

      it('3D restores the pitch/bearing carried through a previous 3D session', () => {
        persist3d();
        render(
          <>
            <ViewSeeder view={{ center: [47.6, -122.3], zoom: 13, pitch: 35, bearing: 210 }} />
            <MapAnalysisCanvas />
          </>,
          { wrapper },
        );
        const map3d = screen.getByTestId('base-3d-map');
        expect(map3d).toHaveAttribute('data-pitch', '35');
        expect(map3d).toHaveAttribute('data-bearing', '210');
      });

      it('leaves pitch/bearing unset (Base3DMap defaults apply) on a first 3D entry from 2D', () => {
        persist3d();
        render(
          <>
            <ViewSeeder view={{ center: [47.6, -122.3], zoom: 13 }} />
            <MapAnalysisCanvas />
          </>,
          { wrapper },
        );
        expect(screen.getByTestId('base-3d-map')).toHaveAttribute('data-pitch', '');
      });

      it('a 3D camera move carries into the 2D map when the view flips back', () => {
        persist3d();
        render(<MapAnalysisCanvas />, { wrapper });

        // Pan/rotate in 3D, then bounce back to 2D via the unsupported signal.
        fireEvent.click(screen.getByTestId('base-3d-move-camera'));
        fireEvent.click(screen.getByTestId('base-3d-trigger-unsupported'));

        const map2d = screen.getByTestId('map-container');
        expect(map2d).toHaveAttribute('data-center', '44.4,-111.1');
        expect(map2d).toHaveAttribute('data-zoom', '15');
      });
    });

    // #4371 B: Follow/Auto-zoom works in 3D.
    describe('follow plumbing (#4371 B)', () => {
      it('mounts Follow3DController in the 3D branch', () => {
        persist3d();
        render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.getByTestId('follow-3d-controller')).toBeInTheDocument();
      });

      it('mounts the Resume-follow affordance in the 3D branch, so a paused follow is recoverable', () => {
        // FollowResumeButton self-hides unless a mode is on AND paused; drive
        // it into its visible state rather than asserting the component's mere
        // presence, which would pass even if it could never show.
        localStorage.setItem(
          'mapAnalysis.config.v1',
          JSON.stringify({ version: 1, viewMode: '3d', followMode: true }),
        );
        render(
          <>
            <PauseFollow />
            <MapAnalysisCanvas />
          </>,
          { wrapper },
        );
        expect(screen.getByRole('button', { name: /resume follow/i })).toBeInTheDocument();
      });

      it('hands Follow3DController the map instance once Base3DMap reports it ready', () => {
        persist3d();
        render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.getByTestId('follow-3d-controller')).toHaveAttribute('data-has-map', 'false');

        fireEvent.click(screen.getByTestId('base-3d-map-ready'));

        expect(screen.getByTestId('follow-3d-controller')).toHaveAttribute('data-has-map', 'true');
      });

      it('does NOT mount the 3D follow controller in the 2D branch', () => {
        render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.queryByTestId('follow-3d-controller')).toBeNull();
      });
    });

    // The time-slider UI and legend are documented 2D-only non-goals of the
    // #3826 3D epic. Pin their absence so an accidental add is caught rather
    // than shipping a control the 3D canvas can't wire up.
    describe('2D-only overlays stay out of the 3D branch', () => {
      it('renders the time slider and legend in 2D', () => {
        localStorage.setItem(
          'mapAnalysis.config.v1',
          JSON.stringify({ version: 1, timeSlider: { enabled: true } }),
        );
        const { container } = render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.getByTestId('time-slider')).toBeInTheDocument();
        expect(container.querySelector('.map-analysis-legend')).not.toBeNull();
      });

      it('omits both from 3D, even with the time slider enabled', () => {
        localStorage.setItem(
          'mapAnalysis.config.v1',
          JSON.stringify({ version: 1, viewMode: '3d', timeSlider: { enabled: true } }),
        );
        const { container } = render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.getByTestId('base-3d-map')).toBeInTheDocument();
        expect(screen.queryByTestId('time-slider')).toBeNull();
        expect(container.querySelector('.map-analysis-legend')).toBeNull();
      });
    });

    // #4371 C: layer switching in 3D.
    describe('layer plumbing (#4371 C)', () => {
      it('renders the tileset selector in 3D, the same control the 2D branch gets', () => {
        persist3d();
        render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.getByText(/Tileset \(/i)).toBeInTheDocument();
      });

      it('feeds Base3DMap the node markers while the markers layer is on (default)', () => {
        persist3d();
        render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.getByTestId('base-3d-map')).toHaveAttribute('data-node-count', '1');
      });

      it('drops the 3D node markers when the markers layer is toggled off', () => {
        localStorage.setItem(
          'mapAnalysis.config.v1',
          JSON.stringify({
            version: 1,
            viewMode: '3d',
            layers: { markers: { enabled: false, lookbackHours: null } },
          }),
        );
        render(<MapAnalysisCanvas />, { wrapper });
        expect(screen.getByTestId('base-3d-map')).toHaveAttribute('data-node-count', '0');
      });
    });
  });
});
