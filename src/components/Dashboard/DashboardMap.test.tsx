/**
 * @vitest-environment jsdom
 */
import { useEffect, useRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DashboardMap from './DashboardMap';
import { darkOverlayColors } from '../../config/overlayColors';

// Shared, mutable mocks for the map instance and settings so individual tests
// can assert fitBounds behavior and toggle the Default Map Center (issue #4125).
const mocks = vi.hoisted(() => ({
  fitBounds: vi.fn(),
  settings: {
    mapPinStyle: 'official' as string,
    overlayColors: undefined as unknown,
    setMapTileset: undefined as unknown,
    defaultMapCenterLat: null as number | null,
    defaultMapCenterLon: null as number | null,
    defaultMapCenterZoom: null as number | null,
  },
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// DashboardMap now composes the shared `BaseMap` shell (#4047 Phase 7 WP7/10)
// instead of its own MapContainer/TileLayer. BaseMap transitively imports
// VectorTileLayer (real module pulls in maplibre-gl side effects) and the
// side-effecting leafletDefaultIcon module (mutates L.Icon.Default, which the
// `leaflet` mock below doesn't provide) — both are stubbed the same way
// BaseMap.test.tsx does it, so this bare-component render stays dependency-free.
vi.mock('../VectorTileLayer', () => ({
  VectorTileLayer: () => <div data-testid="vector-tile-layer" />,
}));
vi.mock('../map/leafletDefaultIcon', () => ({}));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => <div data-testid="tile-layer" />,
  Marker: ({ children, opacity, ref }: any) => {
    // The shared NodeMarkersLayer (#4047 Phase 4 WP5) forwards a ref to
    // register each marker with the (mocked) spiderfier hook below. A plain
    // function component can't accept `ref` for real, so invoke it manually
    // on mount/unmount with a minimal fake marker — mirrors the pattern in
    // src/components/map/layers/NodeMarkersLayer.test.tsx.
    const instRef = useRef<any>(null);
    if (!instRef.current) instRef.current = { openPopup: vi.fn(), off: vi.fn() };
    useEffect(() => {
      ref?.(instRef.current);
      return () => ref?.(null);
    }, [ref]);
    return <div data-testid="map-marker" data-opacity={opacity}>{children}</div>;
  },
  Popup: ({ children }: any) => <div data-testid="map-popup">{children}</div>,
  // #4042: expose resolved positions so tests can assert a neighbor line
  // terminates at a node's rendered marker position (not the link's raw
  // embedded lat/lng) — mirrors NeighborLinksLayer.test.tsx's mock.
  Polyline: ({ positions }: any) => (
    <div data-testid="map-polyline" data-positions={JSON.stringify(positions)} />
  ),
  Rectangle: () => <div data-testid="map-rectangle" />,
  useMap: () => ({ fitBounds: mocks.fitBounds, setView: vi.fn() }),
}));

// MapContext is normally provided by DashboardPage; in tests we mock the hook
// directly so the toggles default to a known state and don't fire any server
// preference fetches. Defaults below: RF/UDP/MQTT all visible (so transport
// filtering doesn't drop existing fixture nodes), traceroute/accuracy off.
vi.mock('../../contexts/MapContext', () => ({
  useMapContext: () => ({
    showPaths: false,
    setShowPaths: vi.fn(),
    showRoute: false,
    setShowRoute: vi.fn(),
    showAccuracyRegions: false,
    setShowAccuracyRegions: vi.fn(),
    showRfNodes: true,
    setShowRfNodes: vi.fn(),
    showUdpNodes: true,
    setShowUdpNodes: vi.fn(),
    showMqttNodes: true,
    setShowMqttNodes: vi.fn(),
    showNeighborInfo: true,
    setShowNeighborInfo: vi.fn(),
    showWaypoints: false,
    setShowWaypoints: vi.fn(),
    showPolarGrid: false,
    setShowPolarGrid: vi.fn(),
  }),
}));

// Polar grid (#3971) pulls the source list + per-source status to resolve each
// source's own-node position. Mock the data hooks so the bare component renders
// without a QueryClient/AuthProvider; empty data ⇒ no grid, existing assertions
// (marker/polyline counts) are unaffected.
vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [] }),
  useSourceStatuses: () => new Map(),
  UNIFIED_SOURCE_ID: '__unified__',
}));

