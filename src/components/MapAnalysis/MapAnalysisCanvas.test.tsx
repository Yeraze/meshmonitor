/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import MapAnalysisCanvas from './MapAnalysisCanvas';
import { MapAnalysisProvider } from './MapAnalysisContext';

// Stub react-leaflet — Vitest's jsdom doesn't provide all the DOM bits Leaflet needs.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="map-container">{children}</div>
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

// Base3DMap wraps maplibre-gl directly (WebGL) — unusable under jsdom (see
// spec §4 test plan / Base3DMap.test.tsx, which mocks `maplibre-gl` itself).
// Here it's mocked at the component level: a stub that renders the mapped
// props so this suite can assert the 3D branch feeds it the right data,
// without needing a WebGL context.
vi.mock('../map/Base3DMap', () => ({
  Base3DMap: (props: {
    nodes: Array<{ key: string; lat: number; lng: number; label?: string }>;
    basemap: { tiles: string[]; usedFallback: boolean };
    terrainTileUrl: string;
    onNodeClick?: (key: string) => void;
    onUnsupported?: () => void;
  }) => (
    <div data-testid="base-3d-map" data-terrain-url={props.terrainTileUrl}>
      {props.nodes.map((n) => (
        <button
          key={n.key}
          type="button"
          data-testid={`base-3d-node-${n.key}`}
          onClick={() => props.onNodeClick?.(n.key)}
        >
          {n.label}
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
    </div>
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

describe('MapAnalysisCanvas', () => {
  beforeEach(() => {
    localStorage.clear();
    mapTilesetMock = 'osm';
    customTilesetsMock = [];
    terrainCapabilitiesMock = { enabled: true, terrainTiles: true, isLoading: false };
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
  });
});
