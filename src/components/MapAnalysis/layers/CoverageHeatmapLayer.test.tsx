/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';

vi.mock('react-leaflet', () => ({
  useMap: () => ({ addLayer: vi.fn(), removeLayer: vi.fn(), getZoom: () => 12 }),
}));
vi.mock('leaflet.heat', () => ({}));

vi.mock('leaflet', () => {
  const heatLayer = vi.fn(() => ({ addTo: vi.fn() }));
  return {
    default: { heatLayer },
    heatLayer,
  };
});

vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useCoverageGrid: () => ({
    data: { cells: [{ centerLat: 30, centerLon: -90, count: 5 }], binSizeDeg: 0.01 },
    isLoading: false,
  }),
  usePositions: () => ({
    items: [],
    isLoading: false,
    progress: { percent: 100, loaded: 0, estimatedTotal: 0 },
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
}));

import L from 'leaflet';
import CoverageHeatmapLayer from './CoverageHeatmapLayer';

beforeEach(() => {
  (L as unknown as { heatLayer: ReturnType<typeof vi.fn> }).heatLayer.mockClear();
  localStorage.setItem(
    'mapAnalysis.config.v1',
    JSON.stringify({
      version: 1,
      layers: {
        markers: { enabled: false, lookbackHours: null },
        traceroutes: { enabled: false, lookbackHours: 24 },
        neighbors: { enabled: false, lookbackHours: 24 },
        heatmap: { enabled: true, lookbackHours: 24 },
        trails: { enabled: false, lookbackHours: 24 },
        hopShading: { enabled: false, lookbackHours: null },
        snrOverlay: { enabled: false, lookbackHours: 24 },
      },
      sources: [],
      timeSlider: { enabled: false },
      inspectorOpen: true,
    }),
  );
});

describe('CoverageHeatmapLayer', () => {
  it('attaches a heat layer to the map when enabled with grid data', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <CoverageHeatmapLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(
      (L as unknown as { heatLayer: ReturnType<typeof vi.fn> }).heatLayer,
    ).toHaveBeenCalled();
  });
});
