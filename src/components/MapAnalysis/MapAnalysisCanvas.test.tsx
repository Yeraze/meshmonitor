/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  Pane: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
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

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    defaultMapCenterLat: 30,
    defaultMapCenterLon: -90,
    defaultMapCenterZoom: 10,
    mapTileset: 'osm',
    customTilesets: [],
    setMapTileset: vi.fn(),
  }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <MapAnalysisProvider>{children}</MapAnalysisProvider>
    </QueryClientProvider>
  );
};

describe('MapAnalysisCanvas', () => {
  beforeEach(() => localStorage.clear());

  it('renders the map container and tile layer', () => {
    render(<MapAnalysisCanvas />, { wrapper });
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
    expect(screen.getByTestId('tile-layer')).toBeInTheDocument();
  });

  it('renders a marker per node when markers layer is enabled (default)', () => {
    render(<MapAnalysisCanvas />, { wrapper });
    expect(screen.getAllByTestId('marker').length).toBeGreaterThan(0);
  });
});
