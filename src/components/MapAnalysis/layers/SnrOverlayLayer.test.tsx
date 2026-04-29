/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import SnrOverlayLayer from './SnrOverlayLayer';

vi.mock('react-leaflet', () => ({
  CircleMarker: () => <div data-testid="snr-dot" />,
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  usePositions: () => ({
    items: [
      { nodeNum: 1, sourceId: 'a', latitude: 30, longitude: -90, timestamp: 0 },
      { nodeNum: 2, sourceId: 'a', latitude: 31, longitude: -91, timestamp: 0 },
    ],
    isLoading: false,
    progress: { percent: 100, loaded: 2, estimatedTotal: 2 },
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
}));

describe('SnrOverlayLayer', () => {
  beforeEach(() => localStorage.clear());

  it('renders one CircleMarker per position', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <SnrOverlayLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('snr-dot')).toHaveLength(2);
  });

  it('excludes positions outside the time slider window when slider is enabled', () => {
    localStorage.setItem(
      'mapAnalysis.config.v1',
      JSON.stringify({
        version: 1,
        layers: {
          markers: { enabled: false, lookbackHours: null },
          traceroutes: { enabled: false, lookbackHours: 24 },
          neighbors: { enabled: false, lookbackHours: 24 },
          heatmap: { enabled: false, lookbackHours: 24 },
          trails: { enabled: false, lookbackHours: 24 },
          hopShading: { enabled: false, lookbackHours: null },
          snrOverlay: { enabled: true, lookbackHours: 24 },
        },
        sources: [],
        // Window [10, 20] excludes the mock positions at timestamp 0
        timeSlider: { enabled: true, windowStartMs: 10, windowEndMs: 20 },
        inspectorOpen: true,
      }),
    );
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <SnrOverlayLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryAllByTestId('snr-dot')).toHaveLength(0);
  });
});
