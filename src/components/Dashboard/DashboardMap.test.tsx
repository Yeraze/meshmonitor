/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import DashboardMap from './DashboardMap';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => <div data-testid="tile-layer" />,
  Marker: ({ children }: any) => <div data-testid="map-marker">{children}</div>,
  Popup: ({ children }: any) => <div data-testid="map-popup">{children}</div>,
  Polyline: () => <div data-testid="map-polyline" />,
  Rectangle: () => <div data-testid="map-rectangle" />,
  useMap: () => ({ fitBounds: vi.fn(), setView: vi.fn() }),
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
  }),
}));

// The marker popup (DashboardNodePopup) reads time/date format from
// SettingsContext; mock the display-settings hook so tests don't need a
// SettingsProvider.
vi.mock('../../contexts/SettingsContext', () => ({
  useDisplaySettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('leaflet', () => ({
  default: {
    divIcon: () => ({}),
    latLngBounds: (...args: any[]) => ({ isValid: () => args.length > 0 }),
  },
  divIcon: () => ({}),
  latLngBounds: (...args: any[]) => ({ isValid: () => args.length > 0 }),
}));

vi.mock('../../utils/mapIcons', () => ({
  createNodeIcon: () => ({}),
  getHopColor: () => '#000',
}));

vi.mock('../../config/tilesets', () => ({
  getTilesetById: () => ({
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OSM',
    maxZoom: 19,
  }),
}));

vi.mock('./DashboardWaypoints', () => ({
  default: () => <div data-testid="dashboard-waypoints" />,
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
  nodeLatitude: 35.0,
  nodeLongitude: -80.0,
  neighborLatitude: 36.0,
  neighborLongitude: -81.0,
  bidirectional: true,
  snr: 5,
};

const neighborLinkMissingPositions = {
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
  });

  it('renders the map container', () => {
    render(<DashboardMap {...defaultProps} />);
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
    expect(screen.getByTestId('tile-layer')).toBeInTheDocument();
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
    // Only the link with valid positions should be rendered
    expect(polylines.length).toBe(1);
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
});
