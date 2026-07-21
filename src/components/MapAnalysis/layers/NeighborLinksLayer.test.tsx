/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import NeighborLinksLayer from './NeighborLinksLayer';

vi.mock('react-leaflet', () => ({
  Polyline: (props: { pathOptions?: Record<string, unknown> }) => (
    <div data-testid="poly" data-path-options={JSON.stringify(props.pathOptions)} />
  ),
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


/** Visible line divs only — interactive links also render an invisible
 *  12px hit companion (opacity 0) since the thin-line click-target fix. */
function visiblePolys() {
  return screen.getAllByTestId('poly').filter((el) => {
    const po = JSON.parse(el.getAttribute('data-path-options') ?? '{}');
    return po.opacity !== 0;
  });
}

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

  it('renders one polyline per edge, colored/dashed per the pre-promotion RF look', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <NeighborLinksLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    const polys = visiblePolys();
    expect(polys).toHaveLength(1);
    // Pins the pre-promotion look (RF transport color, weight 1, dash '4 4')
    // so the shared-layer adapter is byte-for-byte identical. opacity =
    // snrToNeighborOpacity(5) = clamp((5 + 10) / 20, 0.2, 1) = 0.75.
    expect(JSON.parse(polys[0].getAttribute('data-path-options')!)).toEqual({
      color: '#06b6d4',
      weight: 1,
      opacity: 0.75,
      dashArray: '4 4',
    });
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
    expect(visiblePolys()).toHaveLength(1);
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
