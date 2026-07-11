/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  Pane: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  // Spiderfier (NodeMarkersLayer) calls useMap(); null makes the hook a no-op.
  useMap: () => null,
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

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    defaultMapCenterLat: 30,
    defaultMapCenterLon: -90,
    defaultMapCenterZoom: 10,
    mapTileset: 'osm',
    customTilesets: [],
    setMapTileset: vi.fn(),
  }),
  // Used by DashboardNodePopup, which now renders inside the node marker popups.
  useDisplaySettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
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

  it('node popup lists every source that reported the node', () => {
    render(<MapAnalysisCanvas />, { wrapper });
    // The rich DashboardNodePopup now renders inside the marker popup and shows
    // a "Seen by N sources" list for multi-source nodes (#2805 / Unified parity).
    expect(screen.getByText(/Seen by 2 sources/i)).toBeInTheDocument();
    expect(screen.getByText('Alpha Src')).toBeInTheDocument();
    expect(screen.getByText('Beta Src')).toBeInTheDocument();
  });
});
