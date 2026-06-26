/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import NeighborLinksLayer from './NeighborLinksLayer';

vi.mock('react-leaflet', () => ({
  Polyline: () => <div data-testid="poly" />,
}));

// Mutable mock state so individual tests can vary the edges/nodes.
const mockState: {
  edges: Array<Record<string, unknown>>;
  nodes: Array<Record<string, unknown>>;
} = {
  edges: [{ id: 1, nodeNum: 1, neighborNum: 2, sourceId: 'a', snr: 5, timestamp: 0 }],
  nodes: [
    { nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
    { nodeNum: 2, sourceId: 'a', position: { latitude: 31, longitude: -91 } },
  ],
};

vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useNeighbors: () => ({ data: { items: mockState.edges }, isLoading: false }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }),
  useDashboardUnifiedData: () => ({ nodes: mockState.nodes }),
  UNIFIED_SOURCE_ID: '__unified__',
}));

describe('NeighborLinksLayer', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset to the single-source defaults before each test.
    mockState.edges = [{ id: 1, nodeNum: 1, neighborNum: 2, sourceId: 'a', snr: 5, timestamp: 0 }];
    mockState.nodes = [
      { nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
      { nodeNum: 2, sourceId: 'a', position: { latitude: 31, longitude: -91 } },
    ];
  });

  it('renders one polyline per edge', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <NeighborLinksLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('poly')).toHaveLength(1);
  });

  it('excludes edges outside the time slider window when slider is enabled', () => {
    localStorage.setItem(
      'mapAnalysis.config.v1',
      JSON.stringify({
        version: 1,
        layers: {
          markers: { enabled: false, lookbackHours: null },
          traceroutes: { enabled: false, lookbackHours: 24 },
          neighbors: { enabled: true, lookbackHours: 24 },
          heatmap: { enabled: false, lookbackHours: 24 },
          trails: { enabled: false, lookbackHours: 24 },
          hopShading: { enabled: false, lookbackHours: null },
          snrOverlay: { enabled: false, lookbackHours: 24 },
        },
        sources: [],
        // Window [10, 20] excludes the mock edge at timestamp 0
        timeSlider: { enabled: true, windowStartMs: 10, windowEndMs: 20 },
        inspectorOpen: true,
      }),
    );
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <NeighborLinksLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryAllByTestId('poly')).toHaveLength(0);
  });

  it('renders a cross-source edge when the neighbor is positioned under a different source (#3792)', () => {
    // Edge reported on source 'a'; neighbor node 2 only has a position under
    // source 'b'. Before the fix the strict `a:2` lookup missed and the edge
    // was silently dropped (intersection instead of union).
    mockState.edges = [{ id: 1, nodeNum: 1, neighborNum: 2, sourceId: 'a', snr: 5, timestamp: 0 }];
    mockState.nodes = [
      { nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
      { nodeNum: 2, sourceId: 'b', position: { latitude: 31, longitude: -91 } },
    ];
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <NeighborLinksLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('poly')).toHaveLength(1);
  });

  it('still drops an edge when an endpoint has no position on any source', () => {
    // Neighbor node 2 has no position anywhere → edge cannot be drawn.
    mockState.edges = [{ id: 1, nodeNum: 1, neighborNum: 2, sourceId: 'a', snr: 5, timestamp: 0 }];
    mockState.nodes = [
      { nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
    ];
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <NeighborLinksLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryAllByTestId('poly')).toHaveLength(0);
  });
});
