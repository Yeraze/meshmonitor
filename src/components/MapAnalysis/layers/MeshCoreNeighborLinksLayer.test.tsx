/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import MeshCoreNeighborLinksLayer from './MeshCoreNeighborLinksLayer';

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
  edges: [
    {
      id: 1,
      publicKey: 'aa',
      neighborPublicKey: 'bb',
      sourceId: 'a',
      snr: 5,
      timestamp: 0,
      nodeName: 'Alpha',
      neighborName: 'Beta',
    },
  ],
  nodes: [
    { sourceId: 'a', isMeshCore: true, publicKey: 'aa', position: { latitude: 30, longitude: -90 } },
    { sourceId: 'a', isMeshCore: true, publicKey: 'bb', position: { latitude: 31, longitude: -91 } },
  ],
};

vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useMeshCoreNeighbors: () => ({ data: { items: mockState.edges }, isLoading: false }),
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

describe('MeshCoreNeighborLinksLayer', () => {
  beforeEach(() => {
    localStorage.clear();
    mockState.edges = [
      {
        id: 1,
        publicKey: 'aa',
        neighborPublicKey: 'bb',
        sourceId: 'a',
        snr: 5,
        timestamp: 0,
        nodeName: 'Alpha',
        neighborName: 'Beta',
      },
    ];
    mockState.nodes = [
      { sourceId: 'a', isMeshCore: true, publicKey: 'aa', position: { latitude: 30, longitude: -90 } },
      { sourceId: 'a', isMeshCore: true, publicKey: 'bb', position: { latitude: 31, longitude: -91 } },
    ];
  });

  it('renders one polyline per edge with the fixed-cyan dashed pathOptions', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <MeshCoreNeighborLinksLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    const polys = visiblePolys();
    expect(polys).toHaveLength(1);
    // Pins the pre-promotion look (fixed cyan, weight 1.5, dash '6 4') so the
    // shared-layer adapter is byte-for-byte identical. opacity = snrToNeighborOpacity(5)
    // = clamp((5 + 10) / 20, 0.2, 1) = 0.75.
    expect(JSON.parse(polys[0].getAttribute('data-path-options')!)).toEqual({
      color: '#06b6d4',
      weight: 1.5,
      opacity: 0.75,
      dashArray: '6 4',
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
          <MeshCoreNeighborLinksLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryAllByTestId('poly')).toHaveLength(0);
  });

  it('drops an edge when an endpoint has no MeshCore position on the reporting source', () => {
    mockState.nodes = [
      { sourceId: 'a', isMeshCore: true, publicKey: 'aa', position: { latitude: 30, longitude: -90 } },
    ];
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <MeshCoreNeighborLinksLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryAllByTestId('poly')).toHaveLength(0);
  });
});