// CSRF + api are provided by the app shell in production; mock them so the bare
// component renders and the GeoJSON layer fetch is inert in tests.
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../services/api', () => ({
  default: { getBaseUrl: vi.fn().mockResolvedValue('') },
}));

// The marker popup (DashboardNodePopup) reads time/date format from
// SettingsContext; mock the display-settings hook so tests don't need a
// SettingsProvider.
vi.mock('../../contexts/SettingsContext', () => ({
  useDisplaySettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
  useSettings: () => mocks.settings,
}));

vi.mock('leaflet', () => ({
  default: {
    divIcon: () => ({}),
    latLngBounds: (...args: any[]) => ({ isValid: () => args.length > 0 }),
  },
  divIcon: () => ({}),
  latLngBounds: (...args: any[]) => ({ isValid: () => args.length > 0 }),
}));

const createNodeIconMock = vi.fn(() => ({}));
vi.mock('../../utils/mapIcons', () => ({
  createNodeIcon: (...args: any[]) => createNodeIconMock(...args),
  getHopColor: () => '#000',
}));

vi.mock('../../config/tilesets', () => ({
  getTilesetById: () => ({
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OSM',
    maxZoom: 19,
  }),
  DEFAULT_TILESET_ID: 'osm',
}));

vi.mock('./DashboardWaypoints', () => ({
  default: () => <div data-testid="dashboard-waypoints" />,
}));

