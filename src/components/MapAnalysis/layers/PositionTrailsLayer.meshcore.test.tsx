/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import PositionTrailsLayer from './PositionTrailsLayer';


vi.mock('react-leaflet', () => ({
  Polyline: (p: { pathOptions?: { opacity?: number; color?: string } }) => (
    <div data-testid="poly" data-opacity={p.pathOptions?.opacity} data-color={p.pathOptions?.color} />
  ),
  CircleMarker: () => <div data-testid="dot" />,
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  usePositions: () => ({
    items: [
      // Meshtastic node 1 and a MeshCore node whose synthetic nodeNum is also 1.
      { nodeNum: 1, nodeKey: 'mt:1', sourceId: 'a', latitude: 30, longitude: -90, timestamp: 1 },
      { nodeNum: 1, nodeKey: 'mt:1', sourceId: 'a', latitude: 30.1, longitude: -90.1, timestamp: 2 },
      { nodeNum: 1, nodeKey: 'mc:', publicKey: '', sourceId: 'a', latitude: 40, longitude: -80, timestamp: 1 },
      { nodeNum: 1, nodeKey: 'mc:', publicKey: '', sourceId: 'a', latitude: 40.1, longitude: -80.1, timestamp: 2 },
      // current-fix union repeated a history row: identical ts + coords
      { nodeNum: 1, nodeKey: 'mc:', publicKey: '', sourceId: 'a', latitude: 40.1, longitude: -80.1, timestamp: 2 },
      // a node whose only two rows are the same fix: not a trail
      { nodeNum: 9, nodeKey: 'mc:cd', sourceId: 'a', latitude: 5, longitude: 5, timestamp: 7 },
      { nodeNum: 9, nodeKey: 'mc:cd', sourceId: 'a', latitude: 5, longitude: 5, timestamp: 7 },
    ],
    isLoading: false,
    progress: { loaded: 7, estimatedTotal: 7, percent: 100 },
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
}));

function config(selectedNodeIds: string[]) {
  localStorage.setItem('mapAnalysis.config.v1', JSON.stringify({
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
  timeSlider: { enabled: false },
  inspectorOpen: true, selectedNodeIds,
}));
}

function renderLayer() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MapAnalysisProvider>
        <PositionTrailsLayer />
      </MapAnalysisProvider>
    </QueryClientProvider>,
  );
}

describe('PositionTrailsLayer with MeshCore rows', () => {
  beforeEach(() => localStorage.clear());

  it('keeps a MeshCore trail apart from a Meshtastic node sharing the synthetic nodeNum, and dedups a repeated fix', () => {
    config([]);
    renderLayer();
    // two trails (mt:1 and mc:PK), outline + colored each; mc:cd collapses to one point
    expect(screen.getAllByTestId('poly')).toHaveLength(4);
    // 2 + 2 distinct fixes (the duplicate row is dropped)
    expect(screen.getAllByTestId('dot')).toHaveLength(4);
  });

  it('emphasis follows nodeKey, not nodeNum', () => {
    config(['mc:']);
    renderLayer();
    const colored = screen.getAllByTestId('poly').filter((p) => p.getAttribute('data-color') !== 'rgba(0,0,0,0.4)');
    expect(colored.map((p) => Number(p.getAttribute('data-opacity'))).sort()).toEqual([0.7 * 0.3, 0.7].sort());
  });
});
