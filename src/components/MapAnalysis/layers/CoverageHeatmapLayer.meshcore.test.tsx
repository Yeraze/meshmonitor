/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';

vi.mock('react-leaflet', () => ({
  // zoom >= 13: the layer uses raw positions
  useMap: () => ({ addLayer: vi.fn(), removeLayer: vi.fn(), getZoom: () => 14 }),
}));
vi.mock('leaflet.heat', () => ({}));
vi.mock('leaflet', () => {
  const heatLayer = vi.fn(() => ({ addTo: vi.fn() }));
  return { default: { heatLayer }, heatLayer };
});
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useCoverageGrid: () => ({ data: undefined, isLoading: false }),
  usePositions: () => ({
    items: [
      // Same synthetic nodeNum, same spot: a Meshtastic and a MeshCore node are two heat points.
      { nodeNum: 1, nodeKey: 'mt:1', sourceId: 'a', latitude: 30, longitude: -90, timestamp: 1 },
      { nodeNum: 1, nodeKey: 'mc:ab', sourceId: 'a', latitude: 30, longitude: -90, timestamp: 1 },
      // repeat of the MeshCore fix: collapsed
      { nodeNum: 1, nodeKey: 'mc:ab', sourceId: 'a', latitude: 30, longitude: -90, timestamp: 2 },
    ],
    isLoading: false,
    progress: { percent: 100, loaded: 3, estimatedTotal: 3 },
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

describe('CoverageHeatmapLayer with MeshCore rows', () => {
  it('dedups per nodeKey, not synthetic nodeNum', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MapAnalysisProvider>
          <CoverageHeatmapLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    const heat = (L as unknown as { heatLayer: ReturnType<typeof vi.fn> }).heatLayer;
    expect(heat).toHaveBeenCalled();
    expect(heat.mock.calls[0][0]).toHaveLength(2);
  });
});
