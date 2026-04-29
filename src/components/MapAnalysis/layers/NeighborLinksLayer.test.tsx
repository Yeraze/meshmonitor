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
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useNeighbors: () => ({
    data: {
      items: [
        { id: 1, nodeNum: 1, neighborNum: 2, sourceId: 'a', snr: 5, timestamp: 0 },
      ],
    },
    isLoading: false,
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
  useDashboardUnifiedData: () => ({
    nodes: [
      { nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
      { nodeNum: 2, sourceId: 'a', position: { latitude: 31, longitude: -91 } },
    ],
  }),
  UNIFIED_SOURCE_ID: '__unified__',
}));

describe('NeighborLinksLayer', () => {
  beforeEach(() => localStorage.clear());

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
});
