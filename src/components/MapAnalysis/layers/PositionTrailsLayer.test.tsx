/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import PositionTrailsLayer from './PositionTrailsLayer';

vi.mock('react-leaflet', () => ({
  Polyline: () => <div data-testid="poly" />,
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  usePositions: () => ({
    items: [
      { nodeNum: 1, sourceId: 'a', latitude: 30, longitude: -90, timestamp: 1 },
      { nodeNum: 1, sourceId: 'a', latitude: 30.1, longitude: -90.1, timestamp: 2 },
      { nodeNum: 2, sourceId: 'a', latitude: 31, longitude: -91, timestamp: 1 },
      { nodeNum: 2, sourceId: 'a', latitude: 31.1, longitude: -91.1, timestamp: 2 },
    ],
    isLoading: false,
    progress: { loaded: 4, estimatedTotal: 4, percent: 100 },
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
}));

describe('PositionTrailsLayer', () => {
  beforeEach(() => localStorage.clear());

  it('renders one polyline per node with 2+ position fixes', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <PositionTrailsLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('poly')).toHaveLength(2);
  });

  it('excludes points outside the time slider window when slider is enabled', () => {
    // Window [2, 3] keeps only timestamps == 2. The mock has 4 points with
    // timestamps [1, 2, 1, 2] — after filter, each node has exactly 1 fix
    // (timestamp 2), which is below the 2-fix minimum for a trail. Result:
    // zero polylines.
    localStorage.setItem(
      'mapAnalysis.config.v1',
      JSON.stringify({
        version: 1,
        layers: {
          markers: { enabled: false, lookbackHours: null },
          traceroutes: { enabled: false, lookbackHours: 24 },
          neighbors: { enabled: false, lookbackHours: 24 },
          heatmap: { enabled: false, lookbackHours: 24 },
          trails: { enabled: true, lookbackHours: 24 },
          hopShading: { enabled: false, lookbackHours: null },
          snrOverlay: { enabled: false, lookbackHours: 24 },
        },
        sources: [],
        timeSlider: { enabled: true, windowStartMs: 2, windowEndMs: 3 },
        inspectorOpen: true,
      }),
    );
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <PositionTrailsLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryAllByTestId('poly')).toHaveLength(0);
  });
});