// useMarkerSpiderfier drives the real Leaflet OverlappingMarkerSpiderfier,
// which needs a live map instance. DashboardMap no longer wires this itself
// (#4047 Phase 4 WP5) — it renders the shared NodeMarkersLayer, which calls
// the hook directly. In these DOM-light tests the map is mocked, so stub the
// hook to inert no-ops; addMarker is asserted below to prove every rendered
// marker still registers with the spiderfier (#3612).
const addMarkerMock = vi.fn();
const addListenerMock = vi.fn();
vi.mock('../../hooks/useMarkerSpiderfier', () => ({
  useMarkerSpiderfier: () => ({
    addMarker: addMarkerMock,
    removeMarker: vi.fn(),
    addListener: addListenerMock,
    removeListener: vi.fn(),
  }),
  SHARED_SPIDERFIER_OPTIONS: {},
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const nowSeconds = Math.floor(Date.now() / 1000);
const recent = nowSeconds - 60; // 1 minute ago — well inside 24h window
const stale = nowSeconds - 60 * 60 * 48; // 48h ago — outside default 24h window

const nodeWithPosition = {
  user: { id: 'node-1', shortName: 'N1', longName: 'Node One' },
  position: { latitude: 35.0, longitude: -80.0 },
  hopsAway: 1,
  role: 1,
  lastHeard: recent,
};

const nodeWithoutPosition = {
  user: { id: 'node-2', shortName: 'N2', longName: 'Node Two' },
  position: null,
  hopsAway: 2,
  role: 1,
  lastHeard: recent,
};

const nodeWithZeroPosition = {
  user: { id: 'node-3', shortName: 'N3', longName: 'Node Three' },
  position: { latitude: 0, longitude: 0 },
  hopsAway: 3,
  role: 1,
  lastHeard: recent,
};

const ignoredNodeWithPosition = {
  user: { id: 'node-4', shortName: 'N4', longName: 'Ignored Node' },
  position: { latitude: 36.5, longitude: -81.5 },
  hopsAway: 1,
  role: 1,
  lastHeard: recent,
  isIgnored: true,
};

const staleNodeWithPosition = {
  user: { id: 'node-5', shortName: 'N5', longName: 'Stale Node' },
  position: { latitude: 36.0, longitude: -81.0 },
  hopsAway: 1,
  role: 1,
  lastHeard: stale,
};

const staleFavoriteNodeWithPosition = {
  user: { id: 'node-6', shortName: 'N6', longName: 'Stale Favorite' },
  position: { latitude: 36.2, longitude: -81.2 },
  hopsAway: 1,
  role: 1,
  lastHeard: stale,
  isFavorite: true,
};

const neighborLinkWithPositions = {
  nodeNum: 1,
  neighborNodeNum: 2,
  nodeLatitude: 35.0,
  nodeLongitude: -80.0,
  neighborLatitude: 36.0,
  neighborLongitude: -81.0,
  bidirectional: true,
  snr: 5,
};

// #4042 fixtures: a node whose rendered marker position (100) DIFFERS from
// the neighbor-link's own embedded coordinates, to prove endpoint resolution
// prefers the marker. neighborNum 999 has no corresponding node/marker, so
// its endpoint must fall back to the link's embedded coordinates.
const nodeWithMergedPosition = {
  user: { id: 'node-7', shortName: 'N7', longName: 'Merged Position Node' },
  position: { latitude: 40.0, longitude: -90.0 },
  hopsAway: 1,
  role: 1,
  lastHeard: recent,
  nodeNum: 100,
};

const neighborLinkStaleEmbeddedCoords = {
  nodeNum: 100,
  neighborNodeNum: 999,
  // Stale/source-specific coordinates for nodeNum 100 — should be ignored in
  // favor of its rendered marker position (40.0, -90.0) above.
  nodeLatitude: 10.0,
  nodeLongitude: -20.0,
  // neighborNodeNum 999 has no node/marker on the map, so this embedded
  // fallback coordinate IS expected to be used.
  neighborLatitude: 50.0,
  neighborLongitude: -100.0,
  bidirectional: true,
  snr: 5,
};

const neighborLinkMissingPositions = {
  nodeNum: 3,
  neighborNodeNum: 4,
  nodeLatitude: null,
  nodeLongitude: null,
  neighborLatitude: 36.0,
  neighborLongitude: -81.0,
  bidirectional: false,
  snr: 3,
};

const defaultProps = {
  nodes: [],
  neighborInfo: [],
  meshcoreNeighbors: [],
  traceroutes: [],
  channels: [],
  tilesetId: 'osm',
  customTilesets: [],
  defaultCenter: { lat: 35.0, lng: -80.0 },
  sourceId: null,
  maxNodeAgeHours: 24,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Reset the shared settings mock to "no Default Map Center configured".
    mocks.settings.mapPinStyle = 'official';
    mocks.settings.overlayColors = darkOverlayColors;
    mocks.settings.setMapTileset = vi.fn();
    mocks.settings.defaultMapCenterLat = null;
    mocks.settings.defaultMapCenterLon = null;
    mocks.settings.defaultMapCenterZoom = null;
  });

  // --- Default Map Center vs auto-fit (issue #4125) ---------------------------

  it('auto-fits bounds to node positions when no Default Map Center is configured', () => {
    render(<DashboardMap {...defaultProps} nodes={[nodeWithPosition]} />);
    expect(mocks.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('does not auto-fit bounds when a Default Map Center is configured (issue #4125)', () => {
    mocks.settings.defaultMapCenterLat = 27.5;
    mocks.settings.defaultMapCenterLon = -82.5;
    mocks.settings.defaultMapCenterZoom = 8;
    render(<DashboardMap {...defaultProps} nodes={[nodeWithPosition]} />);
    // A configured default center must win over auto-fit — otherwise the map
    // pans/zooms out to include stray out-of-region nodes (the reported bug).
    expect(mocks.fitBounds).not.toHaveBeenCalled();
  });

  // --- Features panel collapse (#3912) ---------------------------------------

  it('shows the Features panel toggles by default', () => {
    render(<DashboardMap {...defaultProps} />);
    expect(screen.getByText('Show Traceroute')).toBeInTheDocument();
  });

  it('hides the Features panel toggles when the collapse button is clicked', () => {
    render(<DashboardMap {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Collapse controls'));
    expect(screen.queryByText('Show Traceroute')).not.toBeInTheDocument();
    expect(screen.getByText('Features')).toBeInTheDocument();
  });

  it('restores a collapsed Features panel from localStorage (shared with the NodesTab map)', () => {
    localStorage.setItem('isMapControlsCollapsed', 'true');
    render(<DashboardMap {...defaultProps} />);
    expect(screen.queryByText('Show Traceroute')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Expand controls'));
    expect(screen.getByText('Show Traceroute')).toBeInTheDocument();
  });

  it('renders the map container', () => {
    render(<DashboardMap {...defaultProps} />);
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
    expect(screen.getByTestId('tile-layer')).toBeInTheDocument();
  });

  it('registers node markers with the shared spiderfier so co-located markers fan out (#3612)', () => {
    render(<DashboardMap {...defaultProps} nodes={[nodeWithPosition]} />);
    expect(addMarkerMock).toHaveBeenCalledTimes(1);
  });

  it('renders markers for nodes with valid positions', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithPosition]}
      />,
    );
    const markers = screen.getAllByTestId('map-marker');
    expect(markers.length).toBe(1);
  });

  it('fades markers by recency and keeps favorites fully opaque (#3886)', () => {
    render(
      <DashboardMap
        {...defaultProps}
        // 72h window so the 48h-old stale node survives the cutoff and can fade.
        maxNodeAgeHours={72}
        nodes={[nodeWithPosition, staleNodeWithPosition, staleFavoriteNodeWithPosition]}
      />,
    );
    const opacities = screen
      .getAllByTestId('map-marker')
      .map((m) => Number(m.getAttribute('data-opacity')));
    expect(opacities).toHaveLength(3);
    const [fresh, staleOpacity, favorite] = opacities;
    // Freshly heard node is ~fully opaque; the 48h-old node is clearly faded
    // but above the floor; the stale favorite bypasses the age fade entirely.
    expect(fresh).toBeGreaterThan(0.99);
    expect(favorite).toBe(1);
    expect(staleOpacity).toBeGreaterThan(0.25);
    // Strictly and clearly dimmer than fresh — guards against an inverted fade
    // (newer = more transparent) slipping through, which `< fresh` alone would
    // miss for a node heard just inside a wide window.
    expect(staleOpacity).toBeLessThan(0.7);
  });

  it('forwards the configured map pin style to createNodeIcon (issue #3364)', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithPosition]}
      />,
    );
    expect(createNodeIconMock).toHaveBeenCalledWith(
      expect.objectContaining({ pinStyle: 'official' }),
    );
  });

  it('does not render markers for nodes without positions', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithoutPosition, nodeWithZeroPosition]}
      />,
    );
    expect(screen.queryAllByTestId('map-marker')).toHaveLength(0);
  });

  it('renders polylines for neighbor links that have positions', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithPosition]}
        neighborInfo={[neighborLinkWithPositions, neighborLinkMissingPositions]}
      />,
    );
    const polylines = screen.getAllByTestId('map-polyline');
    // Only the link with valid positions should be rendered. Interactive
    // links render two polylines since the thin-line click-target fix
    // (visible line + invisible wide hit companion sharing its positions).
    expect(polylines.length).toBe(2);
    expect(new Set(polylines.map((p) => p.getAttribute('data-positions'))).size).toBe(1);
  });

  it('resolves a neighbor-link endpoint to the rendered marker position when present, falling back to the embedded coordinate otherwise (#4042)', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithMergedPosition]}
        neighborInfo={[neighborLinkStaleEmbeddedCoords]}
      />,
    );
    // Interactive links render visible + hit-companion polylines with the
    // same positions since the thin-line click-target fix — check the first.
    const polyline = screen.getAllByTestId('map-polyline')[0];
    const positions = JSON.parse(polyline.getAttribute('data-positions') ?? 'null');
    // nodeNum 100 has a rendered marker at [40.0, -90.0] — the resolved
    // endpoint uses that marker position, NOT the link's stale embedded
    // [10.0, -20.0].
    expect(positions[0]).toEqual([40.0, -90.0]);
    // neighborNodeNum 999 has no node/marker on the map — its endpoint falls
    // back to the link's embedded coordinate.
    expect(positions[1]).toEqual([50.0, -100.0]);
  });

  it('shows empty state overlay when no nodes have positions', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithoutPosition, nodeWithZeroPosition]}
      />,
    );
    expect(screen.getByText('No node positions')).toBeInTheDocument();
    expect(
      screen.getByText(/Select a source with nodes that have GPS positions/),
    ).toBeInTheDocument();
  });

  it('does not show empty state when at least one node has a position', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithPosition, nodeWithoutPosition]}
      />,
    );
    expect(screen.queryByText('No node positions')).not.toBeInTheDocument();
  });

  // --- Loading overlay (initial-fetch spinner) --------------------------------

  it('shows the loading overlay instead of the empty state while isLoading is true', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithoutPosition, nodeWithZeroPosition]}
        isLoading
      />,
    );
    expect(screen.getByTestId('map-loading-overlay')).toBeInTheDocument();
    expect(screen.queryByText('No node positions')).not.toBeInTheDocument();
  });

  it('shows the empty state (not the loading overlay) once loading resolves with no positioned nodes', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithoutPosition, nodeWithZeroPosition]}
        isLoading={false}
      />,
    );
    expect(screen.queryByTestId('map-loading-overlay')).not.toBeInTheDocument();
    expect(screen.getByText('No node positions')).toBeInTheDocument();
  });

  it('shows neither overlay once loading resolves with positioned nodes', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithPosition]}
        isLoading={false}
      />,
    );
    expect(screen.queryByTestId('map-loading-overlay')).not.toBeInTheDocument();
    expect(screen.queryByText('No node positions')).not.toBeInTheDocument();
  });

  it('does not render markers for ignored nodes even when they have a position', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithPosition, ignoredNodeWithPosition]}
      />,
    );
    const markers = screen.getAllByTestId('map-marker');
    expect(markers.length).toBe(1);
  });

  it('shows empty state when the only positioned node is ignored', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[ignoredNodeWithPosition]}
      />,
    );
    expect(screen.getByText('No node positions')).toBeInTheDocument();
  });

  it('does not render markers for stale (inactive) nodes outside the maxNodeAgeHours window', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[nodeWithPosition, staleNodeWithPosition]}
      />,
    );
    const markers = screen.getAllByTestId('map-marker');
    expect(markers.length).toBe(1);
  });

  it('renders markers for stale nodes that are favorites (favorites bypass age filter)', () => {
    render(
      <DashboardMap
        {...defaultProps}
        nodes={[staleFavoriteNodeWithPosition]}
      />,
    );
    const markers = screen.getAllByTestId('map-marker');
    expect(markers.length).toBe(1);
  });

  // --- MeshCore neighbor links ------------------------------------------------

  const mcNodeA = {
    isMeshCore: true, publicKey: 'AAAA', nodeNum: 0,
    user: { id: 'mc:s:AAAA', shortName: 'A', longName: 'MC A' },
    position: { latitude: 35.0, longitude: -80.0 },
    hopsAway: 0, role: 0, lastHeard: recent,
  };
  const mcNodeB = {
    isMeshCore: true, publicKey: 'BBBB', nodeNum: 0,
    user: { id: 'mc:s:BBBB', shortName: 'B', longName: 'MC B' },
    position: { latitude: 36.0, longitude: -81.0 },
    hopsAway: 0, role: 0, lastHeard: recent,
  };
  const mcEdge = { id: 1, publicKey: 'AAAA', neighborPublicKey: 'BBBB', sourceId: 's', snr: 5, timestamp: recent * 1000 };

  it('renders a MeshCore neighbor link between two positioned MeshCore nodes', () => {
    render(
      <DashboardMap {...defaultProps} nodes={[mcNodeA, mcNodeB]} meshcoreNeighbors={[mcEdge]} />,
    );
    expect(screen.getAllByTestId('map-marker')).toHaveLength(2);
    // One MeshCore neighbor polyline (no traceroute/meshtastic-neighbor lines here).
    expect(screen.getAllByTestId('map-polyline')).toHaveLength(1);
  });

  it('does not render a MeshCore neighbor link when one endpoint node is not visible', () => {
    render(
      <DashboardMap {...defaultProps} nodes={[mcNodeA]} meshcoreNeighbors={[mcEdge]} />,
    );
    expect(screen.getAllByTestId('map-marker')).toHaveLength(1);
    expect(screen.queryAllByTestId('map-polyline')).toHaveLength(0);
  });

  it('deduplicates a MeshCore link reported by multiple sources (drawn once)', () => {
    const reverseEdge = { id: 2, publicKey: 'BBBB', neighborPublicKey: 'AAAA', sourceId: 's2', snr: 4, timestamp: recent * 1000 };
    render(
      <DashboardMap {...defaultProps} nodes={[mcNodeA, mcNodeB]} meshcoreNeighbors={[mcEdge, reverseEdge]} />,
    );
    expect(screen.getAllByTestId('map-polyline')).toHaveLength(1);
  });

  // --- MeshCore marker keying (#4234) ----------------------------------------

  // Real API rows (buildSourceNodes / /api/nodes) always carry sourceId AND
  // nodeNum: 0 for MeshCore nodes — unlike mcNodeA/mcNodeB above, which have no
  // sourceId. Under the old `${sourceId}:${nodeNum}` key scheme every MeshCore
  // node on a source collapsed onto the same React key (`<sourceId>:0`), and
  // React's duplicate-key reconciliation duplicated markers / failed to unmount
  // them when the selected source changed — MeshCore ghost markers showed up on
  // every source's map.
  const mcApiNodeA = {
    nodeId: 'mc:src-mc:AAAA', nodeNum: 0, sourceId: 'src-mc', isMeshCore: true, publicKey: 'AAAA',
    user: { id: 'mc:src-mc:AAAA', shortName: 'A', longName: 'MC A' },
    position: { latitude: 35.0, longitude: -80.0 },
    hopsAway: 0, role: 0, lastHeard: recent,
  };
  const mcApiNodeB = {
    nodeId: 'mc:src-mc:BBBB', nodeNum: 0, sourceId: 'src-mc', isMeshCore: true, publicKey: 'BBBB',
    user: { id: 'mc:src-mc:BBBB', shortName: 'B', longName: 'MC B' },
    position: { latitude: 36.0, longitude: -81.0 },
    hopsAway: 0, role: 0, lastHeard: recent,
  };

  it('keys MeshCore markers uniquely despite shared sourceId + nodeNum 0 (#4234)', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<DashboardMap {...defaultProps} nodes={[mcApiNodeA, mcApiNodeB]} />);
      expect(screen.getAllByTestId('map-marker')).toHaveLength(2);
      const duplicateKeyErrors = consoleErrorSpy.mock.calls.filter((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('same key')),
      );
      expect(duplicateKeyErrors).toHaveLength(0);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('removes MeshCore markers when the node list switches to another source (#4234)', () => {
    const { rerender } = render(
      <DashboardMap {...defaultProps} nodes={[mcApiNodeA, mcApiNodeB]} />,
    );
    expect(screen.getAllByTestId('map-marker')).toHaveLength(2);
    // Simulate picking a Meshtastic source in the sidebar: same map component,
    // new nodes prop. Every MeshCore marker must unmount.
    rerender(<DashboardMap {...defaultProps} nodes={[nodeWithPosition]} />);
    const markers = screen.getAllByTestId('map-marker');
    expect(markers).toHaveLength(1);
    expect(markers[0].textContent).not.toContain('MC');
  });
});
