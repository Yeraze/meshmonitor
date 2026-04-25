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
  useMap: () => ({ fitBounds: vi.fn(), setView: vi.fn() }),
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
});
